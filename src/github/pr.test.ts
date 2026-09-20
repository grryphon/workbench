import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import {
  allowsMergeCommits,
  alreadyMerged,
  awaitChecks,
  jobOf,
  mergeArgs,
  mergeCommitsRefusal,
  mergeSubject,
  readChecks,
  readVerdict,
  retryableMergeFailure,
  reusablePr,
} from './pr.ts';

const JOB_LINK = 'https://github.com/o/r/actions/runs/123/job/456';

/**
 * `gh` faked, one answer per call, with the calls recorded. A clock that jumps by
 * whatever was slept for, so a wait that takes twenty minutes takes none here.
 */
function fakeGh(answers: (() => { stdout: string; stderr: string })[]) {
  const calls: string[][] = [];
  let clock = 0;
  let answer = 0;
  return {
    calls,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    exec: async (_file: string, args: string[]) => {
      calls.push(args);
      // `gh run view` is asked for a log, not for the checks: it takes the answer
      // it was scripted with, wherever in the sequence it falls.
      const next = answers[Math.min(answer, answers.length - 1)] as () => {
        stdout: string;
        stderr: string;
      };
      if (args[0] !== 'run') answer++;
      return next();
    },
  };
}

const said = (stdout: string) => () => ({ stdout, stderr: '' });

const checksJson = (checks: Record<string, unknown>[]) => said(JSON.stringify(checks));

/** What `gh pr checks` does when something is pending or failing: prints, then exits 8. */
const refused = (stdout: string) => () => {
  throw Object.assign(new Error('Command failed: gh pr checks'), { stdout, stderr: '' });
};

test('a merged pull request is an acceptance', () => {
  assert.deepEqual(readVerdict({ state: 'MERGED' }), { kind: 'accepted' });
});

test('an open pull request with no review is still pending', () => {
  assert.deepEqual(readVerdict({ state: 'OPEN' }), { kind: 'pending' });
  assert.deepEqual(readVerdict({ state: 'OPEN', reviews: [] }), { kind: 'pending' });
  assert.deepEqual(readVerdict({ state: 'OPEN', reviews: [{ state: 'COMMENTED' }] }), {
    kind: 'pending',
  });
});

test('requesting changes is a rejection, and the comment becomes the reason', () => {
  assert.deepEqual(
    readVerdict({
      state: 'OPEN',
      reviews: [{ state: 'CHANGES_REQUESTED', body: 'use the existing helper' }],
    }),
    { kind: 'rejected', reason: 'use the existing helper' },
  );
});

test('the most recent change request wins', () => {
  const verdict = readVerdict({
    state: 'OPEN',
    reviews: [
      { state: 'CHANGES_REQUESTED', body: 'first thought', submittedAt: '2026-08-01T10:00:00Z' },
      { state: 'APPROVED', body: 'ignore me', submittedAt: '2026-08-02T10:00:00Z' },
      { state: 'CHANGES_REQUESTED', body: 'second thought', submittedAt: '2026-08-03T10:00:00Z' },
    ],
  });
  assert.deepEqual(verdict, { kind: 'rejected', reason: 'second thought' });
});

test('changes requested with no comment still rejects, with something to read', () => {
  const verdict = readVerdict({ state: 'OPEN', reviews: [{ state: 'CHANGES_REQUESTED' }] });
  assert.equal(verdict.kind, 'rejected');
  assert.match(verdict.kind === 'rejected' ? verdict.reason : '', /no comment/);
});

test('a change request the branch has moved past has been addressed', () => {
  // A ticket sent back is offered again on the same pull request. Reading the review
  // that sent it back as a live rejection would send it round again the moment it
  // re-offered itself, for ever, on an objection already dealt with.
  const verdict = readVerdict({
    state: 'OPEN',
    reviews: [{ state: 'CHANGES_REQUESTED', body: 'use it', submittedAt: '2026-08-01T10:00:00Z' }],
    commits: [{ committedDate: '2026-08-02T10:00:00Z' }],
  });
  assert.deepEqual(verdict, { kind: 'pending' }, 'it waits for someone to look again');
});

