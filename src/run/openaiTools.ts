import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { wbTools } from '../tools/server.ts';

/**
 * The tools a stage is granted, for a provider that has no CLI of its own.
 *
 * The Claude path gets these from Claude Code. A model reached over the OpenAI wire
 * has to be given them by us, and given them under the same names: the guard, the
 * `PreToolUse` hook and `agents/*.md` all speak `Read` and `mcp__wb__map`, and a tool
 * that arrived here renamed would be a call the guard refuses and a stage that loses a
 * turn finding out why.
 *
 * These are deliberately plain implementations. They are the same job — read a file,
 * make an exact edit, run a command — and the guard, not the tool, is what makes them
 * safe. Where Claude Code's own version does something this one does not, the tool
 * description says so, because an agent that believes it has a capability it has not
 * wastes a turn; an agent told the limit works around it.
 */

export type ToolExecContext = {
  /** Absolute path to the ticket's worktree. Every relative path means this. */
  worktree: string;
  /** Writable, beside the worktree, never committed. */
  scratch?: string;
  /** Where the workbench's skills live, so `Skill` can read them off disk. */
  pluginRoot: string;
  /** The skills this stage may read. The guard is what enforces this list. */
  skills: readonly string[];
};

export type ToolDefinition = {
  name: string;
  description: string;
  /** A JSON Schema, as the Chat Completions `tools` array wants it. */
  parameters: Record<string, unknown>;
};

/** What a tool answered. `error` is a refusal or a failure, said back to the model. */
export type ToolOutcome = { text: string; error?: boolean };

/** A tool the engine answers itself, rather than running here. */
const ASK = 'AskUserQuestion';

/**
 * Long enough to read a real file with, short enough that one call cannot spend the
 * whole context. Cut is said, never silent: a stage that does not know it was cut
 * writes an edit against text it has never seen.
 */
const MAX_READ = 40_000;
const MAX_SAID = 20_000;

/** Never walked, whatever the ticket asks for. */
const SKIPPED = new Set(['.git', 'node_modules', '.venv', '__pycache__', 'dist', 'build']);

/** The tools, in the order they are worth offering them. */
export function openAiTools(granted: readonly string[]): ToolDefinition[] {
  const all: ToolDefinition[] = [
    {
      name: 'Read',
      description: 'Read a file. Paths are relative to the working directory.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The file to read.' },
          offset: { type: 'number', description: 'Line to start from, 1-based.' },
          limit: { type: 'number', description: 'How many lines to return.' },
        },
        required: ['file_path'],
      },
    },
    {
      name: 'Write',
      description: 'Write a file, replacing it, creating parent directories as needed.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The file to write.' },
          content: { type: 'string', description: 'The whole new contents.' },
        },
        required: ['file_path', 'content'],
      },
    },
    {
      name: 'Edit',
      description:
        'Replace one exact string in a file with another. Fails if it is not found, or ' +
        'found more than once and replace_all is not set — so say enough of the line to ' +
        'be the only match.',
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'The file to edit.' },
          old_string: { type: 'string', description: 'The text as it is now, exactly.' },
          new_string: { type: 'string', description: 'The text to put in its place.' },
          replace_all: { type: 'boolean', description: 'Replace every occurrence.' },
        },
        required: ['file_path', 'old_string', 'new_string'],
      },
    },
    {
      name: 'Grep',
      description:
        'Search file contents by regular expression. Returns path:line:text. Skips .git, ' +
        'node_modules and build output.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'A regular expression.' },
          path: { type: 'string', description: 'A file or directory to search. Default: all.' },
          glob: { type: 'string', description: 'Only files whose name matches, e.g. "*.ts".' },
          output_mode: {
            type: 'string',
            enum: ['content', 'files_with_matches', 'count'],
            description: 'What to return. Default content.',
          },
          i: { type: 'boolean', description: 'Ignore case.' },
          head_limit: { type: 'number', description: 'Stop after this many results.' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'Glob',
      description: 'Find files by name, e.g. "src/**/*.ts". Returns paths, newest first.',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'A glob.' },
          path: { type: 'string', description: 'Where to look. Default: the working directory.' },
        },
        required: ['pattern'],
      },
    },
    {
      name: 'Bash',
      description:
        'Run a shell command in the working directory and return what it printed. You are ' +
        'not in a git repository you own: committing, pushing and changing branches are ' +
        "the workbench's, and refused.",
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to run.' },
          timeout: { type: 'number', description: 'Milliseconds to wait. Default 120000.' },
        },
        required: ['command'],
      },
    },
    {
      name: 'Skill',
      description:
        'Read one of this workbench’s skills: written expertise about how work of a kind ' +
        'is done here. Only the skills named in your brief are here.',
      parameters: {
        type: 'object',
        properties: { skill: { type: 'string', description: 'The skill’s name.' } },
        required: ['skill'],
      },
    },
    {
      name: ASK,
      description:
        'Stop and ask the manager something you cannot decide. This ends the run: you ' +
        'will be told the answer and asked to carry on.',
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: 'The questions, most important first.',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string' },
                header: { type: 'string', description: 'A short label.' },
              },
              required: ['question'],
            },
          },
        },
        required: ['questions'],
      },
    },
  ];

  // The workbench's own two tools, offered under the qualified name the guard and the
  // agent files both use. Their schemas come from the zod shapes they are declared
  // with, so a third tool added to `tools/names.ts` is offered here too rather than
  // silently missing from a non-Claude run.
  for (const t of wbToolDefinitions()) {
    if (granted.includes(t.name)) all.push(t);
  }

  return all.filter((t) => granted.includes(t.name));
}

