import { query as claudeQuery } from '@anthropic-ai/claude-agent-sdk';

import type { Provider } from '../config.ts';
import { providerCredentials, type Credentials } from './credentials.ts';
import { createOpenAiEngine } from './openaiEngine.ts';

/**
 * How a run reaches a model.
 *
 * This is the one seam. The SDK's `query` is already an injected dependency on the
 * stage runner, the chat runner and the warm pool — each takes `query`/`run` and
 * defaults it to the SDK's own — so a second engine plugs in at the three places
 * they are built and nowhere else. Everything above this line still deals in tickets,
 * stages, guards and outcomes, and still knows nothing about which model answered.
 */
export type Engine = typeof claudeQuery;

/**
 * Which model service a workbench talks to. The words are chosen in `config.ts`, where
 * they are configuration and not a dependency on the SDK; what each one means in
 * practice:
 *
 * `claude` — the shipped path. The Claude Code CLI behind the SDK, with every tool and
 * every skill the CLI has, and sessions that survive a restart.
 *
 * `openai` — the Chat Completions wire, which is the dialect most everything else also
 * speaks: OpenAI itself (the Codex models among them), Ollama, LM Studio, llama.cpp's
 * server, vLLM, OpenRouter. It carries its own small tool loop, because there is no
 * CLI here to hand the work to. See `openaiEngine.ts`.
 *
 * `anthropic-gateway` — stays on the shipped path and only moves where it points, for a
 * gateway in front of a different model that answers the Anthropic wire instead (LiteLLM
 * and claude-code-router both do). It costs no new code, which is why it exists: it is
 * the way to reach a new model with the full Claude tool set while the native engine
 * catches up on whatever that model turns out to need.
 */
export type { Provider };

export type EngineSettings = {
  provider: Provider;
  /**
   * Where the service is, for the two providers that are not Claude's own service.
   * Empty means the provider's default.
   */
  baseUrl: string;
  /**
   * The secret, already read from the environment. Held here rather than read at
   * call time so there is one place that says which variable won, and so nothing
   * logs it: `describe()` names the variable, never the value.
   */
  apiKey: string;
  /**
   * Claude's model names, as `agents/*.md` still spell them, to the name this
   * provider answers to. Absent is passed through unchanged, so a project that has
   * already rewritten its agent files needs no map at all.
   */
  models: Record<string, string>;
  /**
   * USD per million tokens, `[in, out]`, per model. Cost is what `maxBudgetUsd` and
   * the board's spend limits are measured against, and a service that reports no
   * price leaves those ceilings inert — so a price here is what keeps the money
   * rails live on a model that quotes nothing.
   */
  prices: Record<string, [number, number]>;
  /**
   * Whether to send `reasoning_effort`. Off by default: the OpenAI API takes it and
   * several local servers answer 400 for it, and a stage that will not start is
   * worse than a stage that thinks no harder than the model's own default.
   */
  reasoning: boolean;
};

/** What `engineSettings` is allowed to read, so a test can hand over its own world. */
export type EngineFileSettings = {
  provider?: Provider;
  baseUrl?: string;
  models?: Record<string, string>;
  prices?: Record<string, [number, number]>;
  reasoning?: boolean;
};

const DEFAULT_BASE_URL: Record<Exclude<Provider, 'claude'>, string> = {
  openai: 'https://api.openai.com/v1',
  'anthropic-gateway': 'http://127.0.0.1:4000',
};

/**
 * The engine to run with, from the workbench's own file and the environment.
 *
 * The file is the ordinary place to say it — it is per project, and the board shows
 * it — and the environment overrides it, for the same reason `WB_RUNNER` does: the
 * person trying a model for an afternoon should not have to edit a file the board
 * also writes to, and a value in a shell must beat a value left in a repository.
 */
export function engineSettings(
  file: EngineFileSettings = {},
  env: NodeJS.ProcessEnv = process.env,
): EngineSettings {
  const provider = (env['WB_PROVIDER'] ?? file.provider ?? 'claude') as Provider;

  return {
    provider,
    baseUrl:
      (env['WB_BASE_URL'] ?? '').trim() !== ''
        ? (env['WB_BASE_URL'] as string).trim()
        : (file.baseUrl ?? '').trim() !== ''
          ? (file.baseUrl as string).trim()
          : (DEFAULT_BASE_URL[provider as Exclude<Provider, 'claude'>] ?? ''),
    // `OPENAI_API_KEY` is read because every tool on this machine already puts the
    // key there, and making somebody copy it into a second variable is how an
    // afternoon of trying a model turns into an afternoon of debugging one.
    apiKey:
      (env['WB_API_KEY'] ?? env['OPENAI_API_KEY'] ?? '').trim() === ''
        ? ''
        : ((env['WB_API_KEY'] ?? env['OPENAI_API_KEY']) as string).trim(),
    models: { ...(file.models ?? {}), ...pairs(env['WB_MODELS']) },
    prices: { ...(file.prices ?? {}), ...pricePairs(env['WB_PRICES']) },
    reasoning:
      env['WB_REASONING'] === undefined
        ? (file.reasoning ?? false)
        : env['WB_REASONING'] === '1' || env['WB_REASONING'] === 'on',
  };
}

/**
 * The model to actually ask for.
 *
 * `WB_MODEL` overrides everything, which is the quickest way to compare two models on
 * the same ticket: one variable, and every stage runs on the model you named.
 */
export function modelFor(settings: EngineSettings, asked: string): string {
  const forced = (process.env['WB_MODEL'] ?? '').trim();
  if (forced !== '') return forced;
  return settings.models[asked] ?? asked;
}

