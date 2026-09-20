import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { CheckRun } from '../domain/events.ts';
import type { CodeHost, MergeOutcome, Verdict } from '../orchestrator/loop.ts';
import { keepTail } from '../run/checks.ts';
import { worktreeFor, type GitConfig, type Worktree } from '../git/worktree.ts';

const run = promisify(execFile);

/**
 * GitHub as the orchestrator's code host. The only place that knows a ticket is
 * offered as a pull request, and the only place that writes what one says.
 */
export function githubHost(cfg: GitConfig & { checksTimeoutMinutes: number }): CodeHost {
  return {
    openPr: (ticket) =>
      openPr(worktreeFor(cfg, ticket.id), {
        title: ticket.title,
        body: `${ticket.body}\n\n---\nWorkbench ticket ${ticket.id}.`,
        base: cfg.base,
      }),
    verdict: async (ticket) => {
      if (!ticket.prUrl) throw new Error('no pull request to read a verdict from');
      return verdict(ticket.prUrl, cfg.repoRoot);
    },
    merge: async (ticket) => {
      if (!ticket.prUrl) throw new Error('no pull request to merge');
      return mergePr(
        worktreeFor(cfg, ticket.id),
        ticket.prUrl,
        mergeSubject(ticket.title, ticket.id),
        cfg.checksTimeoutMinutes * 60_000,
      );
    },
  };
}

/** What `gh pr view --json state,reviews,commits` gives back, as far as we care. */
export type PrState = {
  state: 'OPEN' | 'MERGED' | 'CLOSED' | string;
  reviews?: { state: string; body?: string; submittedAt?: string }[];
  commits?: { committedDate?: string }[];
};

/**
 * The manager accepts by merging and rejects by requesting changes. Translated
 * here into the workbench's own words, so nothing above this file knows what
 * GitHub calls things.
 */
export function readVerdict(pr: PrState): Verdict {
  if (pr.state === 'MERGED') return { kind: 'accepted' };

  // A change request the branch has moved past has been addressed: GitHub leaves the
  // review standing until someone looks again, but the work it objected to is gone.
  // Read as a live rejection it would send a reworked ticket round the loop the
  // moment it re-offered itself, for ever, over an objection already dealt with.
  // Dates missing either side means saying nothing, which is the standing review.
  const head = (pr.commits ?? [])
    .map((c) => c.committedDate ?? '')
    .sort()
    .at(-1);
  const standing = (r: { submittedAt?: string }) =>
    !head || !r.submittedAt || r.submittedAt >= head;

  const latestChangeRequest = [...(pr.reviews ?? [])]
    .filter((r) => r.state === 'CHANGES_REQUESTED')
    .filter(standing)
    .sort((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? ''))
    .at(-1);

  if (latestChangeRequest) {
    const body = latestChangeRequest.body?.trim();
    return { kind: 'rejected', reason: body || 'changes requested, with no comment' };
  }

  if (pr.state === 'CLOSED') {
    return { kind: 'rejected', reason: 'the pull request was closed without merging' };
  }

  return { kind: 'pending' };
}

/**
 * Pushes the branch and opens the pull request. Returns its URL.
 *
 * Offering the same branch twice is not an error, and must not be: a ticket
 * reworked after a rejection comes back here, and GitHub keeps one pull request
 * per branch. The push is what carries the rework across either way — asking
 * before creating is all that makes the second offer mean the first one again,
 * rather than `gh pr create` refusing and the ticket blocking on it.
 */
export async function openPr(
  wt: Worktree,
  opts: { title: string; body: string; base: string },
): Promise<string> {
  await run('git', ['push', '-u', 'origin', wt.branch], { cwd: wt.path });

  const existing = await prFor(wt);
  if (existing !== null) return existing;

  const { stdout } = await run(
    'gh',
    [
      'pr',
      'create',
      '--head',
      wt.branch,
      '--base',
      opts.base,
      '--title',
      opts.title,
      '--body',
      opts.body,
    ],
    { cwd: wt.path },
  );

  const url = stdout.trim().split('\n').at(-1) ?? '';
  if (!url.startsWith('http')) {
    throw new Error(`could not read a pull request URL from: ${stdout.trim()}`);
  }
  return url;
}