/** `map` and `where`, as Chat Completions wants them, schemas read off the zod. */
function wbToolDefinitions(): ToolDefinition[] {
  return wbTools({ worktree: '/', protectedPaths: [] }).map((t) => ({
    name: `mcp__wb__${t.name}`,
    description: t.description ?? '',
    parameters: jsonSchema(t.inputSchema),
  }));
}

/**
 * The zod shape behind an MCP tool as a JSON Schema.
 *
 * Only what these two tools actually use — strings, some optional, each described.
 * Anything else falls back to a string rather than throwing: a stage offered no `map`
 * tool is a worse outcome than one offered a `map` tool with a loose argument.
 */
function jsonSchema(shape: unknown): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries((shape ?? {}) as Record<string, unknown>)) {
    const def = (value as { _def?: Record<string, unknown> })?._def;
    const type = String(def?.['type'] ?? def?.['typeName'] ?? 'string');
    const inner = type === 'optional' || type === 'nullable';
    const innerDef = def?.['innerType'] as { _def?: Record<string, unknown> } | undefined;
    const actual = inner ? String(innerDef?._def?.['type'] ?? 'string') : type;
    const described = (def?.['description'] as string | undefined) ?? undefined;

    properties[key] = {
      type: actual === 'number' || actual === 'integer' ? 'number' : 'string',
      ...(described === undefined ? {} : { description: described }),
    };
    if (!inner) required.push(key);
  }

  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

/**
 * Run one granted tool. Nothing here throws: a tool that cannot be done comes back as
 * an error the model reads and works around, which is what a tool call is for.
 *
 * The guard has already said yes before this is reached. What is checked again is only
 * whether the work itself went wrong.
 */
export async function runOpenAiTool(
  ctx: ToolExecContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  try {
    switch (name) {
      case 'Read':
        return await read(ctx, args);
      case 'Write':
        return await write(ctx, args);
      case 'Edit':
        return await edit(ctx, args);
      case 'Grep':
        return await grep(ctx, args);
      case 'Glob':
        return await glob(ctx, args);
      case 'Bash':
        return await bash(ctx, args);
      case 'Skill':
        return await skill(ctx, args);
      case 'mcp__wb__map':
      case 'mcp__wb__where':
        return await wb(ctx, name, args);
      default:
        return said(`the ${name} tool is not available on this provider`, true);
    }
  } catch (error) {
    return said(error instanceof Error ? error.message : String(error), true);
  }
}

/** Where a path the model named actually is. The guard has confined this already. */
function at(ctx: ToolExecContext, target: string): string {
  return path.resolve(ctx.worktree, target);
}

async function read(ctx: ToolExecContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const file = String(args['file_path'] ?? '');
  if (file === '') return said('Read needs a file_path.', true);

  const found = await fs.readFile(at(ctx, file), 'utf8').catch(() => undefined);
  if (found === undefined) return said(`no file at ${file}`, true);

  const all = found.split('\n');
  const from = Math.max(1, Number(args['offset'] ?? 1)) - 1;
  const limit = Number(args['limit'] ?? all.length);
  const lines = all.slice(from, from + (Number.isFinite(limit) ? limit : all.length));
  const text = lines.join('\n');

  return said(
    text.length > MAX_READ
      ? `${text.slice(0, MAX_READ)}\n\n… cut at ${MAX_READ} characters. Read on with offset.`
      : text,
  );
}

