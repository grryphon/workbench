import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Refreshed } from '../domain/events.ts';
import type { Workspace } from '../orchestrator/loop.ts';
import { RemoteMoved } from '../orchestrator/describe.ts';

const run = promisify(execFile);

/**
 * Git as the orchestrator's workspace: a branch and a worktree per ticket. The
 * only place that knows the loop's `Workspace` is answered with git, which is
 * what makes the loop itself free of it.
 */
export function gitWorkspace(cfg: GitConfig): Workspace {
  return {
    prepare: (ticketId, from, on) => create(cfg, ticketId, from, on),
    refresh: (ticketId, alsoMerge, keepConflict, on) =>
      refresh(cfg, ticketId, alsoMerge, keepConflict, on),
    unresolved: (ticketId, paths) => unresolved(cfg, ticketId, paths),
    abandonMerge: (ticketId) => abandonMerge(cfg, ticketId),
    removedFromBase: (ticketId, from, on) => removedFromBase(cfg, ticketId, from, on),
    commit: (ticket, message) => commitAll(worktreeFor(cfg, ticket.id), message),
    discard: (ticketId) => remove(cfg, ticketId),
  };
}

export type GitConfig = {
  /** The repository the work happens in. */
  repoRoot: string;
  /** Where worktrees are put. One directory per ticket. */
  worktreeRoot: string;
  /** The branch new work starts from. */
  base: string;
  /**
   * Directories left out of every ticket worktree — the workbench's own source.
   * They stay in the branch and in commits; they are simply not on disk for an
   * agent to reach. Defence by absence rather than by rule.
   */
  protectedPaths?: readonly string[];
};

export type Worktree = {
  ticketId: string;
  branch: string;
  path: string;
  /**
   * Somewhere to put working-out: a probe test, a scratch clone, a file written
   * only to see what happens. Beside the worktree rather than inside it, because
   * only the worktree is committed — so nothing left here can reach a pull
   * request, however forgetful the agent that made it.
   */
  scratch: string;
};

/** A worktree, plus what it was cut from the first time it was made. */
export type Branched = Worktree & { base: string | null };

export function worktreeFor(cfg: GitConfig, ticketId: string): Worktree {
  return {
    ticketId,
    branch: `wb/${ticketId}`,
    path: path.join(cfg.worktreeRoot, ticketId),
    scratch: path.join(cfg.worktreeRoot, `${ticketId}.scratch`),
  };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/**
 * What is in flight against each repository, keyed by its root. Cleared when the
 * chain drains, so a repository nobody is working in holds nothing.
 */
const repoLocks = new Map<string, Promise<unknown>>();

/**
 * Runs `fn` with nothing else from this process touching the same repository.
 *
 * Git does not serialise writes to `.git/config` or `.git/worktrees` for you: two
 * `worktree add` calls at once and one of them finds `config.lock` already held,
 * which is how a ticket ended up with a branch created, its upstream stanza half
 * written and no worktree. The orchestrator starts tickets in parallel, so this is
 * ordinary rather than rare. Keyed by root, so tickets in different repositories
 * still run at the same time.
 */
async function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>): Promise<T> {
  const mine = (repoLocks.get(repoRoot) ?? Promise.resolve()).then(fn);
  // The chain waits on a promise that cannot reject, so one caller's failure does
  // not take the next waiter down with it.
  const settled = mine.catch(() => {});
  repoLocks.set(repoRoot, settled);
  try {
    return await mine;
  } finally {
    await settled;
    if (repoLocks.get(repoRoot) === settled) repoLocks.delete(repoRoot);
  }
}

/** What git says when it lost a lock rather than failed at the thing itself. */
const CONTENDED = /could not lock config file|File exists|Unable to create.*\.lock/i;

const LOCK_ATTEMPTS = 5;
const LOCK_BACKOFF = 100;

/**
 * Runs `fn` again, briefly, when it lost a lock to something outside this process —
 * an agent session running its own worktree add, a second workbench, the manager at
 * a terminal. The in-process lock cannot see those, and a held lock clears in
 * milliseconds, so waiting is the whole fix. Anything else is rethrown untouched on
 * the first attempt, so a real failure still reaches the ticket as itself.
 *
 * A whole step rather than a single command, because losing the lock is not a clean
 * no-op: `worktree add -b` that dies writing the upstream stanza has already made
 * the branch, so running the same command again says `a branch named 'wb/t4'
 * already exists`. What has to be retried is the decision as well as the act.
 */