/**
 * The pull request to offer this branch on again, out of what `gh pr view` says
 * about the one it has. Its own function, like `mergeArgs`, so the decision can be
 * tested without a network.
 *
 * A merged one is not one to reuse. A ticket sent back to be tweaked comes through
 * here on the branch its work already merged from — reusing that pull request
 * would have the workbench record it, poll it, read `MERGED` as an acceptance and
 * mark the ticket done with the tweak never merged.
 *
 * `OPEN` and `CLOSED` are reused, and must be: a ticket reworked after an
 * objection has to come back to the pull request that objection was written on.
 */
export function reusablePr(stdout: string): string | null {
  const pr = JSON.parse(stdout) as { url?: string; state?: string };
  return pr.state === 'MERGED' ? null : (pr.url ?? null);
}

/** The pull request this branch already has, or null when it has none to reuse. */
async function prFor(wt: Worktree): Promise<string | null> {
  try {
    const { stdout } = await run('gh', ['pr', 'view', wt.branch, '--json', 'url,state'], {
      cwd: wt.path,
    });
    return reusablePr(stdout);
  } catch {
    // `gh` fails when there is no pull request to view, which is the ordinary case.
    return null;
  }
}

/**
 * How the pull request is merged. Always a merge commit: what is on the branch is
 * exactly what reaches the base, which is what every ticket cut from another one
 * assumes — see `docs/design.md`. Its own function so the flags can be tested
 * without a network.
 */
export function mergeArgs(prUrl: string, subject: string): string[] {
  return ['pr', 'merge', prUrl, '--merge', '--subject', subject];
}

/**
 * The merge commit's subject, so `git log --first-parent` reads one line per
 * ticket — the history a squash used to give, without the squash. The id alone
 * when there is no title, which is better than a bare pair of brackets.
 */
export function mergeSubject(title: string, id: string): string {
  const said = title.trim();
  return said ? `${said} (${id})` : id;
}

/**
 * Whether the repository allows merge commits, out of what
 * `gh api repos/{owner}/{repo} --jq .allow_merge_commit` prints. Its own function,
 * like `mergeArgs`, so the answer can be read without a network.
 */
export function allowsMergeCommits(stdout: string): boolean {
  return stdout.trim() !== 'false';
}

/**
 * Why the workbench will not run here, when the repository does not allow merge
 * commits — and `undefined` when it does, or when `gh` cannot answer.
 *
 * Not being able to ask is not a no: there is no remote, or no `gh`, or no network,
 * and a workbench on a repository with no GitHub at all still works. Only a
 * definite `false` stops it, because every merge would then be refused.
 */
export async function mergeCommitsRefusal(cwd: string): Promise<string | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await run('gh', ['api', 'repos/{owner}/{repo}', '--jq', '.allow_merge_commit'], {
      cwd,
    }));
  } catch {
    return undefined;
  }
  if (allowsMergeCommits(stdout)) return undefined;
  return (
    'This repository does not allow merge commits, and the workbench lands every\n' +
    'ticket with one. Turn on Settings → General → Pull requests → Allow merge\n' +
    'commits on GitHub, then run this again.'
  );
}

/** Refusals that are a decision: asking again gets the same answer. */
const SETTLED_REFUSALS = [
  'base branch policy',
  'required status',
  'review is required',
  'changes requested',
  'permission',
];

/** Refusals that mean GitHub has not caught up with the base that just moved. */
const NOT_CAUGHT_UP = [
  'not mergeable',
  'cannot be cleanly created',
  'base branch was modified',
  'try the merge again',
];

/**
 * Whether a `gh pr merge` refusal is worth asking again about.
 *
 * Merging moves the base under every other pull request, and GitHub works out
 * whether those can still be merged on its own schedule. Asked in between it says
 * no — in the same words it uses for one that genuinely cannot be merged, which is
 * why this is two lists and not a flag, and why the settled refusals are checked
 * first: GitHub words several of them as "not mergeable" too.
 *
 * A real conflict never reaches here — `doMergePr` brings the base into the branch
 * first and blocks on a clash — so retrying the ambiguous ones is bounded, and the
 * ticket still blocks after the last attempt. Its own function, like `mergeArgs`,
 * so the decision can be tested without a network.
 */
export function retryableMergeFailure(message: string): boolean {
  const said = message.toLowerCase();
  if (SETTLED_REFUSALS.some((phrase) => said.includes(phrase))) return false;
  return NOT_CAUGHT_UP.some((phrase) => said.includes(phrase));
}

