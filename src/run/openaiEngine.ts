import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import type {
  HookCallbackMatcher,
  Options,
  Query,
  SDKMessage,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';

import { costFor, modelFor, type EngineSettings } from './engine.ts';
import {
  openAiTools,
  runOpenAiTool,
  type ToolDefinition,
  type ToolExecContext,
} from './openaiTools.ts';

/**
 * A stage, a chat or a one-shot question, answered by anything that speaks the OpenAI
 * Chat Completions wire — OpenAI itself (the Codex models among them), Ollama, LM
 * Studio, llama.cpp's server, vLLM, OpenRouter.
 *
 * It is written as the SDK's own `query`, because that is the seam the stage runner,
 * the chat runner and the warm pool already inject: they hand over a prompt and the
 * options they have already assembled, and read back `system/init`, `assistant` and
 * `result`. Nothing above this file changed to accommodate it, and nothing above it can
 * tell which engine answered. That is what keeps this small — the state machine, the
 * guard, the protocol the stages write in, the money ceilings and the
 * resume-or-start-again logic are all still the ones that shipped.
 *
 * What it does not have is Claude Code. No subagents, no plugins, no ToolSearch, no
 * session files in `~/.claude/projects`, no file checkpointing. The tools are the plain
 * ones in `openaiTools.ts`, under the same names and behind the same guard.
 */

/** One message on the wire. */
type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: WireToolCall[];
  tool_call_id?: string;
};

type WireToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type Usage = { input: number; output: number };

/** What one completion came back with. */
type Completion = { text: string; toolCalls: WireToolCall[]; usage: Usage };

/** What one turn produced, and how it ended. */
type TurnOutcome = { text: string; stopped?: string };

/** A conversation this engine can carry on. Held in memory, never on disk. */
type Session = { id: string; messages: ChatMessage[]; paid: number };

/** How many conversations are kept for a resume. */
const KEEP_SESSIONS = 64;

/** A busy service is asked twice more before the run is given up on. */
const RETRIES = 2;

export type OpenAiEngineDeps = {
  settings: EngineSettings;
  /** Passed to the tools' own guard re-ask, the way a stage passes it to the hook. */
  protectedPaths: readonly string[];
  /** Where the workbench's skills are, so `Skill` can read one off disk. */
  pluginRoot: string;
};

export function createOpenAiEngine(deps: OpenAiEngineDeps) {
  const sessions = new Map<string, Session>();

  return function openAiQuery(params: {
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Options;
  }): Query {
    const options = params.options ?? {};
    const session =
      options.resume === undefined
        ? hold(sessions, { id: randomUUID(), messages: [], paid: 0 })
        : remember(sessions, options.resume);

    /** Set by an interrupt, which ends the turn in flight and nothing after it. */
    const state = { interrupted: false };

    // Only `interrupt` is ever called on this by the workbench — a stage asking the
    // manager something stops that way — so the rest of the control surface answers
    // that it did the thing rather than throwing at a caller that will not care.
    return Object.assign(turns(params.prompt, options, session, state, deps), {
      interrupt: async () => {
        state.interrupted = true;
        return undefined;
      },
      setPermissionMode: async () => {},
      setModel: async () => {},
      setMaxThinkingTokens: async () => {},
      initializationResult: async () => ({}),
    }) as unknown as Query;
  };
}

/**
 * The generator: one `result` per thing the caller says. The caller may say several —
 * a live chat feeds one process turn after turn, which is the difference between a chat
 * that costs an answer a turn and one that costs an answer plus a boot.
 */
async function* turns(
  prompt: string | AsyncIterable<SDKUserMessage>,
  options: Options,
  session: Session,
  state: { interrupted: boolean },
  deps: OpenAiEngineDeps,
): AsyncGenerator<SDKMessage, void> {
  const cwd = options.cwd ?? process.cwd();
  const granted = (options.allowedTools ?? []).filter(
    (tool) => !(options.disallowedTools ?? []).includes(tool),
  );
  const skills = options.skills === 'all' || options.skills === undefined ? [] : options.skills;
  const tools = openAiTools(granted);
  const ctx: ToolExecContext = {
    worktree: cwd,
    scratch: scratchFor(cwd),
    pluginRoot: deps.pluginRoot,
    skills,
  };
  const model = modelFor(deps.settings, options.model ?? '');

  let announced = false;

  for await (const said of inputs(prompt)) {
    if (!announced) {
      announced = true;
      yield initMessage(session, options, model, skills, granted, deps);
    }

    session.messages.push({ role: 'user', content: said });

    const outcome = await oneTurn({ model, tools, ctx, options, session, state, granted, deps });

    if (outcome.text !== '') {
      yield {
        type: 'assistant',
        session_id: session.id,
        message: { role: 'assistant', content: [{ type: 'text', text: outcome.text }] },
      } as unknown as SDKMessage;
    }

    yield resultMessage(session, outcome) as unknown as SDKMessage;
  }
}