async function retryContended<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? '');
      if (attempt >= LOCK_ATTEMPTS || !CONTENDED.test(stderr)) throw error;
      await new Promise((resolve) => setTimeout(resolve, LOCK_BACKOFF * attempt));
    }
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * One worktree and one branch per ticket, so concurrent tickets cannot collide
 * and the manager's own working tree is never touched.
 *
 * Idempotent: calling it for a ticket that already has a worktree returns the
 * existing one, so a restart mid-ticket picks up where it left off.
 */
export async function create(
  cfg: GitConfig,
  ticketId: string,
  /**
   * The branch to cut this ticket from, when it carries on from another one.
   * Absent means the base as the remote has it, which is where work normally
   * starts. This is what puts an earlier ticket's commits inside the new
   * worktree, where they can be read and edited without any exception to the
   * guard: the whole reason work that stopped is otherwise unreachable.
   */
  from?: string,
  /**
   * The branch that stands in for the base, for a ticket on one the workbench does not
   * own: cut from it as the remote has it, the same way an ordinary ticket is cut from
   * the base.
   */
  on?: string,
): Promise<Branched> {
  const wt = worktreeFor(cfg, ticketId);
  // Every call, not only the first: a stage that runs after a restart finds the
  // worktree already there and would otherwise have nowhere to work.
  await fs.mkdir(wt.scratch, { recursive: true });
  if (await exists(wt.path)) return { ...wt, base: null };

  await fs.mkdir(cfg.worktreeRoot, { recursive: true });

  // Under the lock from the branch check onwards, so reading whether the branch is
  // there and acting on it are one step. `startPoint`'s fetch is inside it too,
  // which means parallel first-time tickets each wait a fetch — seconds, and the
  // price of the check and the add being atomic.
  return withRepoLock(cfg.repoRoot, async () => {
    // The branch check is inside the retry, not before it: an attempt that lost the
    // lock leaves the branch it just made, and the second time round that is a branch
    // to check out rather than one to cut.
    const base = await retryContended(async () => {
      const branchExists = await git(cfg.repoRoot, 'branch', '--list', wt.branch).then(
        (out) => out.trim() !== '',
      );
      if (branchExists) {
        await git(cfg.repoRoot, 'worktree', 'add', wt.path, wt.branch);
        return null;
      }
      const startFrom = from ?? (await startPoint(cfg, on));
      const cut = (await git(cfg.repoRoot, 'rev-parse', startFrom)).trim();
      await git(cfg.repoRoot, 'worktree', 'add', '-b', wt.branch, wt.path, startFrom);
      return cut;
    });

    // Inside the lock too: `sparse-checkout init` sets `extensions.worktreeConfig`
    // in the shared `.git/config`, which is the same file being contended for.
    await retryContended(() => hideProtectedPaths(cfg, wt));
    return { ...wt, base };
  });
}

/**
 * Where a new ticket branches from: the base as the remote has it, fetched first.
 *
 * Local `main` goes stale the moment a pull request is merged on the code host,
 * and a ticket branched from it works against code that no longer exists — the
 * first live one asked why the files it was told to delete were not there, and it
 * was right to. Fetching and branching from `origin/<base>` fixes that without
 * touching the manager's own `main`: no pull, no merge, nothing to conflict.
 *
 * Falls back to the local base when there is no remote, so a repository without
 * one still works.
 *
 * `branch` is the base for a ticket on somebody else's branch — `Ticket.on` — which is
 * cut from, refreshed against and measured from that branch exactly as any other
 * ticket is from the base.
 */
async function startPoint(cfg: GitConfig, branch = cfg.base): Promise<string> {
  try {
    await git(cfg.repoRoot, 'fetch', '--quiet', 'origin', branch);
    const remote = `origin/${branch}`;
    await git(cfg.repoRoot, 'rev-parse', '--verify', '--quiet', `${remote}^{commit}`);
    return remote;
  } catch {
    return branch;
  }
}

