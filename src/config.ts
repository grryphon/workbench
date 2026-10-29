import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the workbench's own code lives, which is not where its work lives. Only what
 * ships with it resolves from here — the default agents, the built board, the Python
 * helper. Everything belonging to a project resolves from that project, or the
 * workbench could not be installed anywhere but inside the one repository it works on.
 */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The file that says a workbench works here. Its directory is the home. */
export const CONFIG_FILE = 'workbench.config.json';

/**
 * Which model service a workbench talks to.
 *
 * Said here rather than in `run/engine.ts` so that this file stays free of the agent
 * SDK — the same reason `agents/load.ts` reads the tool names out of `tools/names.ts`
 * instead of importing them: a config file should not drag in the thing it configures.
 *
 * `claude` is the shipped path. `openai` speaks the Chat Completions wire, which is
 * what OpenAI (Codex included) and the local servers — Ollama, LM Studio, llama.cpp,
 * vLLM — all answer. `anthropic-gateway` keeps the shipped CLI and only moves where it
 * points, for a gateway in front of something else that answers the Anthropic wire.
 */
export type Provider = 'claude' | 'openai' | 'anthropic-gateway';

export type Config = {
  /** The repository work happens in. */
  repoRoot: string;
  /**
   * Where the workbench keeps everything it has for that repository: the database,
   * the worktrees, the project's skills, and any agent it has been given its own
   * version of. A directory inside the repository, and never written to by an agent.
   */
  home: string;
  /** Where per-ticket worktrees are created. */
  worktreeRoot: string;
  /** The branch new work starts from, and pull requests target. */
  base: string;
  /** Commands the verify stage must run and report on. */
  checks: string[];
  /**
   * A file describing the project, relative to the repository root, put in front of
   * every stage. Facts that do not change between tickets — what this repository is,
   * where things live, how it is run — cost a stage several tool calls each time it
   * rediscovers them. Verify went hunting for CI configuration that does not exist.
   *
   * Omitted from the brief if the file is not there. Nothing is invented.
   */
  about: string;
  /**
   * Directories agents may read but never write, and which are left out of ticket
   * worktrees entirely. Relative to the repository root. The home is always one of
   * them, worked out rather than configured: a workbench an agent could write to is
   * one that can rewrite its own instructions mid-ticket.
   */
  protectedPaths: string[];
  dbPath: string;
  /**
   * Where to look for `<stage>.md`, nearest first: the project's own agents, then the
   * ones that ship with the workbench. Resolved per file rather than per directory, so
   * a project that rewrites `plan.md` keeps receiving the other three.
   */
  agentDirs: string[];
  /**
   * Loaded as a local plugin, which is what puts skills in front of an agent without
   * loading anything from the project's own Claude configuration. The home, so the
   * skills are the project's — how a repository says what good looks like for work of
   * a kind is not something the workbench can ship. A stage loads a copy of it rather
   * than the directory, because the worktrees are inside it (see `pluginCopy`).
   */
  pluginRoot: string;
  /** How often to ask the code host whether a pull request has a verdict. */
  pollMs: number;
  /** The port `wb serve` listens on, and every other command talks to. */
  port: number;
  /**
   * "claude" calls the model service and costs money. "fake" runs a scripted
   * agent that makes no external calls — for trying the workbench out.
   */
  runner: 'claude' | 'fake';
  /**
   * Which model service the stages talk to. Absent is `claude`, exactly as shipped, so
   * nothing about a project that says nothing here changes.
   *
   * The environment wins over these, as it does over `runner`: the person trying a
   * different model for an afternoon should not have to edit a file the board also
   * writes to. `WB_PROVIDER` takes `claude`, `openai` or `anthropic-gateway`;
   * `WB_BASE_URL` and `WB_API_KEY` say where it is and how to reach it (`OPENAI_API_KEY`
   * is read too, and a server on this machine needs no key at all); `WB_MODELS` maps the
   * names in `agents/*.md` onto the ones that service answers to, and `WB_MODEL` overrides
   * them all with one; `WB_PRICES` is `model=in/out` per million tokens, which is what
   * keeps the money ceilings live on a service that reports no cost; `WB_REASONING` sends
   * `reasoning_effort`, off by default because several local servers refuse it.
   */
  provider?: Provider;
  /** Where that service is. Empty means the provider's own default. */
  baseUrl?: string;
  /**
   * Claude's model names, as `agents/*.md` still spell them, to the names this service
   * answers to. Absent is passed through, so a project that has already rewritten its
   * agent files needs no map here at all.
   */
  models?: Record<string, string>;
  /**
   * USD per million tokens, `[in, out]`, per model. A service that quotes nothing
   * reports no cost, and `maxBudgetUsd` cannot bound a number nobody knows — so this
   * is what keeps the money rails live on a model that does not price itself.
   */
  prices?: Record<string, [number, number]>;
  /** Whether to send `reasoning_effort`. Off by default: several local servers 400 on it. */
  reasoning?: boolean;
};

/**
 * Where a home may sit relative to a directory: in it, or in `.workbench` within it.
 * Both are searched at every level on the way up, so `wb` answers the same from
 * anywhere in a project — and so a workbench that predates `wb init`, living in a
 * directory of its own name, is found where it already is.
 */
const HOME_DIRS = ['.', '.workbench'];

/**
 * The workbench governing `from`, if there is one. `WB_HOME` settles it outright, for
 * a layout neither shape covers.
 *
 * Absent is not an error here. `wb init` is answering exactly that, and `wb auth` has
 * to work before there is anything to configure.
 */
export function findHome(from: string = process.cwd()): string | undefined {
  const named = process.env['WB_HOME'];
  if (named !== undefined && named !== '') return path.resolve(named);

  let dir = path.resolve(from);
  for (;;) {
    for (const candidate of HOME_DIRS) {
      const home = path.resolve(dir, candidate);
      if (fs.existsSync(path.join(home, CONFIG_FILE))) return home;
    }
    const up = path.dirname(dir);
    if (up === dir) return undefined;
    dir = up;
  }
}

const DEFAULTS = {
  base: 'main',
  checks: [] as string[],
  about: 'claude.md',
  pollMs: 30_000,
  port: 4600,
  runner: 'claude' as const,
};

/**
 * The home's own file, over the defaults, with every path resolved against the home
 * rather than against the workbench's code. A relative path in that file means what a
 * reader of it would expect: somewhere in their project.
 */
export function loadConfig(home: string): Config {
  const overrides = JSON.parse(
    fs.readFileSync(path.join(home, CONFIG_FILE), 'utf8'),
  ) as Partial<Config>;

  const repoRoot = path.resolve(home, overrides.repoRoot ?? '..');

  return withEnv({
    ...DEFAULTS,
    ...overrides,
    home,
    repoRoot,
    worktreeRoot: path.resolve(home, overrides.worktreeRoot ?? '.worktrees'),
    dbPath: path.resolve(home, overrides.dbPath ?? 'data/workbench.db'),
    pluginRoot: path.resolve(home, overrides.pluginRoot ?? '.'),
    agentDirs: unique([path.join(home, 'agents'), path.join(PACKAGE_ROOT, 'agents')]),
    protectedPaths: unique([path.relative(repoRoot, home), ...(overrides.protectedPaths ?? [])]),
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** WB_RUNNER=fake is the quickest way to try the workbench without spending anything. */
function withEnv(config: Config): Config {
  const runner = process.env['WB_RUNNER'];
  if (runner === 'fake' || runner === 'claude') config.runner = runner;
  return config;
}