test('a change request on the work as it stands is still a rejection', () => {
  const verdict = readVerdict({
    state: 'OPEN',
    reviews: [
      { state: 'CHANGES_REQUESTED', body: 'still wrong', submittedAt: '2026-08-03T10:00:00Z' },
    ],
    commits: [{ committedDate: '2026-08-02T10:00:00Z' }],
  });
  assert.deepEqual(verdict, { kind: 'rejected', reason: 'still wrong' });
});

test('closing a pull request without merging rejects it', () => {
  const verdict = readVerdict({ state: 'CLOSED' });
  assert.deepEqual(verdict, {
    kind: 'rejected',
    reason: 'the pull request was closed without merging',
  });
});

test('merging always makes a merge commit, under the subject it is given', () => {
  assert.deepEqual(mergeArgs('https://example/pr/7', 'rename the thing (t7)'), [
    'pr',
    'merge',
    'https://example/pr/7',
    '--merge',
    '--subject',
    'rename the thing (t7)',
  ]);
});

test('the subject carries the ticket, so first-parent history reads one line each', () => {
  assert.equal(mergeSubject('rename the thing', 't7'), 'rename the thing (t7)');
  assert.equal(mergeSubject('  padded  ', 't7'), 'padded (t7)');
  assert.equal(mergeSubject('', 't7'), 't7', 'a ticket with no title is still named');
});

test('a repository that forbids merge commits is one the workbench cannot land work on', () => {
  assert.equal(allowsMergeCommits('true\n'), true);
  assert.equal(allowsMergeCommits('false\n'), false);

  // Anything that is not a definite no is taken as yes: only "false" is `gh`
  // answering the question, and the merge itself settles the rest.
  assert.equal(allowsMergeCommits(''), true);
  assert.equal(allowsMergeCommits('null'), true);
});

test('a repository `gh` cannot answer for is not refused', async () => {
  // No remote, no `gh`, no network: not being able to ask is not a no, and a
  // workbench on a repository with no GitHub at all still runs.
  assert.equal(await mergeCommitsRefusal(os.tmpdir()), undefined);
});

test('a branch keeps its pull request when it is offered again — unless that one merged', () => {
  const view = (state: string) => JSON.stringify({ url: 'https://example/pr/7', state });

  // A ticket reworked after an objection must come back to the pull request that
  // objection was written on, whether it is still open or was closed.
  assert.equal(reusablePr(view('OPEN')), 'https://example/pr/7');
  assert.equal(reusablePr(view('CLOSED')), 'https://example/pr/7');

  // A ticket sent back to be tweaked after it merged is offered on the same branch.
  // Reusing the merged pull request would have the workbench poll it, read MERGED
  // as an acceptance, and call the ticket done with the tweak never merged.
  assert.equal(reusablePr(view('MERGED')), null);

  assert.equal(reusablePr('{}'), null, 'and no pull request is no pull request');
});

test('GitHub not having caught up is worth asking again about', () => {
  // The base moved a moment ago and GitHub has not finished working out what that
  // did to this pull request. Asked now it says no; asked again it says yes.
  for (const message of [
    'GraphQL: Pull Request is not mergeable (mergePullRequest)',
    'X Pull request #7 is not mergeable: the merge commit cannot be cleanly created.',
    'GraphQL: Base branch was modified. Review and try the merge again.',
  ]) {
    assert.equal(retryableMergeFailure(message), true, message);
  }
});

test('a refusal that is a decision blocks the ticket rather than being retried', () => {
  // GitHub words most of these as "not mergeable" too, so what tells them apart is
  // the reason it gives after it — asking again would only get the same answer.
  for (const message of [
    'X Pull request #7 is not mergeable: the base branch policy prohibits the merge.',
    'X Pull request #7 is not mergeable: required status checks have not passed.',
    'X Pull request #7 is not mergeable: at least 1 approving review is required.',
    'GraphQL: You do not have permission to merge this pull request',
    'error: failed to push some refs',
  ]) {
    assert.equal(retryableMergeFailure(message), false, message);
  }
});

test('a pull request that has already merged is not merged again', () => {
  // A retry whose merge landed, or a workbench restarted with the request still
  // standing: `gh pr merge` on a merged pull request is an error, not a no-op.
  assert.equal(alreadyMerged(JSON.stringify({ state: 'MERGED' })), true);
  assert.equal(alreadyMerged(JSON.stringify({ state: 'OPEN' })), false);
  assert.equal(alreadyMerged('{}'), false, 'and nothing read is nothing merged');
});

