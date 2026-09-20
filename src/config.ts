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
  /**
   * How long to wait for the checks the code host runs on a pull request before
   * giving up on them and parking the ticket. The merge waits for them: a repository
   * whose real test is its CI cannot use it as a gate otherwise.
   */
  checksTimeoutMinutes: number;
  /** The port `wb serve` listens on, and every other command talks to. */
  port: number;
  /**
   * "claude" calls the model service and costs money. "fake" runs a scripted
   * agent that makes no external calls — for trying the workbench out.
   */
  runner: 'claude' | 'fake';
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
  checksTimeoutMinutes: 20,
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