/** What a completion cost, in USD, or 0 when nothing is known about its price. */
export function costFor(
  settings: EngineSettings,
  model: string,
  usage: { input: number; output: number },
): number {
  const price = settings.prices[model];
  if (price === undefined) return 0;
  return (usage.input * price[0] + usage.output * price[1]) / 1_000_000;
}

/**
 * The engine itself. `protectedPaths` and `pluginRoot` go only to the engines that
 * execute tools for themselves; the Claude path needs neither, because the CLI is
 * told both when the stage builds its own options.
 */
export function engineFor(
  settings: EngineSettings,
  ctx: { protectedPaths: readonly string[]; pluginRoot: string },
): Engine {
  if (settings.provider === 'openai') {
    return createOpenAiEngine({ settings, ...ctx });
  }

  if (settings.provider === 'anthropic-gateway') {
    // The same CLI, pointed somewhere else. `ANTHROPIC_BASE_URL` is what the CLI
    // reads, and the env a stage is handed is copied rather than replaced so a
    // gateway in front of a subscription token keeps working the way a direct call
    // does.
    return (params) =>
      claudeQuery({
        ...params,
        options: {
          ...params.options,
          env: {
            ...params.options?.env,
            ...(settings.baseUrl === '' ? {} : { ANTHROPIC_BASE_URL: settings.baseUrl }),
            ...(settings.apiKey === '' ? {} : { ANTHROPIC_AUTH_TOKEN: settings.apiKey }),
          },
        },
      });
  }

  return claudeQuery;
}

/**
 * The engine, in the words the board and `wb auth` say. Names the variable a key came
 * from and never the key, because this string is stored in the ticket record and shown
 * on screen.
 */
export function describeEngine(settings: EngineSettings): string {
  if (settings.provider === 'claude') return 'Claude, through the Claude Code CLI';
  const where = settings.baseUrl === '' ? 'the default service' : settings.baseUrl;
  const key = settings.apiKey === '' ? 'no key' : keyName(settings);
  return `${settings.provider} at ${where} (${key})`;
}

/** Which variable the key came from. The value never leaves `settings`. */
function keyName(settings: EngineSettings): string {
  return (process.env['WB_API_KEY'] ?? '').trim() !== '' ? 'WB_API_KEY' : 'OPENAI_API_KEY';
}

/**
 * Proves a non-Claude credential works, the way `wb auth` proves a Claude one does: by
 * spending a very small amount of money on the cheapest question there is.
 *
 * This is not done on `wb serve`. A key that is present, well-formed and refused is
 * indistinguishable from a working one until something is asked of it, and the moment
 * that costs a whole stage is the worst possible moment to find out.
 */
export async function verifyEngine(settings: EngineSettings): Promise<Credentials> {
  const found = providerCredentials({
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
  });
  if (!found.ok) return found;

  const model =
    (process.env['WB_MODEL'] ?? '').trim() !== ''
      ? (process.env['WB_MODEL'] as string).trim()
      : (Object.values(settings.models)[0] ?? 'gpt-4o-mini');

  try {
    const response = await fetch(`${settings.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(settings.apiKey === '' ? {} : { authorization: `Bearer ${settings.apiKey}` }),
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
        max_tokens: 64,
        stream: false,
      }),
    });
    if (response.ok) return found;

    const said = (await response.text()).slice(0, 300);
    return {
      ok: false,
      why: `${settings.provider} at ${settings.baseUrl} refused the key: ${response.status} ${said}`,
      fix: [
        'The key is there and the service will not take it. Check the model name too:',
        'a server that does not know the model answers the same way a bad key does.',
        '',
        '  WB_MODEL=<name>          ask for one thing everywhere.',
        '  WB_MODELS="a=b,c=d"      map the names in agents/*.md onto real ones.',
        '',
        `What ${settings.baseUrl} has is usually at ${settings.baseUrl}/models.`,
      ].join('\n'),
    };
  } catch (error) {
    return {
      ok: false,
      why: `could not reach ${settings.baseUrl}: ${error instanceof Error ? error.message : String(error)}`,
      fix: [
        'Nothing answered at that address. Is the server running, and is the port right?',
        '',
        '  WB_BASE_URL=http://127.0.0.1:11434/v1   Ollama',
        '  WB_BASE_URL=http://127.0.0.1:1234/v1    LM Studio',
        '  WB_BASE_URL=http://127.0.0.1:8000/v1    vLLM, llama.cpp’s server',
      ].join('\n'),
    };
  }
}

/** `a=b,c=d` into a record. Semicolons work too, because either is typed by hand. */
function pairs(raw: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of (raw ?? '').split(/[,;]/)) {
    const at = item.indexOf('=');
    if (at <= 0) continue;
    const key = item.slice(0, at).trim();
    const value = item.slice(at + 1).trim();
    if (key !== '' && value !== '') out[key] = value;
  }
  return out;
}

/** `gpt-5-codex=1.25/10` into `{ 'gpt-5-codex': [1.25, 10] }`. */
function pricePairs(raw: string | undefined): Record<string, [number, number]> {
  const out: Record<string, [number, number]> = {};
  for (const [model, value] of Object.entries(pairs(raw))) {
    const [inPrice, outPrice] = value.split('/').map((n) => Number(n.trim()));
    if (inPrice === undefined || outPrice === undefined) continue;
    if (!Number.isFinite(inPrice) || !Number.isFinite(outPrice)) continue;
    out[model] = [inPrice, outPrice];
  }
  return out;
}
