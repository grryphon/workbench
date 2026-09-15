import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import {
  allowsMergeCommits,
  alreadyMerged,
  mergeArgs,
  mergeCommitsRefusal,
  mergeSubject,
  noPullRequest,
  readTarget,
  readVerdict,
  retryableMergeFailure,
  reusablePr,
  withNote,
} from './pr.ts';

test('only gh saying there is no pull request means there is none', () => {
  const failed = (stderr: string) => Object.assign(new Error('Command failed'), { stderr });
  assert.equal(noPullRequest(failed('no pull requests found for branch "their-feature"\n')), true);
  assert.equal(noPullRequest(failed('error connecting to api.github.com\n')), false);
  assert.equal(
    noPullRequest(failed('To get started with GitHub CLI, please run: gh auth login')),
    false,
  );
  assert.equal(noPullRequest(new Error('spawn gh ENOENT')), false);
});

test('the note against squashing goes on a pull request once, after what it already says', () => {
  const noted = withNote('Their description.\n');
  assert.match(
    noted,
    /^Their description\.\n\n[\s\S]*merge this pull request rather than squashing/,
  );
  assert.equal(withNote(noted), noted, 'pushed to again, it is not said twice');
  assert.equal(withNote(withNote('')), withNote(''), 'nor on a pull request that said nothing');
});

test('a pull request names the branch to work on, unless it is a fork or no longer open', () => {
  const pr = (fields: object) => JSON.stringify(fields);
  assert.deepEqual(
    readTarget(pr({ headRefName: 'their-feature', isCrossRepository: false, state: 'OPEN' }), '#1'),
    { branch: 'their-feature' },
  );
  assert.match(
    (
      readTarget(pr({ headRefName: 'x', isCrossRepository: true, state: 'OPEN' }), '#2') as {
        error: string;
      }
    ).error,
    /#2 is from a fork/,
  );
  assert.match(
    (
      readTarget(pr({ headRefName: 'x', isCrossRepository: false, state: 'MERGED' }), '#3') as {
        error: string;
      }
    ).error,
    /#3 is merged; name its branch/,
  );
});

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

test('an approving review alone does not accept — only merging does', () => {
  assert.deepEqual(readVerdict({ state: 'OPEN', reviews: [{ state: 'APPROVED' }] }), {
    kind: 'pending',
  });
});