/**
 * Whether the remote has this branch. Asked when a ticket is written on one, so a
 * typo is refused then rather than found by the first stage that tries to cut it.
 */
export async function branchOnRemote(cfg: GitConfig, branch: string): Promise<boolean> {
  try {
    await git(cfg.repoRoot, 'fetch', '--quiet', 'origin', branch);
    await git(cfg.repoRoot, 'rev-parse', '--verify', '--quiet', `origin/${branch}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether a commit is in a branch's history as the remote now has it. After a merge
 * commit it is; after a squash — or a rebase — the same content is there under commits
 * this one is not an ancestor of, and it is not.
 */
export async function inHistoryOf(
  cfg: GitConfig,
  commit: string,
  branch: string,
): Promise<boolean> {
  await git(cfg.repoRoot, 'fetch', '--quiet', 'origin', branch);
  try {
    await git(cfg.repoRoot, 'merge-base', '--is-ancestor', commit, `origin/${branch}`);
    return true;
  } catch (error) {
    // 1 is git's "no"; anything else is git unable to answer, which is not a squash.
    if ((error as { code?: unknown }).code === 1) return false;
    throw error;
  }
}

/**
 * Pushes a ticket's work to a branch the workbench does not own, as a fast-forward and
 * as nothing else: no force flag, no plus-sign refspec. That branch is somebody's, often under
 * a pull request they are reading, and overwriting what they pushed is never the fix.
 *
 * @returns the commit pushed.
 * @throws RemoteMoved when the branch has commits this one has not taken in — the
 *   caller's to answer by refreshing and pushing again.
 */
export async function push(cfg: GitConfig, ticketId: string, to: string): Promise<string> {
  const wt = worktreeFor(cfg, ticketId);
  try {
    await git(wt.path, 'push', 'origin', `HEAD:refs/heads/${to}`);
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    if (/non-fast-forward|fetch first/i.test(stderr)) throw new RemoteMoved(to);
    throw error;
  }
  return (await git(wt.path, 'rev-parse', 'HEAD')).trim();
}

/**
 * Excludes the protected directories from this worktree using sparse checkout.
 * The files remain in the index and in anything committed from here — they are
 * only absent from disk, which is what puts them beyond every tool at once.
 */
async function hideProtectedPaths(cfg: GitConfig, wt: Worktree): Promise<void> {
  const paths = cfg.protectedPaths ?? [];
  if (paths.length === 0) return;

  await git(wt.path, 'sparse-checkout', 'init', '--no-cone');
  // No trailing slash: in gitignore syntax `foo/` is a directory and `foo` is either,
  // and a protected path is not always one — the repository root's `package.json`
  // names the workbench that governs the next ticket, so an agent must not write it.
  const patterns = ['/*', ...paths.map((p) => `!/${p.replace(/^\/+|\/+$/g, '')}`)];
  await git(wt.path, 'sparse-checkout', 'set', ...patterns);
}

/**
 * Removes the worktree directory and the scratch beside it. The branch is left
 * alone — it may be in a pull request.
 */
export async function remove(cfg: GitConfig, ticketId: string): Promise<void> {
  const wt = worktreeFor(cfg, ticketId);
  await fs.rm(wt.scratch, { recursive: true, force: true });
  if (!(await exists(wt.path))) return;
  // Writes `.git/worktrees` like an add does, so it takes the same turn.
  await withRepoLock(cfg.repoRoot, () =>
    retryContended(() => git(cfg.repoRoot, 'worktree', 'remove', wt.path, '--force')),
  );
}

/**
 * Returns the commit it made, or null when there was nothing to commit — which is
 * normal for the stages that only read. The sha is the ticket's record of what it
 * actually did, so it is returned rather than thrown away.
 */
export async function commitAll(wt: Worktree, message: string): Promise<string | null> {
  await git(wt.path, 'add', '-A');
  const staged = await git(wt.path, 'diff', '--cached', '--name-only');
  // A merge handed to a stage is concluded even when it staged nothing, which happens
  // whenever the resolution came out as our side and the base's only change was in the
  // conflicted file. Returning null there would leave `MERGE_HEAD` set and the base
  // uncommitted, and the ticket would carry on believing it had taken it in.
  const merging = await git(wt.path, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD').then(
    (out) => out.trim() !== '',
    () => false,
  );
  if (staged.trim() === '' && !merging) return null;
  await git(wt.path, 'commit', '-m', message);
  return (await git(wt.path, 'rev-parse', 'HEAD')).trim();
}

/**
 * The change this ticket has made, against everything the branch stood on.
 *
 * Not one commit, because no one commit is it. A ticket holds its recorded base
 * where it was whenever it is carrying work that is offered and so in no commit
 * of the base — and a held base goes stale the moment the base moves, so every
 * stage was handed main's advance as this ticket's own work. On three tickets in
 * one project the reviewer read files main had added as the ticket's, asked for
 * them to be untracked, and got it: a dependency reverted on four branches.
 *
 * So what a stage is shown is `HEAD` against `stoodOn` — the recorded base, the
 * base as it now is, and every carried branch, merged into one synthetic commit.
 * Falls back to `${from}...HEAD` when that cannot be built, and to the configured
 * base for tickets branched before `from` was recorded at all.
 *
 * Not raw git output: what comes back has been cut down to a size the model it is
 * put in front of can afford to read. See `readable`.
 */
export async function diff(
  cfg: GitConfig,
  wt: Worktree,
  from?: string | null,
  /** The branches this ticket is carrying — `Ticket.carrying`. */
  carrying: readonly string[] = [],
): Promise<string> {
  if (from === undefined || from === null) {
    return readable(await git(wt.path, 'diff', `${cfg.base}...HEAD`));
  }
  const stood = await stoodOn(cfg, wt, from, carrying);
  if (stood === null) return readable(await git(wt.path, 'diff', `${from}...HEAD`));
  // Two-dot: three-dot against a synthetic merge would resolve to one of its
  // parents and hand back the other side as the ticket's work.
  return readable(await git(wt.path, 'diff', stood, 'HEAD'));
}

/**
 * A commit with the tree the branch would have if it had done nothing of its own:
 * the recorded base, the base as it now is, and each carried branch, merged.
 *
 * Every input is first clipped to HEAD with `merge-base`, so none of them can
 * contain something HEAD has not got — otherwise the newest work on main, which
 * this branch has not merged yet, would come back out of the diff as this ticket
 * deleting it.
 *
 * The merge is pairwise: `merge-tree --write-tree` gives a tree, and `commit-tree`
 * wraps it so the next round still has a merge base to find. Nothing is written to
 * any worktree and the commit is unreferenced, so git collects it. Identity is
 * given inline because an unconfigured machine must not be what fails.
 *
 * Returns null on a conflict, an unresolvable ref, or a git too old for
 * `--write-tree` — all of which mean the caller should measure the old way.
 */
async function stoodOn(
  cfg: GitConfig,
  wt: Worktree,
  from: string,
  carrying: readonly string[],
): Promise<string | null> {
  try {
    const clipped: string[] = [];
    for (const ref of [from, await startPoint(cfg), ...carrying]) {
      const at = (await git(wt.path, 'merge-base', 'HEAD', ref)).trim();
      if (at !== '' && !clipped.includes(at)) clipped.push(at);
    }
    let acc = clipped[0];
    if (acc === undefined) return null;
    for (const ref of clipped.slice(1)) {
      // `merge-tree` exits non-zero on a conflict, so getting here at all means the
      // tree it printed is a clean merge.
      const tree = (await git(wt.path, 'merge-tree', '--write-tree', acc, ref)).trim();
      acc = (
        await git(
          wt.path,
          '-c',
          'user.name=workbench',
          '-c',
          'user.email=workbench@localhost',
          'commit-tree',
          tree,
          '-p',
          acc,
          '-p',
          ref,
          '-m',
          'what the branch stood on',
        )
      ).trim();
    }
    return acc;
  } catch {
    return null;
  }
}

/**
 * What one file's hunks may take up before the diff carries its stat line instead.
 *
 * Not a preference, so not a setting: it is a fact about what a model can afford
 * to read. 32 KB is thousands of tokens of ordinary source and several times that
 * of anything denser, which is already more of one file than a reviewer reads
 * closely. Changes people write by hand do not reach it; the things that do are
 * generated, and are the reason this exists.
 */
const FILE_BUDGET = 32 * 1024;

/**
 * And what the whole diff may take up, once every file is inside `FILE_BUDGET`.
 * Four files at the per-file cap, or a great many small ones — either way it is
 * about as much diff as a stage can read in one prompt and still have money left
 * to think with.
 */
const DIFF_BUDGET = 128 * 1024;

/**
 * The change, cut down to what the model reading it can afford.
 *
 * A ticket committed a generated 924 KB CSV — 15,862 rows of node coordinates.
 * The change itself was one function and two tests and was correctly graded
 * small, so review ran on a small ticket's budget and spent all of it on the
 * first request, 28 seconds in, after two cheap tool calls and before it had
 * read anything. The size of a change and the size of its diff are uncorrelated
 * and always will be, so no better judgement of scale prevents this. The only
 * place it can be fixed is where the diff is built.
 *
 * Two caps, because there are two ways to be too big. A file over `FILE_BUDGET`
 * keeps its header and loses its hunks, whatever else is in the diff — the same
 * file elides the same way in every ticket, rather than depending on what
 * happened to change alongside it. Then, if the whole is still over
 * `DIFF_BUDGET` — three hundred files of a mechanical rename, no single one of
 * them large — the largest go the same way, biggest first, because that buys the
 * most room for the fewest files lost. The floor is one stat line per file: a
 * diff of thousands of files will still exceed the cap, and is still the shortest
 * true account of itself.
 *
 * Nothing is hidden, only moved: every file is still named, with its mode, its
 * counts and its rename, and both stages that are given a diff can `Read` any of
 * it out of the worktree. Saying so in the note is the whole point — an elision
 * the reader does not know about is a diff it will quietly misread, which is a
 * worse failure than the cost this saves.
 *
 * Safe to do at all because nothing parses this string. It has one producer and
 * one consumer, which fences it into a brief; it is only ever read by a model.
 */
function readable(whole: string): string {
  const files = byFile(whole).map((full) => {
    const stat = statOnly(full);
    return { stat, shown: full.length > FILE_BUDGET ? stat : full };
  });
  if (files.length === 0) return whole;

  let total = files.reduce((n, file) => n + file.shown.length, 0);
  for (const file of [...files].sort((a, b) => b.shown.length - a.shown.length)) {
    if (total <= DIFF_BUDGET) break;
    // Already elided, or a file with no body to take out. Either way it cannot
    // give up anything more, and the next-largest is where the room has to come
    // from — so this is a `continue` and not a `break`.
    if (file.stat.length >= file.shown.length) continue;
    total -= file.shown.length - file.stat.length;
    file.shown = file.stat;
  }

  return files.map((file) => file.shown).join('');
}

/**
 * The diff, split into one string per file, each still exactly as git wrote it.
 *
 * `diff --git` at column zero is only ever a header: every line of a hunk carries
 * a prefix, so a file whose contents contain that text appears as `+diff --git`.
 * If there are no headers, or anything before the first one, this is not the
 * shape assumed here — return nothing and let the caller pass the diff through
 * untouched, because a wrong guess about the shape would drop real work.
 */
function byFile(whole: string): string[] {
  const starts = [...whole.matchAll(/^diff --git .*$/gm)].map((match) => match.index);
  if (starts.length === 0 || starts[0] !== 0) return [];
  return starts.map((start, i) => whole.slice(start, starts[i + 1]));
}

/**
 * One file with its hunks taken out: the header git wrote, then a line saying how
 * much was left out and a note to the model about to read it.
 *
 * The header is kept verbatim rather than rebuilt, so a rename, a mode change or
 * a new file still says what it says. The counts are taken from the hunks being
 * dropped rather than from a second `git diff --numstat`, which keeps this a pure
 * function of the text and cannot disagree with what it replaced.
 */
function statOnly(file: string): string {
  const lines = file.split('\n');
  const firstHunk = lines.findIndex((line) => line.startsWith('@@'));
  // No hunks at all: a mode change, or a binary file git already declined to
  // render. There is nothing to take out and it is already short.
  if (firstHunk === -1) return file;

  const hunks = lines.slice(firstHunk);
  const added = hunks.filter((line) => line.startsWith('+')).length;
  const removed = hunks.filter((line) => line.startsWith('-')).length;
  const kb = Math.round(file.length / 1024);

  return [
    ...lines.slice(0, firstHunk),
    `${pathOf(lines)} | ${added} added, ${removed} removed, ${kb} KB`,
    'The body of this file is not shown. This change is larger than a stage can',
    'afford to read in one go, so the largest files were reduced to the line',
    'above. None of it is lost: the file is there in the worktree, and Read will',
    'fetch as much of it as you decide you need to judge this change.',
    '',
  ].join('\n');
}

/**
 * Which file that was. Taken from the `+++` line git has already written, and
 * from `---` when the file was deleted and there is no `+++` path to take: those
 * two name it the same way the `diff --git` line does, with one prefix to strip
 * and no second name on the line to tell it apart from.
 */
function pathOf(lines: readonly string[]): string {
  const to = lines.find((line) => line.startsWith('+++ '))?.slice(4);
  const from = lines.find((line) => line.startsWith('--- '))?.slice(4);
  const named = to !== undefined && to !== '/dev/null' ? to : from;
  return named === undefined ? 'this file' : named.replace(/^[ab]\//, '');
}

/**
 * Brings the base as the remote now has it into the ticket's branch, and with it
 * any other branch the caller names.
 *
 * A branch is cut from the base once and then works for hours while other tickets
 * merge, so by the time it is offered it is built on a base that no longer exists.
 * That is where conflicts come from, and the answer is not to resolve them better
 * but to not go stale: pull the base in, and let the ticket's own checks say
 * whether it still works against it.
 *
 * A merge rather than a rebase. Rebasing means force-pushing a branch that may
 * already have a pull request on it, which rewrites every commit a standing review
 * was written against.
 *
 * They are merged one at a time and one may fail, so this does not leave the branch
 * either fully merged or as it was: everything before the failure stands. What it
 * returns says which, so the caller can record where the branch has actually got to.
 */
export async function refresh(
  cfg: GitConfig,
  ticketId: string,
  /**
   * Branches to bring in as well as the base: the work this ticket waited for,
   * which has been offered and so is not in the base yet. The commit it needs —
   * the base with all of them on it — does not exist anywhere, so it is made here,
   * on the ticket's own branch.
   */
  alsoMerge: readonly string[] = [],
  /**
   * Leave a conflicted merge where it is rather than undoing it, so the stage
   * about to run can finish it. Off by default, because at ship time there is
   * nobody left to resolve it and an untouched branch is the kinder answer.
   */
  keepConflict = false,
  /**
   * The branch that stands in for the base, for a ticket on one the workbench does not
   * own. Taken in from the remote exactly as the base is, so a push back to it is a
   * fast-forward, and a clash with it is work like a clash with the base.
   */
  on?: string,
): Promise<Refreshed> {
  const wt = worktreeFor(cfg, ticketId);

  // A merge already going, left by a run that was handed one and stopped before it
  // finished — it asked a question, or ran out of turns. `git merge` on top of that
  // fails, and the failure reads exactly like a merge that could not start, so it
  // used to be tidied away with `merge --abort`: the resolution and every
  // uncommitted edit of that run gone, and nothing recorded to say so. The same
  // merge is handed over again instead, and it is that merge the caller is told
  // about — the base it is against, not the one it would have started today.
  const merging = (
    await git(wt.path, 'rev-parse', '--verify', '--quiet', 'MERGE_HEAD').catch(() => '')
  ).trim();
  if (merging !== '') {
    return {
      kind: 'conflicted',
      base: merging,
      paths: await unmergedPaths(wt),
      merging: true,
      // Nothing was brought in this time round: the merge on disk is the one that
      // stopped, and the branch is standing where the run that was handed it left it.
      with: merging,
      merged: [],
      commit: (await git(wt.path, 'rev-parse', 'HEAD')).trim(),
    };
  }

  const base = (await git(wt.path, 'rev-parse', await startPoint(cfg, on))).trim();

  const wanted: string[] = [];
  for (const ref of [base, ...alsoMerge]) {
    // A dependency with no branch has no work to take: it was released by ending
    // rather than by offering, or it never got as far as cutting one.
    const resolves = await git(wt.path, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`).then(
      () => true,
      () => false,
    );
    const has =
      resolves &&
      (await git(wt.path, 'merge-base', '--is-ancestor', ref, 'HEAD').then(
        () => true,
        () => false,
      ));
    if (resolves && !has) wanted.push(ref);
  }
  if (wanted.length === 0) return { kind: 'up-to-date' };

  const merged: string[] = [];
  for (const ref of wanted) {
    try {
      await git(wt.path, 'merge', '--no-edit', ref);
    } catch {
      // Read the conflicting paths before anything is undone: an abort is what
      // removes them.
      const paths = await unmergedPaths(wt);
      // Nothing unmerged means the merge failed rather than conflicted — an index
      // that was busy, a checkout that could not be written. There is nothing for a
      // stage to resolve, so it is undone whatever the caller asked for.
      let kept = keepConflict && paths.length > 0;
      if (!kept) await git(wt.path, 'merge', '--abort').catch(() => {});
      // Hiding the protected paths rewrites the index, which is the one thing git may
      // refuse to do while the index is unmerged. Neither the workbench's own source on
      // disk nor a throw is an acceptable answer: a throw here parks the ticket around a
      // `MERGE_HEAD` that no stage can abort any more. So the merge goes instead.
      try {
        await hideProtectedPaths(cfg, wt);
      } catch (error) {
        if (!kept) throw error;
        await git(wt.path, 'merge', '--abort').catch(() => {});
        await hideProtectedPaths(cfg, wt);
        kept = false;
      }
      // The HEAD the earlier merges left, which a merge kept on disk has not moved
      // either. Read here rather than assumed: what the caller records against the
      // branch has to be a commit the branch is actually standing on.
      const commit = (await git(wt.path, 'rev-parse', 'HEAD')).trim();
      return { kind: 'conflicted', base, paths, with: ref, merged, commit, merging: kept };
    }
    merged.push(ref);
  }

  // A merge writes out whatever it had to merge, which can put a protected path
  // back on disk that the sparse checkout was keeping off it. Re-applied here so
  // the workbench's own source cannot appear in a worktree by way of a merge.
  await hideProtectedPaths(cfg, wt);
  return {
    kind: 'merged',
    base,
    commit: (await git(wt.path, 'rev-parse', 'HEAD')).trim(),
    merged,
  };
}