/**
 * Whether the pull request has already merged, out of what `gh pr view` says about
 * it. Sibling of `reusablePr`, and the same input.
 *
 * `gh pr merge` on a merged pull request is an error, and the workbench can arrive
 * at one honestly: the merge may have landed and the answer been lost — to a retry,
 * or to `wb serve` being restarted with the request still standing.
 */
export function alreadyMerged(stdout: string): boolean {
  return (JSON.parse(stdout) as { state?: string }).state === 'MERGED';
}

/** How many times `gh pr merge` is asked, and how long is left between the asks. */
const MERGE_ATTEMPTS = 4;
const mergeBackoffMs = (attempt: number) => 3_000 * 2 ** (attempt - 1);

/** One check the host ran on the pull request, as `gh pr checks --json` gives it. */
export type Check = { name: string; bucket: string; link?: string; description?: string };

/** Buckets that are a check saying no. `skipping` is not one: it never ran. */
const FAILED_BUCKETS = ['fail', 'cancel'];

/** How often the checks are asked about, and how long a first empty answer is doubted. */
const CHECKS_POLL_MS = 30_000;
const CHECKS_GRACE_MS = 10_000;

/** What running `gh` comes to. Injected so the wait can be tested without a network. */
type Exec = (
  file: string,
  args: string[],
  opts: { cwd: string },
) => Promise<{ stdout: string; stderr: string }>;

/** What awaiting the checks came to. Passing is the only one that merges. */
type ChecksOutcome =
  { kind: 'passed'; results: CheckRun[] } | Exclude<MergeOutcome, { kind: 'merged' }>;

/**
 * The checks on a pull request, out of what `gh pr checks --json` printed. Its own
 * function, like `mergeArgs`, so the reading can be tested without a network.
 *
 * Nothing printed is no checks: `gh` says so on stderr rather than in the JSON.
 */