async function write(ctx: ToolExecContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const file = String(args['file_path'] ?? '');
  const content = String(args['content'] ?? '');
  if (file === '') return said('Write needs a file_path.', true);

  const where = at(ctx, file);
  await fs.mkdir(path.dirname(where), { recursive: true });
  await fs.writeFile(where, content, 'utf8');
  return said(`Wrote ${content.split('\n').length} lines to ${file}.`);
}

async function edit(ctx: ToolExecContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const file = String(args['file_path'] ?? '');
  const from = String(args['old_string'] ?? '');
  const to = String(args['new_string'] ?? '');
  const all = args['replace_all'] === true;

  if (file === '' || from === '') return said('Edit needs file_path and old_string.', true);
  if (from === to) return said('Edit would change nothing.', true);

  const where = at(ctx, file);
  const text = await fs.readFile(where, 'utf8').catch(() => undefined);
  if (text === undefined) return said(`no file at ${file}`, true);

  const hits = text.split(from).length - 1;
  if (hits === 0) return said(`nothing in ${file} matches that old_string exactly.`, true);
  if (hits > 1 && !all) {
    return said(
      `${file}: that text appears ${hits} times. Say more of it, or set replace_all.`,
      true,
    );
  }

  await fs.writeFile(where, all ? text.split(from).join(to) : text.replace(from, to), 'utf8');
  return said(`Edited ${file} (${all ? hits : 1} place${all && hits > 1 ? 's' : ''}).`);
}

async function grep(ctx: ToolExecContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const source = String(args['pattern'] ?? '');
  if (source === '') return said('Grep needs a pattern.', true);

  let pattern: RegExp;
  try {
    pattern = new RegExp(source, args['i'] === true ? 'i' : '');
  } catch (error) {
    return said(`that is not a regular expression: ${describe(error)}`, true);
  }

  const mode = String(args['output_mode'] ?? 'content');
  const namePattern = args['glob'] === undefined ? undefined : toRegExp(String(args['glob']));
  const limit = Number(args['head_limit'] ?? 200);

  const root = args['path'] === undefined ? ctx.worktree : at(ctx, String(args['path']));
  const out: string[] = [];
  const seen = new Set<string>();
  let matches = 0;

  for await (const file of walk(root)) {
    if (namePattern !== undefined && !namePattern.test(path.basename(file))) continue;

    const text = await fs.readFile(file, 'utf8').catch(() => undefined);
    if (text === undefined || text.includes('\u0000')) continue;

    const hits: string[] = [];
    text.split('\n').forEach((line, i) => {
      if (!pattern.test(line)) return;
      matches += 1;
      const shown = relative(ctx, file);
      if (mode === 'files_with_matches') hits.push(shown);
      else if (mode === 'count') hits.push(`${shown}: 1`);
      else hits.push(`${shown}:${i + 1}:${line}`);
    });

    if (mode === 'files_with_matches' && hits.length > 0) seen.add(hits[0] ?? '');
    else out.push(...hits);

    if (out.length + seen.size >= limit) break;
  }

  const found = mode === 'files_with_matches' ? [...seen] : out;
  if (found.length === 0) return said('No matches.');
  const cut = found.length >= matches ? '' : `\n… ${Math.max(0, matches - found.length)} more.`;
  return said(clip(found.slice(0, limit).join('\n') + cut));
}

async function glob(ctx: ToolExecContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const pattern = toRegExp(String(args['pattern'] ?? '*'));
  const root = args['path'] === undefined ? ctx.worktree : at(ctx, String(args['path']));

  const found: { file: string; mtime: number }[] = [];
  for await (const file of walk(root)) {
    if (!pattern.test(relative(ctx, file))) continue;
    const stat = await fs.stat(file).catch(() => undefined);
    found.push({ file, mtime: stat?.mtimeMs ?? 0 });
  }

  found.sort((a, b) => b.mtime - a.mtime);
  if (found.length === 0) return said('No files match.');
  return said(
    clip(
      found
        .slice(0, 200)
        .map((f) => relative(ctx, f.file))
        .join('\n'),
    ),
  );
}