/** The paths a merge left with both sides in them, waiting on someone to decide. */
async function unmergedPaths(wt: Worktree): Promise<string[]> {
  return git(wt.path, 'diff', '--name-only', '--diff-filter=U').then(
    (out) => out.split('\n').filter((line) => line !== ''),
    () => [],
  );
}

/**
 * Undoes a merge left in the worktree, putting the branch back where it stood
 * before it: the attempt to settle it did not land, and what the manager is asked
 * about is the work as it was offered. Whatever the attempt wrote over the files it
 * was given goes with it, which is the point — nothing half-resolved is left where
 * the next commit would pick it up.
 *
 * The abort is best-effort, as it is everywhere else here: there may be no merge
 * left to undo. Hiding the protected paths again because an abort rewrites the
 * tree, and can put one of them back on disk.
 */
export async function abandonMerge(cfg: GitConfig, ticketId: string): Promise<void> {
  const wt = worktreeFor(cfg, ticketId);
  await git(wt.path, 'merge', '--abort').catch(() => {});
  await hideProtectedPaths(cfg, wt);
}

/**
 * Of the paths a stage was handed to resolve, the ones it did not: still unmerged
 * in the index, or still holding the markers git wrote into them.
 *
 * Both halves are needed. A stage that edits a file without staging it leaves the
 * index unmerged; one that stages the file with the markers still in it leaves the
 * index clean and the work unusable. Scoped to the paths that were handed over, so
 * a marker that a test fixture has always contained cannot fail a stage.
 */