/** Ask, run whatever tools the model asked for, ask again, until it has nothing to ask. */
async function oneTurn(args: {
  model: string;
  tools: ToolDefinition[];
  ctx: ToolExecContext;
  options: Options;
  session: Session;
  state: { interrupted: boolean };
  granted: string[];
  deps: OpenAiEngineDeps;
}): Promise<TurnOutcome> {
  const { model, tools, ctx, options, session, state, granted, deps } = args;
  const maxTurns = options.maxTurns ?? 30;
  const budget = options.maxBudgetUsd;
  const signal = options.abortController?.signal;

  let text = '';
  let stopped: string | undefined;
  /** The model said the last thing it had to say, as opposed to running out of room. */
  let finished = false;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (aborted(signal) || state.interrupted) break;

    const completion = await complete({
      deps,
      model,
      messages: session.messages,
      tools,
      options,
      signal,
    });

    session.paid += costFor(deps.settings, model, completion.usage);
    if (completion.text !== '') text = completion.text;

    // The money rail, checked before anything else about the answer and before the
    // tools it asked for are run: a ceiling reached is a reason to stop, not a reason
    // to spend one more turn finding out whether the model was finished anyway.
    //
    // And only where a price is known. A model nobody has priced reports no cost, and
    // reading that zero as a number would stop every stage on a local model the moment
    // it asked for anything.
    if (
      budget !== undefined &&
      deps.settings.prices[model] !== undefined &&
      session.paid >= budget
    ) {
      stopped = 'error_max_budget_usd';
      break;
    }

    if (completion.toolCalls.length === 0) {
      finished = true;
      break;
    }

    session.messages.push({
      role: 'assistant',
      content: completion.text === '' ? null : completion.text,
      tool_calls: completion.toolCalls,
    });

    for (const call of completion.toolCalls) {
      const input = parseArguments(call.function.arguments);
      const refusal = await askPermission(options, call.function.name, input, granted);

      if (refusal !== undefined) {
        session.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: `refused: ${refusal}`,
        });
        // The hook that refused is the hook that took the manager's question and asked
        // for the run to stop. Nothing else ends a turn from inside a tool call.
        if (state.interrupted) break;
        continue;
      }

      if (call.function.name === 'AskUserQuestion') {
        // Nothing was asked of the filesystem. The hook has the question, and the
        // interrupt it issued is why this turn is over.
        state.interrupted = true;
        break;
      }

      const answer = await runOpenAiTool(ctx, call.function.name, input);
      session.messages.push({ role: 'tool', tool_call_id: call.id, content: answer.text });
    }

    if (state.interrupted) break;
  }

  if (stopped === undefined && !finished && !state.interrupted && !aborted(signal)) {
    // Out of turns with the model still asking for things. Said the way the SDK says
    // it, so the stage runner's existing handling of a stopped run handles this one
    // too — and an empty answer that the model actually chose to give stays a success,
    // which is what it is.
    stopped = 'error_max_turns';
  }

  return { text, stopped };
}

/**
 * One call to `/chat/completions`.
 *
 * Not streamed: the workbench reads a turn's text when the turn ends, so streaming
 * would be a second way to assemble the same string for no difference the manager can
 * see. No timeout of our own either — a local model on a slow machine is exactly the
 * case this engine is for, and the caller owns the abort.
 */
