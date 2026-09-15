import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { CodeHost, Verdict } from '../orchestrator/loop.ts';
import {
  branchOnRemote,
  push as pushBranch,
  worktreeFor,
  type GitConfig,
  type Worktree,
} from '../git/worktree.ts';

const run = promisify(execFile);

/**
 * GitHub as the orchestrator's code host. The only place that knows a ticket is
 * offered as a pull request, and the only place that writes what one says.
 */
export function githubHost(cfg: GitConfig, announce: (message: string) => void): CodeHost {
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
      );
    },
    push: async (ticket) => {
      if (ticket.on === null) throw new Error('no branch of somebody else’s to push to');
      const commit = await pushBranch(cfg, ticket.id, ticket.on);
      const url = await pullRequestOn(cfg.repoRoot, ticket.on, announce);
      return url === null ? { commit } : { commit, url };
    },
    landed: async (ticket) => {
      const pushed = ticket.pushed;
      if (pushed === null || pushed.url === null) throw new Error('no pull request to watch');
      const { stdout } = await run(
        'gh',
        ['pr', 'view', pushed.url, '--json', 'state,baseRefName'],
        {
          cwd: cfg.repoRoot,
        },
      );
      const pr = JSON.parse(stdout) as { state?: string; baseRefName?: string };
      if (pr.state === 'CLOSED') return 'closed';
      if (pr.state !== 'MERGED') return 'pending';
      // Merged, and whether as itself is a question for the branch it merged into, which
      // is the base unless the pull request said otherwise. A squash — or a rebase —
      // leaves the same content there under commits the pushed one is not an ancestor of.
      const into = pr.baseRefName || cfg.base;
      await run('git', ['fetch', '--quiet', 'origin', into], { cwd: cfg.repoRoot });
      return run('git', ['merge-base', '--is-ancestor', pushed.commit, `origin/${into}`], {
        cwd: cfg.repoRoot,
      }).then(
        () => 'merged' as const,
        () => 'squashed' as const,
      );
    },
  };
}

/**
 * What marks a pull request as already carrying `SQUASH_NOTE`, so it is added once
 * however many times the branch is pushed to. A comment, so nobody reads it.
 */
const NOTE_MARK = '<!-- workbench: merge, do not squash -->';

/**
 * Said on the pull request because that is where the decision to squash is made, and
 * the workbench cannot change the settings of a repository it only runs in.
 */
const SQUASH_NOTE = [
  NOTE_MARK,
  '**Please merge this pull request rather than squashing it.** This branch carries work',
  'that other work is built on. A squash lands the same changes under a new commit, so',
  'those commits never reach the base as themselves — and everything built on them then',
  'conflicts with the base on every file they share, for no reason anyone can see.',
].join('\n');

/**
 * A pull request's description with the note against squashing on the end — or as it
 * was, when the note is already there. Its own function, like `reusablePr`, so it can
 * be tested without a network.
 */
export function withNote(body: string): string {
  if (body.includes(NOTE_MARK)) return body;
  return body.trim() === '' ? SQUASH_NOTE : `${body.trimEnd()}\n\n${SQUASH_NOTE}`;
}

/**
 * The pull request open on a branch, which picks up whatever was just pushed there, or
 * null when the branch has none — a colleague's work in progress, a release branch.
 *
 * The first time the workbench meets one it asks, on it, for a merge rather than a
 * squash. Not being able to say so is announced rather than blocking: the push has
 * landed, and the watch afterwards still notices a squash.
 */
async function pullRequestOn(
  cwd: string,
  branch: string,
  announce: (message: string) => void,
): Promise<string | null> {
  let pr: { url?: string; state?: string; body?: string };
  try {
    const { stdout } = await run('gh', ['pr', 'view', branch, '--json', 'url,state,body'], { cwd });
    pr = JSON.parse(stdout) as typeof pr;
  } catch {
    // `gh` fails when there is no pull request to view, which is an ordinary case here.
    return null;
  }
  if (pr.state !== 'OPEN' || !pr.url) return null;

  const body = pr.body ?? '';
  if (withNote(body) !== body) {
    try {
      await run('gh', ['pr', 'edit', pr.url, '--body', withNote(body)], { cwd });
    } catch (error) {
      announce(
        `⚠️  could not ask ${pr.url} to be merged rather than squashed: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  return pr.url;
}

/**
 * The branch a ticket written `on` a pull request works on, out of what
 * `gh pr view --json headRefName,isCrossRepository,state` says about it — or why it
 * cannot. Its own function, like `reusablePr`, so the decision can be tested without
 * a network.
 *
 * A fork's branch is refused: pushing there means a remote of its own, and everything
 * downstream reads `origin/`. So is a pull request that is no longer open, whose branch
 * nobody is going to merge again — name the branch itself to work on it anyway.
 */
export function readTarget(stdout: string, ref: string): { branch: string } | { error: string } {
  const pr = JSON.parse(stdout) as {
    headRefName?: string;
    isCrossRepository?: boolean;
    state?: string;
  };
  if (pr.isCrossRepository === true) {
    return { error: `${ref} is from a fork, and the workbench can only push to origin` };
  }
  if (pr.state !== 'OPEN') {
    return {
      error: `${ref} is ${(pr.state ?? 'not open').toLowerCase()}; name its branch to work on it anyway`,
    };
  }
  if (!pr.headRefName) return { error: `could not read a branch from ${ref}` };
  return { branch: pr.headRefName };
}

/**
 * What a ticket written `on` something means: a branch name as it stands, or `#123`
 * and a pull request's URL looked up through `gh`. Whichever it was, the branch has
 * to be on origin — see `ApiDeps.resolveOn`.
 */
export async function resolveOn(
  cfg: GitConfig,
  ref: string,
): Promise<{ branch: string } | { error: string }> {
  let target: { branch: string } | { error: string } = { branch: ref };
  if (/^#\d+$/.test(ref) || /^https?:\/\//.test(ref)) {
    try {
      const { stdout } = await run(
        'gh',
        ['pr', 'view', ref.replace(/^#/, ''), '--json', 'headRefName,isCrossRepository,state'],
        { cwd: cfg.repoRoot },
      );
      target = readTarget(stdout, ref);
    } catch (error) {
      return {
        error: `could not look ${ref} up: ${error instanceof Error ? error.message : error}`,
      };
    }
  }
  if ('error' in target) return target;
  if (!(await branchOnRemote(cfg, target.branch))) {
    return { error: `origin has no branch ${target.branch} to work on` };
  }
  return target;
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

/**
 * Pushes the branch and merges the pull request.
 *
 * The push first because the branch may have gained a commit the pull request has
 * never seen: bringing the base in happens here, immediately before this, and
 * merging without it would merge the code as GitHub last saw it.
 *
 * Asked more than once, because `gh pr merge` asks whether the branch can be merged
 * once and never again: a base that moved a moment ago is answered no, the ticket
 * blocks, and it looks exactly like a real conflict. The state is read before the
 * first ask and after every refusal, so a merge that has already landed is finished
 * rather than asked for a second time.
 */
export async function mergePr(wt: Worktree, prUrl: string, subject: string): Promise<void> {
  if (await merged(prUrl, wt.path)) return;

  await run('git', ['push', 'origin', wt.branch], { cwd: wt.path });

  for (let attempt = 1; ; attempt++) {
    try {
      await run('gh', mergeArgs(prUrl, subject), { cwd: wt.path });
      return;
    } catch (error) {
      if (await merged(prUrl, wt.path)) return;
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