test('the checks are read out of what `gh pr checks --json` printed', () => {
  assert.deepEqual(readChecks(JSON.stringify([{ name: 'test', bucket: 'pass' }])), [
    { name: 'test', bucket: 'pass' },
  ]);
  assert.deepEqual(readChecks('[]'), [], 'and an empty list is no checks');
  assert.deepEqual(readChecks('  '), [], 'as is nothing printed at all');
});

test('a check links to the job whose log explains it, when it is one', () => {
  assert.deepEqual(jobOf(JOB_LINK), { run: '123', job: '456' });
  // Any service can post a status, and most of them are not Actions jobs.
  assert.equal(jobOf('https://ci.example/build/7'), null);
  assert.equal(jobOf(undefined), null);
});

test('the merge waits for a check that is still running, and merges once it passes', async () => {
  const gh = fakeGh([
    refused(JSON.stringify([{ name: 'ci', bucket: 'pending', state: 'IN_PROGRESS' }])),
    checksJson([{ name: 'ci', bucket: 'pass', state: 'SUCCESS' }]),
  ]);

  const outcome = await awaitChecks('https://example/pr/1', '/tmp/wt', {
    timeoutMs: 20 * 60_000,
    ...gh,
  });

  assert.deepEqual(outcome, {
    kind: 'passed',
    results: [{ command: 'ci', ok: true, output: '' }],
  });
  assert.equal(gh.calls.length, 2, 'it asked again rather than reading the first answer as final');
});

test('a failing check does not merge, and brings back the failing job’s log', async () => {
  const gh = fakeGh([
    refused(
      JSON.stringify([
        { name: 'lint', bucket: 'pass', state: 'SUCCESS', description: 'ok' },
        { name: 'ci', bucket: 'fail', state: 'FAILURE', link: JOB_LINK, description: 'failing' },
      ]),
    ),
    said('FAIL test/units.py::test_headline\nAssertionError: 2 != 3\n'),
  ]);

  const outcome = await awaitChecks('https://example/pr/1', '/tmp/wt', {
    timeoutMs: 20 * 60_000,
    ...gh,
  });

  assert.equal(outcome.kind, 'checks_failed');
  const results = outcome.kind === 'checks_failed' ? outcome.results : [];
  assert.deepEqual(
    results.map((r) => [r.command, r.ok]),
    [
      ['lint', true],
      ['ci', false],
    ],
    'every check is recorded, not only the failure',
  );
  assert.match(results[1]?.output ?? '', /AssertionError: 2 != 3/);
  assert.deepEqual(
    gh.calls[1],
    ['run', 'view', '123', '--job', '456', '--log-failed'],
    'the log came from the job the check linked to',
  );
});

test('a check that never concludes gives up, naming what is still running', async () => {
  const gh = fakeGh([
    refused(
      JSON.stringify([
        { name: 'ci', bucket: 'pending', state: 'QUEUED' },
        { name: 'lint', bucket: 'pass', state: 'SUCCESS' },
      ]),
    ),
  ]);

  const outcome = await awaitChecks('https://example/pr/1', '/tmp/wt', {
    timeoutMs: 60_000,
    ...gh,
  });

  assert.deepEqual(outcome, { kind: 'checks_pending', pending: ['ci'] });
  assert.equal(gh.now(), 60_000, 'it waited the whole timeout, and not a poll longer');
});

test('a pull request with no checks on it merges without waiting for any', async () => {
  const noChecks = () => {
    throw Object.assign(new Error('no checks reported on the ‘wb/t1’ branch'), {
      stdout: '',
      stderr: '',
    });
  };
  const gh = fakeGh([noChecks, noChecks]);

  const outcome = await awaitChecks('https://example/pr/1', '/tmp/wt', {
    timeoutMs: 20 * 60_000,
    ...gh,
  });

  assert.deepEqual(outcome, { kind: 'passed', results: [] });
  // Asked twice and no more: a workflow is not queued the instant the push lands,
  // and everything after that grace is a repository that simply has no CI.
  assert.equal(gh.calls.length, 2);
  assert.equal(gh.now(), 10_000);
});

test('an approving review alone does not accept — only merging does', () => {
  assert.deepEqual(readVerdict({ state: 'OPEN', reviews: [{ state: 'APPROVED' }] }), {
    kind: 'pending',
  });
});