async function complete(args: {
  deps: OpenAiEngineDeps;
  model: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  options: Options;
  signal?: AbortSignal;
}): Promise<Completion> {
  const { deps, model, messages, tools, options, signal } = args;
  const url = `${deps.settings.baseUrl.replace(/\/$/, '')}/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    messages: messagesWithSystem(options, messages),
    ...(tools.length === 0 ? {} : { tools: tools.map(wireTool), tool_choice: 'auto' }),
    stream: false,
  };
  if (deps.settings.reasoning && options.effort !== undefined) {
    body['reasoning_effort'] = options.effort;
  }

  let lastError = `no answer from ${url}`;

  for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
    if (aborted(signal)) throw new Error('the run was stopped');

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(deps.settings.apiKey === ''
            ? {}
            : { authorization: `Bearer ${deps.settings.apiKey}` }),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      // An abort is the manager stopping the run, which is not a failure to retry.
      if (aborted(signal)) throw new Error('the run was stopped');
      lastError = `could not reach ${url}: ${describe(error)}`;
      if (attempt < RETRIES) await backoff(attempt);
      continue;
    }

    if (response.status === 429 || response.status >= 500) {
      lastError = `${response.status} from ${url}: ${(await response.text()).slice(0, 300)}`;
      if (attempt < RETRIES) await backoff(attempt);
      continue;
    }

    if (!response.ok) {
      // A 4xx answers the same way tomorrow: a bad key, an unknown model, a rejected
      // argument. Thrown rather than returned, because the stage runner already turns a
      // throw into a failed run that still reports what it spent.
      throw new Error(`${response.status} from ${url}: ${(await response.text()).slice(0, 500)}`);
    }

    const json = (await response.json()) as {
      choices?: { message?: { content?: string; tool_calls?: WireToolCall[] } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const message = json.choices?.[0]?.message;
    return {
      text: typeof message?.content === 'string' ? message.content : '',
      toolCalls: message?.tool_calls ?? [],
      usage: {
        input: json.usage?.prompt_tokens ?? 0,
        output: json.usage?.completion_tokens ?? 0,
      },
    };
  }

  throw new Error(lastError);
}

/**
 * A tool, as the Chat Completions wire wants it.
 *
 * The spec says `{ type: 'function', function: { … } }`. OpenAI's own API lets the flat
 * form through, so an engine written against OpenAI alone never finds this out; llama.cpp
 * answers `Failed to parse tools: Missing tool type` with a 500, on the first call of
 * every stage. Wrapped at the boundary, so everywhere else in this file a tool is just a
 * tool.
 */
function wireTool(tool: ToolDefinition): { type: 'function'; function: ToolDefinition } {
  return { type: 'function', function: tool };
}

/**
 * The permission decision, taken from the hooks the caller already built.
 *
 * Those hooks *are* the workbench's guard — the same function a Claude run is confined
 * by, with the same tool lists, the same protected paths, and the same capture of a
 * question for the manager. Going through them rather than writing a second answer is
 * what makes a second engine safe: a stage that is confined on one engine cannot be
 * unconfined on the other, and an edit to the guard applies to both without anybody
 * remembering to make it twice.
 *
 * A tool no hook spoke about is checked against `allowedTools` here and otherwise
 * refused the way the CLI refuses it: a tool nobody granted never runs.
 */
async function askPermission(
  options: Options,
  tool: string,
  input: unknown,
  granted: string[],
): Promise<string | undefined> {
  for (const group of (options.hooks?.PreToolUse ?? []) as HookCallbackMatcher[]) {
    if (group.matcher !== undefined && !new RegExp(group.matcher).test(tool)) continue;

    for (const hook of group.hooks) {
      const verdict = await hook(
        {
          hook_event_name: 'PreToolUse',
          tool_name: tool,
          tool_input: input,
          session_id: '',
          transcript_path: '',
          cwd: options.cwd ?? process.cwd(),
        } as never,
        undefined,
        { signal: options.abortController?.signal ?? new AbortController().signal },
      );

      const denied = (
        verdict as {
          hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string };
        }
      )?.hookSpecificOutput;

      if (denied?.permissionDecision === 'deny')
        return denied.permissionDecisionReason ?? 'refused';
    }
  }

  return granted.includes(tool) ? undefined : `the ${tool} tool is not granted to this stage`;
}

/**
 * The scratch directory, read off the worktree beside which it lives.
 *
 * `worktreeFor` makes them `<root>/<ticket>` and `<root>/<ticket>.scratch`, so one
 * implies the other and no second path has to be threaded down through the stage
 * runner for a provider it knows nothing about. Absent is the ordinary answer for a
 * chat, which has no scratch and no business writing anything.
 */
function scratchFor(worktree: string): string | undefined {
  const beside = `${worktree}.scratch`;
  return existsSync(beside) ? beside : undefined;
}

/** The prompt, however it was handed over, as the strings to answer one at a time. */
async function* inputs(prompt: string | AsyncIterable<SDKUserMessage>): AsyncGenerator<string> {
  if (typeof prompt === 'string') {
    yield prompt;
    return;
  }

  for await (const message of prompt) {
    const content = message.message?.content;
    if (typeof content === 'string') {
      if (content !== '') yield content;
      continue;
    }
    if (Array.isArray(content)) {
      const text = content
        .map((block) =>
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: string }).type === 'text'
            ? String((block as { text?: string }).text ?? '')
            : '',
        )
        .join('');
      if (text !== '') yield text;
    }
  }
}

/** A new conversation, keeping only as many as fit. */
function hold(sessions: Map<string, Session>, one: Session): Session {
  sessions.set(one.id, one);
  if (sessions.size > KEEP_SESSIONS) {
    const oldest = sessions.keys().next();
    if (!oldest.done) sessions.delete(oldest.value);
  }
  return one;
}

/**
 * A conversation being picked back up.
 *
 * Thrown rather than answered from an empty history: a stage that resumed nothing and
 * carried on regardless would write its verdict having seen none of the work it was
 * told it was carrying on. The stage runner already reads a throw here as "that session
 * is gone" and starts the stage again from the whole brief, which is the right answer
 * and costs one attempt.
 *
 * Sessions are not kept on disk. A conversation that has to outlive a restart needs its
 * tool results summarised before it fits back into a context window, and replaying
 * every raw result from the run before would be the more expensive way to be wrong.
 * That is the gap, named; `anthropic-gateway` and `claude` both still resume across a
 * restart because the CLI keeps its own session files.
 */
function remember(sessions: Map<string, Session>, resume: string): Session {
  const held = sessions.get(resume);
  if (held !== undefined) return held;
  throw new Error(
    `no conversation ${resume} is open on this provider: sessions are held in memory, so a ` +
      'workbench that has restarted cannot pick a run back up',
  );
}

/** The message that says a run has started, and with what. */
function initMessage(
  session: Session,
  options: Options,
  model: string,
  skills: string[],
  granted: string[],
  deps: OpenAiEngineDeps,
): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    session_id: session.id,
    apiKeySource: keySource(deps.settings),
    cwd: options.cwd ?? process.cwd(),
    model,
    // What the stage is told it has. The stage runner reads this against the board's
    // own list and says what is missing, so it is answered honestly rather than with
    // whatever a Claude session would have happened to find.
    skills,
    plugins: [],
    tools: granted,
  } as unknown as SDKMessage;
}

/** How the turn ended, in the shape the stage runner and the chat already read. */
function resultMessage(session: Session, outcome: TurnOutcome): Record<string, unknown> {
  const shared = {
    type: 'result',
    session_id: session.id,
    duration_ms: 0,
    duration_api_ms: 0,
    num_turns: 1,
    // A running total, which is what the live chat reads it as: it charges each turn
    // the difference, so a second question is not billed for the first as well.
    total_cost_usd: session.paid,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage: {},
    permission_denials: [],
  };

  if (outcome.stopped !== undefined) {
    return { ...shared, subtype: outcome.stopped, is_error: true, errors: [outcome.stopped] };
  }
  return {
    ...shared,
    subtype: 'success',
    is_error: false,
    result: outcome.text,
    stop_reason: null,
  };
}

/**
 * A line about the ground it is standing on. The brief says everything else, and
 * repeating it here would be paying for the same sentence twice on every turn.
 */
function messagesWithSystem(options: Options, messages: ChatMessage[]): ChatMessage[] {
  const system = systemText(options);
  return system === undefined || system === ''
    ? messages
    : [{ role: 'system', content: system }, ...messages];
}

/** Which variable the key came from. Never the key itself: this is shown on screen. */
function keySource(settings: EngineSettings): string {
  if (settings.apiKey === '') return 'none';
  return (process.env['WB_API_KEY'] ?? '') !== '' ? 'WB_API_KEY' : 'OPENAI_API_KEY';
}

/**
 * What the caller wants said in the system role.
 *
 * A preset — `{ type: 'preset', preset: 'claude_code' }` — is Claude Code's own brief,
 * and there is no version of handing it to another provider that would be honest, so
 * the line about the working directory is said instead and the brief the workbench
 * builds carries the rest.
 */
function systemText(options: Options): string | undefined {
  const given = options.systemPrompt;
  if (Array.isArray(given)) return given.join('\n');
  if (typeof given === 'string') return given;
  if (given !== undefined) return undefined;
  return options.cwd === undefined
    ? undefined
    : `You are working in ${options.cwd}. Every path you are given is read against it, ` +
        'and nothing outside it is yours to touch.';
}

function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw === '' ? '{}' : raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // A model that wrote its arguments badly is told so by the refusal it gets back,
    // not by an exception that ends the run.
    return {};
  }
}

/**
 * Whether the caller has stopped this. A function rather than the check written out:
 * TypeScript narrows `signal.aborted` to false after one test and believes it, but an
 * abort lands from another task entirely, and every place that asks means to ask again.
 */
function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

function backoff(attempt: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