async function bash(ctx: ToolExecContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const command = String(args['command'] ?? '');
  if (command === '') return said('Bash needs a command.', true);

  const ms = Number(args['timeout'] ?? 120_000);
  return new Promise<ToolOutcome>((resolve) => {
    execFile(
      'bash',
      ['-c', command],
      {
        cwd: ctx.worktree,
        timeout: Number.isFinite(ms) && ms > 0 ? ms : 120_000,
        maxBuffer: 8 * 1024 * 1024,
        // The workbench's own environment, less anything that would let a command
        // reach a model service: a stage has no business making its own calls.
        env: stripped(process.env),
      },
      (error, stdout, stderr) => {
        const said_ = [stdout, stderr].filter((s) => s !== '').join('\n');
        if (error === null) resolve(said(clip(said_ === '' ? '(no output)' : said_)));
        else
          resolve(
            said(
              `${said_ === '' ? describe(error) : said_}\nexit: ${String(
                (error as { code?: unknown }).code ?? 'non-zero',
              )}`,
              true,
            ),
          );
      },
    );
  });
}

async function skill(ctx: ToolExecContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const asked = String(args['skill'] ?? '');
  if (asked === '') return said('Skill needs a skill.', true);

  // Qualified or bare, the way the guard reads them: `workbench:naming-a-ticket` and
  // `naming-a-ticket` are the same expertise to whoever is asking.
  const wanted = asked.includes(':') ? (asked.split(':').at(-1) ?? asked) : asked;
  const file = path.join(ctx.pluginRoot, 'skills', wanted, 'SKILL.md');

  const text = await fs.readFile(file, 'utf8').catch(() => undefined);
  if (text === undefined) {
    return said(
      ctx.skills.length === 0
        ? 'this workbench has no skills'
        : `there is no skill "${asked}" here. The skills are: ${ctx.skills.join(', ')}`,
      true,
    );
  }
  return said(clip(text));
}

/** One of the workbench's own tools, through the handler it ships with. */
async function wb(
  ctx: ToolExecContext,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolOutcome> {
  const bare = name.replace('mcp__wb__', '');
  const tool = wbTools({ worktree: ctx.worktree, protectedPaths: [] }).find((t) => t.name === bare);
  if (tool === undefined) return said(`no such workbench tool: ${bare}`, true);

  // The second argument is the MCP call context, which these two tools never look at.
  const answer = (await tool.handler(args as never, {} as never)) as unknown as {
    content?: { text?: string }[];
    isError?: boolean;
  };
  const text = (answer.content ?? []).map((c) => c.text ?? '').join('\n');
  return said(text === '' ? '(nothing)' : text, answer.isError === true);
}

/** Every file under a root, skipping the directories nothing should be searched in. */
async function* walk(root: string): AsyncGenerator<string> {
  const stat = await fs.stat(root).catch(() => undefined);
  if (stat === undefined) return;
  if (stat.isFile()) {
    yield root;
    return;
  }

  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (SKIPPED.has(entry.name)) continue;
    const where = path.join(root, entry.name);
    if (entry.isDirectory()) yield* walk(where);
    else if (entry.isFile()) yield where;
  }
}

/**
 * A glob as a regular expression, against a worktree-relative path. `**` crosses
 * directories, `*` and `?` do not — which is what an agent means by them.
 */
function toRegExp(glob: string): RegExp {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i] ?? '';
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i += 1;
        if (glob[i + 1] === '/') i += 1;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) out += `\\${c}`;
    else out += c;
  }
  return new RegExp(`(^|/)${out}$`);
}

/** Credentials never reach a stage's shell. Everything else the command needs, does. */
function stripped(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (/API_KEY|AUTH_TOKEN|SECRET|PASSWORD|TOKEN$/i.test(key)) continue;
    out[key] = value;
  }
  return out;
}

function relative(ctx: ToolExecContext, file: string): string {
  return path.relative(ctx.worktree, file) || '.';
}

function clip(text: string): string {
  if (text.length <= MAX_SAID) return text;
  return `${text.slice(0, MAX_SAID)}\n\n… cut at ${MAX_SAID} characters.`;
}

function said(text: string, error = false): ToolOutcome {
  return { text, ...(error ? { error: true } : {}) };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