export function readChecks(stdout: string): Check[] {
  const said = stdout.trim();
  if (said === '') return [];
  const parsed = JSON.parse(said) as Check[];
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * The Actions run and job a check's link points at, or null when it points at
 * something else — a check can be any status a service posted, and only a job of a
 * workflow run has a log to fetch.
 */
export function jobOf(link: string | undefined): { run: string; job: string } | null {
  const found = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(link ?? '');
  return found ? { run: found[1] as string, job: found[2] as string } : null;
}

/**
 * Asks the host what its checks say.
 *
 * `gh pr checks` exits non-zero while anything is pending or failing and prints the
 * JSON anyway, so the answer is taken off the error as readily as off the success —
 * the exit code here is a summary, not a failure. A pull request with no checks is
 * an error with nothing to read, and that is not a failure either: it is the answer
 * for every repository that has no CI.
 */
async function askChecks(prUrl: string, cwd: string, exec: Exec): Promise<Check[]> {
  try {
    const { stdout } = await exec(
      'gh',
      ['pr', 'checks', prUrl, '--json', 'name,state,bucket,link,description'],
      { cwd },
    );
    return readChecks(stdout);
  } catch (error) {
    const failure = error as { stdout?: unknown; stderr?: unknown; message?: unknown };
    const printed = typeof failure.stdout === 'string' ? failure.stdout.trim() : '';
    if (printed.startsWith('[')) return readChecks(printed);
    const said = [failure.stderr, failure.message].map((s) => String(s ?? '')).join('\n');
    if (said.includes('no checks reported')) return [];
    throw error;
  }
}

/**
 * What the failing job printed, trimmed exactly as a failing local check's output
 * is: it becomes the same change list, and the whole of an Actions log is the same
 * waste of the database and of the run that reads it.
 *
 * A check that is not an Actions job has no log to fetch — an external service
 * posted a status — so what it said about itself is the next best thing.
 */
async function failedJobLog(check: Check, cwd: string, exec: Exec): Promise<string> {
  const job = jobOf(check.link);
  const said = [check.description, check.link].filter((s) => s).join('\n');
  if (job === null) return said || 'the check failed, and said nothing about why';
  try {
    const { stdout, stderr } = await exec(
      'gh',
      ['run', 'view', job.run, '--job', job.job, '--log-failed'],
      { cwd },
    );
    return keepTail(stdout, stderr) || said;
  } catch {
    // The log is the best explanation, not the only one. Being unable to fetch it
    // must not turn a failed check into a failed merge.
    return said || 'the check failed, and its log could not be read';
  }
}

/**
 * Waits for the checks the host runs on the pushed head, and says what they came to.
 *
 * The point of the wait: a repository whose real test only runs in CI — with secrets
 * a worktree does not have — has no way to gate on it otherwise, and branch
 * protection turns that into `gh pr merge` being refused for "required status",
 * which is a settled refusal and parks the ticket for a person to nudge.
 *
 * `exec`, `sleep` and `now` are injected so a test can fake `gh` and never wait.
 */
export async function awaitChecks(
  prUrl: string,
  cwd: string,
  opts: {
    timeoutMs: number;
    exec?: Exec;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<ChecksOutcome> {
  const exec = opts.exec ?? (run as Exec);
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = opts.now ?? Date.now;
  const started = now();

  for (let poll = 0; ; poll++) {
    let checks = await askChecks(prUrl, cwd, exec);

    // A workflow is not queued the instant the push lands, and a pull request read
    // in that gap looks exactly like one with no CI at all. So nothing is doubted
    // but nothing: asked once more a moment later, which is the difference between
    // waiting for the checks and merging just before they start.
    if (checks.length === 0 && poll === 0) {
      await sleep(CHECKS_GRACE_MS);
      checks = await askChecks(prUrl, cwd, exec);
    }

    const pending = checks.filter((c) => c.bucket === 'pending');
    if (pending.length === 0) {
      // Every check either way, not only the failures: what was waited for is the
      // ticket's news whichever way it went, and a failed one carries its log.
      const results: CheckRun[] = [];
      for (const check of checks) {
        const ok = !FAILED_BUCKETS.includes(check.bucket);
        results.push({
          command: check.name,
          ok,
          output: ok ? (check.description ?? '') : await failedJobLog(check, cwd, exec),
        });
      }
      return results.every((r) => r.ok)
        ? { kind: 'passed', results }
        : { kind: 'checks_failed', results };
    }

    if (now() - started >= opts.timeoutMs) {
      return { kind: 'checks_pending', pending: pending.map((c) => c.name) };
    }
    await sleep(CHECKS_POLL_MS);
  }
}

/**
 * Pushes the branch, waits for the host's checks on it, and merges the pull request.
 *
 * The push first because the branch may have gained a commit the pull request has
 * never seen: bringing the base in happens here, immediately before this, and
 * merging without it would merge the code as GitHub last saw it. The checks after
 * it, for the same reason: they are the checks on what is about to land, not on
 * whatever the head was before the push.
 *
 * Asked more than once, because `gh pr merge` asks whether the branch can be merged
 * once and never again: a base that moved a moment ago is answered no, the ticket
 * blocks, and it looks exactly like a real conflict. The state is read before the
 * first ask and after every refusal, so a merge that has already landed is finished
 * rather than asked for a second time.
 */
export async function mergePr(
  wt: Worktree,
  prUrl: string,
  subject: string,
  checksTimeoutMs: number,
): Promise<MergeOutcome> {
  if (await merged(prUrl, wt.path)) return { kind: 'merged' };

  await run('git', ['push', 'origin', wt.branch], { cwd: wt.path });

  const checks = await awaitChecks(prUrl, wt.path, { timeoutMs: checksTimeoutMs });
  if (checks.kind !== 'passed') return checks;

  for (let attempt = 1; ; attempt++) {
    try {
      await run('gh', mergeArgs(prUrl, subject), { cwd: wt.path });
      return { kind: 'merged', results: checks.results };
    } catch (error) {
      if (await merged(prUrl, wt.path)) return { kind: 'merged' };
      const message = error instanceof Error ? error.message : String(error);
      if (attempt === MERGE_ATTEMPTS || !retryableMergeFailure(message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, mergeBackoffMs(attempt)));
    }
  }
}

/**
 * Whether the pull request has merged, as the host has it. Never throws: being
 * unable to read is a blip, and what settles whether it merged is the merge.
 */
async function merged(prUrl: string, cwd: string): Promise<boolean> {
  try {
    const { stdout } = await run('gh', ['pr', 'view', prUrl, '--json', 'state'], { cwd });
    return alreadyMerged(stdout);
  } catch {
    return false;
  }
}

export async function verdict(prUrl: string, cwd: string): Promise<Verdict> {
  const { stdout } = await run('gh', ['pr', 'view', prUrl, '--json', 'state,reviews,commits'], {
    cwd,
  });
  return readVerdict(JSON.parse(stdout) as PrState);
}