export async function unresolved(
  cfg: GitConfig,
  ticketId: string,
  paths: readonly string[],
): Promise<string[]> {
  const wt = worktreeFor(cfg, ticketId);
  const unmerged = new Set(await unmergedPaths(wt));

  const left: string[] = [];
  for (const p of paths) {
    if (unmerged.has(p) || (await hasMarkers(path.join(wt.path, p)))) left.push(p);
  }
  return left;
}

/**
 * Of the paths this branch deletes relative to the base, the ones the base itself
 * added while the branch was being built. A ticket that never mentioned a file has
 * no business deleting one the base has just gained — four branches in a row
 * reverted the same dependency before anybody read the diff that way.
 *
 * `from` is what the ticket's change is measured against, which for a ticket
 * holding its base is the commit it was cut from rather than the merge-base: it is
 * exactly those tickets this is for. The merge-base stands in when it is not given
 * or does not resolve here, and a revision that resolves neither way returns
 * nothing — a commit this worktree has never heard of must not invent a block.
 */
export async function removedFromBase(
  cfg: GitConfig,
  ticketId: string,
  from?: string,
  /** The branch standing in for the base, for a ticket on one it does not own. */
  on?: string,
): Promise<string[]> {
  const wt = worktreeFor(cfg, ticketId);
  const base = (await git(wt.path, 'rev-parse', await startPoint(cfg, on))).trim();

  // Only a base the branch already has can be asked this. The base is resolved
  // here a second time, with its own fetch, and it can differ from the one the
  // refresh just merged: another ticket's merge moves `origin/<base>` while this
  // one is being offered, and a fetch that failed there can succeed here. Then
  // every file the newer base has and this branch has not merged yet reads as a
  // deletion — and as an addition on the base's side too — and the ticket is
  // blocked naming files it never touched. There is nothing to say until the
  // branch has the base; the next pass, after a refresh that brings it in, says it.
  const has = await git(wt.path, 'merge-base', '--is-ancestor', base, 'HEAD').then(
    () => true,
    () => false,
  );
  if (!has) return [];

  const anchor =
    (from === undefined
      ? ''
      : await commitOr(wt, 'rev-parse', '--verify', '--quiet', `${from}^{commit}`)) ||
    (await commitOr(wt, 'merge-base', base, 'HEAD'));
  if (anchor === '') return [];

  // What the base added is measured on the base's own side of the fork —
  // `anchor...base`, never `anchor base`. A ticket carrying on from one that
  // deleted a file is anchored on a commit without it, and a two-dot diff would
  // read that file as one the base had just added: the branch inherits the
  // deletion, so it lands in `gone` too, and the ticket is told to put back what
  // the earlier one took out. Where the anchor is an ancestor of the base, which
  // is the ordinary ticket, the two diffs are the same one.
  //
  // `--no-renames` on both sides. A rename of a file the base added is a deletion
  // of the path the base added, and letting git fold the two into an `R` would hide
  // the one case this exists for.
  const names = (out: string) => out.split('\n').filter((line) => line !== '');
  const added = new Set(
    names(
      await git(
        wt.path,
        'diff',
        '--no-renames',
        '--diff-filter=A',
        '--name-only',
        `${anchor}...${base}`,
      ),
    ),
  );
  const gone = names(
    await git(wt.path, 'diff', '--no-renames', '--diff-filter=D', '--name-only', base, 'HEAD'),
  );
  return gone.filter((p) => added.has(p)).sort();
}

/** The commit a revision-producing git command names, or '' when it names none. */
async function commitOr(wt: Worktree, ...args: string[]): Promise<string> {
  return git(wt.path, ...args).then(
    (out) => out.trim(),
    () => '',
  );
}

/**
 * Written as counts rather than as the markers themselves: a source file holding
 * one would be a file git could not merge, and this one is merged like any other.
 * A path that cannot be read was resolved by deleting it, which is a resolution.
 */
async function hasMarkers(file: string): Promise<boolean> {
  const text = await fs.readFile(file, 'utf8').catch(() => '');
  return /^<{7} /m.test(text) || /^>{7} /m.test(text);
}
