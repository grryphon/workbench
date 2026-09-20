import { test } from 'node:test';
import assert from 'node:assert/strict';

import { create, harness, ok, standing, waitFor } from './harness.ts';
import { openStore } from '../store/store.ts';
import { deriveTicket } from '../domain/ticket.ts';
import type { Refreshed } from '../domain/events.ts';

test('a pull request that will not open parks the ticket with the reason', async () => {
  const h = harness({
    openPr: async () => {
      throw new Error('no remote configured');
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const t = h.store.ticket('t1');
    assert.equal(t.status, 'blocked');
    assert.match(t.question?.question ?? '', /no remote configured/);
  } finally {
    await h.close();
  }
});

test('a code host that cannot be reached does not stop the ticket', async () => {
  // Five of the eight tickets ever blocked over GitHub were blocked by this, and
  // one outage took two of them a tenth of a second apart. Reading a verdict is a
  // read, the timer does it again in thirty seconds, and a person was being spent
  // on the network every time.
  let reachable = false;
  const h = harness({
    verdict: () => {
      if (!reachable) throw new Error('error connecting to api.github.com');
      return { kind: 'accepted' };
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.equal(h.store.ticket('t1').status, 'awaiting_verdict', 'still waiting, not blocked');
    assert.equal(h.store.ticket('t1').question, null, 'and not asking anybody anything');

    reachable = true;
    await h.orch.idle();

    assert.equal(h.store.ticket('t1').status, 'done', 'it picks the answer up by itself');
    assert.deepEqual(h.ran, ['plan', 'implement', 'review', 'verify'], 'nothing was re-run');
  } finally {
    await h.close();
  }
});

test('an outage is said once, and so is coming back from one', async () => {
  let reachable = false;
  const h = harness({
    verdict: () => {
      if (!reachable) throw new Error('error connecting to api.github.com');
      return { kind: 'pending' };
    },
  });
  try {
    standing(h.store, 't2');
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();
    await h.orch.idle();

    assert.equal(h.announced.length, 1, 'not once per ticket per poll');
    assert.match(h.announced[0] ?? '', /cannot read verdicts[\s\S]*api\.github\.com/);

    reachable = true;
    await h.orch.idle();

    assert.equal(h.announced.length, 2);
    assert.match(h.announced[1] ?? '', /answering again/);
  } finally {
    await h.close();
  }
});

test('merging finishes the ticket and tidies its worktree away', async () => {
  const h = harness({ verdict: { kind: 'accepted' } });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.equal(h.store.ticket('t1').status, 'done');
    assert.deepEqual(h.tidied, ['t1'], 'the branch stays, the directory goes');
  } finally {
    await h.close();
  }
});

test('a merge brings every standing pull request up to the base it moved to', async () => {
  const h = harness({
    verdict: (id) => (id === 't1' ? { kind: 'accepted' } : { kind: 'pending' }),
    refresh: () => ({ kind: 'merged', base: 'newbase', commit: 'merge01', merged: ['newbase'] }),
  });
  try {
    standing(h.store, 't2');
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.equal(h.store.ticket('t1').status, 'done', 'the merge that moved the base');

    const t2 = h.store.ticket('t2');
    assert.equal(t2.status, 'awaiting_verdict', 'the other offer still stands');
    assert.equal(t2.base, 'newbase', 'against what is actually there now');
    assert.deepEqual(t2.commits, ['merge01'], 'having taken it in');
  } finally {
    await h.close();
  }
});

test('a cancelled ticket is not brought back up to the base by somebody else merging', async () => {
  const h = harness({
    verdict: (id) => (id === 't1' ? { kind: 'accepted' } : { kind: 'pending' }),
    // t1 lands cleanly; the branch nobody is going to resolve is t2's.
    refresh: (id) =>
      id === 't1'
        ? { kind: 'up-to-date' }
        : {
            kind: 'conflicted',
            base: 'newbase',
            paths: ['webapp/bellows.js'],
            with: 'newbase',
            merged: [],
            commit: 'merge01',
            merging: false,
          },
  });
  try {
    standing(h.store, 't2');
    h.store.append('t2', { type: 'cancelled', reason: 'redundant and a mess' });
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    // Cancelling does not clear `offered`, so without the check t2 was refreshed
    // like any standing pull request, conflicted against a base it will never be
    // resolved against, and came back onto the board as a question.
    const t2 = h.store.ticket('t2');
    assert.equal(t2.status, 'cancelled', 'stopped is stopped');
    assert.deepEqual(
      h.refreshed.map((r) => r.id),
      ['t1', 't1', 't1'],
      'the cancelled branch was never touched',
    );
    assert.deepEqual(
      h.store.eventsFor('t2').filter((e) => e.type === 'blocked'),
      [],
      'and nothing was asked of the manager about it',
    );
  } finally {
    await h.close();
  }
});

test('a pull request the manager has already answered is left alone', async () => {
  const h = harness({
    verdict: (id) =>
      id === 't1' ? { kind: 'accepted' } : { kind: 'rejected', reason: 'not like that' },
    refresh: () => ({ kind: 'merged', base: 'newbase', commit: 'merge01', merged: ['newbase'] }),
  });
  try {
    standing(h.store, 't2');
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    // A merge pushed to it would be a commit made for reasons nothing to do with
    // the objection, and a change request the branch has moved past reads as one
    // that has been addressed.
    const refreshed = h.store.eventsFor('t2').filter((e) => e.type === 'refreshed');
    assert.deepEqual(refreshed, [], 'the answer is what it hears, not a merge');
    assert.equal(h.store.ticket('t2').rejection, 'not like that');
  } finally {
    await h.close();
  }
});

/**
 * A merge landing under an offered branch that will not take it. The clash is
 * reported twice — once to the pass over the offered branches, and once to the
 * refresh at the start of the run it hands the merge to, which finds the same
 * merge still on disk — and after that the branch is up to date.
 */
const CLASH: Extract<Refreshed, { kind: 'conflicted' }> = {
  kind: 'conflicted',
  base: 'newbase',
  paths: ['src/domain/rules.ts'],
  with: 'newbase',
  merged: [],
  commit: 'head0001',
  merging: true,
};

function clashingOffer(opts: Parameters<typeof harness>[0] = {}) {
  let asked = 0;
  return harness({
    ...opts,
    refresh: (id) => {
      if (id !== 't2') return { kind: 'up-to-date' };
      return ++asked <= 2 ? CLASH : { kind: 'up-to-date' };
    },
  });
}

test('a clash on an offered branch is settled by a run, not by a click', async () => {
  const handed: unknown[] = [];
  const h = clashingOffer({
    runStage: async ({ conflict }) => {
      handed.push(conflict);
      return { outcome: 'completed', summary: 'took both sides' };
    },
  });
  try {
    standing(h.store, 't1');
    standing(h.store, 't2');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(h.ran, ['implement'], 'the merge that landed bought one implement run');
    assert.deepEqual(
      handed,
      [{ base: 'newbase', paths: ['src/domain/rules.ts'] }],
      'given the merge to finish, the way the start of a stage already is',
    );

    const t2 = h.store.ticket('t2');
    assert.equal(t2.status, 'awaiting_verdict', 'still offered, and nobody was asked anything');
    assert.equal(t2.prUrl, 'https://example/pr/t2', 'on the pull request it already had');
    assert.deepEqual(h.prsOpened, ['https://example/pr/t2'], 'which the resolution was pushed to');
    assert.deepEqual(h.committed, ['t2: implement: ticket t2 (t2)'], 'as a commit of its own');
    assert.equal(t2.base, 'newbase', 'measured from the base it has now taken in');
    assert.deepEqual(h.abandoned, [], 'nothing to undo');
    assert.deepEqual(t2.conflicts, [], 'and nothing left for the manager to resolve');
  } finally {
    await h.close();
  }
});

test('a resolution that leaves a path conflicted is undone, and the manager asked', async () => {
  const h = clashingOffer({ unresolved: (paths) => [...paths] });
  try {
    standing(h.store, 't1');
    standing(h.store, 't2');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(h.committed, [], 'nothing half-resolved was committed');
    assert.deepEqual(h.abandoned, ['t2'], 'the branch is back where it was');
    assert.deepEqual(h.prsOpened, [], 'and the pull request never saw it');

    const t2 = h.store.ticket('t2');
    assert.equal(t2.status, 'blocked');
    assert.deepEqual(t2.conflicts, ['src/domain/rules.ts'], 'the panel can still list them');
    const asked = t2.question?.question ?? '';
    assert.match(asked, /src\/domain\/rules\.ts/, 'named as the clash it is');
    assert.match(asked, /resolution was tried/, 'and said to have been attempted');
    assert.match(asked, /still conflicted/, 'with what the attempt left');
  } finally {
    await h.close();
  }
});

test('a resolution the standing checks fail is undone too', async () => {
  // The last moment anything asks: what this leaves is pushed to a pull request a
  // person is reading, and no stage follows it to find out that the suite is broken.
  const h = clashingOffer({
    checks: () => [{ command: 'yarn test', ok: false, output: 'rules.test.ts: 1 failing' }],
  });
  try {
    standing(h.store, 't1');
    standing(h.store, 't2');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(h.committed, [], 'checked before the commit, so there is nothing to undo');
    assert.deepEqual(h.abandoned, ['t2']);
    assert.deepEqual(h.prsOpened, []);

    const t2 = h.store.ticket('t2');
    assert.equal(t2.status, 'blocked');
    assert.deepEqual(t2.conflicts, ['src/domain/rules.ts']);
    assert.match(t2.question?.question ?? '', /1 failing/, 'with the failure, not a summary');
    assert.match(t2.question?.question ?? '', /resolution was tried/);
  } finally {
    await h.close();
  }
});

test('a resolution is not pushed onto an offer taken back while it ran', async () => {
  // The window used to be a git merge and is now a whole agent run, and in that
  // time the manager can read the pull request and ask for something else. Pushing
  // the resolution then puts a commit on the offer they have just objected to, and
  // the `pr_opened` that follows it puts the ticket back in front of them as
  // though they had said nothing.
  const store = openStore(':memory:');
  let runs = 0;
  const h = clashingOffer({
    store,
    runStage: async () => {
      // The objection lands during the settle, and every run after it is parked —
      // so what the ticket did about it is `h.ran`, and nothing cascades past it.
      if (++runs > 1) return { outcome: 'blocked', summary: 'not what this is about' };
      store.append('t2', { type: 'changes_requested', changes: 'not like that' });
      return { outcome: 'completed', summary: 'took both sides' };
    },
  });
  try {
    standing(store, 't1');
    standing(store, 't2');
    store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(h.prsOpened, [], 'nothing was pushed to the offer they had objected to');
    assert.deepEqual(
      h.committed,
      ['t2: implement: ticket t2 (t2)'],
      'the resolution is on the branch, where whatever runs next will find it',
    );
    assert.equal(h.store.ticket('t2').offered, false, 'and the offer is still over');

    // And the settle reported back into the objection rather than over it. Routed
    // on the offer, which the objection had just ended, this walked on to a review
    // of the work that was objected to — and the changes went unread, cleared by
    // that stage starting.
    const events = store.eventsFor('t2');
    const settled = events.findIndex((e) => e.type === 'stage_finished');
    assert.equal(deriveTicket(events.slice(0, settled + 1)).status, 'implementing');
    assert.deepEqual(h.ran, ['implement', 'implement'], 'which is the run it bought');
  } finally {
    await h.close();
    store.close();
  }
});

test('nor onto one that was accepted while it ran', async () => {
  // The other way the wait can end mid-settle: a poll finds the pull request merged
  // on the host. Routed on the offer, the report walked a `done` ticket into a
  // review, a verify and a second pull request for work that had already landed.
  const store = openStore(':memory:');
  let answered = false;
  const h = clashingOffer({
    store,
    runStage: async () => {
      if (!answered) {
        answered = true;
        store.append('t2', { type: 'verdict', verdict: 'accepted' });
      }
      // Everything else this could go on to run says yes, so nothing but the routing
      // stops it: with the bug it reaches `open_pr`.
      return { outcome: 'completed', summary: 'took both sides' };
    },
  });
  try {
    standing(store, 't1');
    standing(store, 't2');
    store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.equal(store.ticket('t2').status, 'done', 'the answer is where the ticket stayed');
    assert.deepEqual(h.ran, ['implement'], 'the settle, and nothing after it');
    assert.deepEqual(h.prsOpened, [], 'no second pull request for work already merged');
  } finally {
    await h.close();
    store.close();
  }
});

test('nor onto one the code host says has been answered', async () => {
  // Pending when the pass looked, answered by the time the run came back. Pushing
  // now moves the branch past a change request, which is exactly what `readVerdict`
  // reads as having addressed it.
  let answered = false;
  const h = clashingOffer({
    verdict: (id) =>
      id === 't2' && answered ? { kind: 'rejected', reason: 'not this' } : { kind: 'pending' },
    runStage: async ({ stage }) => {
      // The answer is what happens next: a rejection buys a new plan. Parked there,
      // because the round after one is not what this is about.
      if (stage !== 'implement') return { outcome: 'blocked', summary: 'not what this is about' };
      answered = true;
      return { outcome: 'completed', summary: 'took both sides' };
    },
  });
  try {
    standing(h.store, 't1');
    standing(h.store, 't2');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(h.prsOpened, [], 'nothing was pushed');
    assert.deepEqual(h.ran, ['implement', 'plan'], 'the rejection was read and acted on');
  } finally {
    await h.close();
  }
});

test('a ticket sent back while the pass is mid-list is left where it is', async () => {
  // The pass reads the offered branches once and then works through them, handing
  // each clash to a run beside it. Any of those runs can send another ticket back
  // while the pass is still going, so the list it read can be out of date by the
  // time it reaches the third: merging the base into a worktree an agent is writing
  // in is not something to find out about from the diff.
  const store = openStore(':memory:');
  let asked = 0;
  const h = harness({
    store,
    refresh: (id) => {
      if (id !== 't2') return { kind: 'up-to-date' };
      // Sent back between t2 and t3, which is the window the re-read exists for.
      if (++asked === 1)
        store.append('t3', { type: 'changes_requested', changes: 'not like that' });
      return asked <= 2 ? CLASH : { kind: 'up-to-date' };
    },
    runStage: async ({ ticket }) =>
      ticket.id === 't2' ? ok('took both sides') : { outcome: 'blocked', summary: 'not this' },
  });
  try {
    standing(store, 't1');
    standing(store, 't2');
    standing(store, 't3');
    store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.equal(
      h.refreshed.filter((r) => r.id === 't3').length,
      1,
      'brought up to date by its own run, and not by the pass that had it as offered',
    );
  } finally {
    await h.close();
    store.close();
  }
});

/** The same clash, against a branch this ticket waited for rather than the base. */
function dependencyClash(opts: Parameters<typeof harness>[0] = {}) {
  let asked = 0;
  return harness({
    ...opts,
    refresh: (id) => {
      if (id !== 't2') return { kind: 'up-to-date' };
      return ++asked <= 2
        ? { ...CLASH, with: 'wb/t3', paths: ['project/shared.py'] }
        : { kind: 'up-to-date' };
    },
  });
}

test('a clash with work the ticket waited for is settled by a run too', async () => {
  // It used to be the manager's, on the grounds that the dependency was theirs to
  // choose. t36 on the FamilyTree board parked on six files against wb/t37 and then
  // t37 landed two minutes later, making it a base clash and settling it that way.
  const handed: unknown[] = [];
  const h = dependencyClash({
    runStage: async ({ conflict }) => {
      handed.push(conflict);
      return ok('took both sides');
    },
  });
  try {
    standing(h.store, 't1');
    standing(h.store, 't2');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(h.ran, ['implement'], 'the dependency clash bought one implement run');
    assert.deepEqual(
      handed,
      [{ base: 'newbase', paths: ['project/shared.py'], with: 'wb/t3' }],
      'told which branch it is resolving against, not a base sha',
    );

    const t2 = h.store.ticket('t2');
    assert.equal(t2.status, 'awaiting_verdict', 'still offered, and nobody was asked anything');
    assert.deepEqual(h.prsOpened, ['https://example/pr/t2'], 'the resolution was pushed');
    assert.deepEqual(h.abandoned, [], 'nothing to undo');
    assert.deepEqual(t2.conflicts, [], 'and nothing left for the manager to resolve');
  } finally {
    await h.close();
  }
});

test('what a settled dependency clash brought in is recorded as taken, not as the base', async () => {
  // The merge on disk is another ticket's branch tip. A base moved onto it measures
  // their whole change as this ticket's, and a record that forgets the branch is in
  // here lets the next refresh move the base onto a commit without it.
  const h = dependencyClash();
  try {
    standing(h.store, 't1');
    standing(h.store, 't2');
    // Offered work has commits on it, and that is what has the reducer hold the base
    // where the branch stood rather than take the one this refresh reports.
    h.store.append('t2', { type: 'refreshed', base: 'abc1234', commit: 'earlier1' });
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    const t2 = h.store.ticket('t2');
    assert.equal(t2.base, 'abc1234', 'where the branch was cut, not the dependency’s tip');
    assert.deepEqual(t2.carrying, ['wb/t3'], 'and the branch says what it is standing on');
  } finally {
    await h.close();
  }
});

test('a dependency that lands mid-settle does not take the base onto the resolution', async () => {
  // The other half of the window: t3's pull request merges while t2 is resolving
  // against wb/t3, so at the commit `carrying` drops the branch as landed and the
  // reducer no longer holds anything. What the settle writes is then the base the
  // ticket keeps — and this run's own commit has all of t2's work in it, so a base
  // there leaves every later stage and the reviewer looking at no change at all.
  const h = dependencyClash({
    runStage: async () => {
      h.store.append('t3', { type: 'verdict', verdict: 'accepted' });
      return ok('took both sides');
    },
  });
  try {
    standing(h.store, 't1');
    standing(h.store, 't2');
    standing(h.store, 't3');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    const t2 = h.store.ticket('t2');
    assert.deepEqual(t2.carrying, [], 'the work is in the base now, so nothing is held');
    assert.equal(t2.base, 'abc1234', 'and the base is still the branch’s, not the settle’s commit');
  } finally {
    await h.close();
  }
});

test('a settled dependency clash keeps the branches that merged before it', async () => {
  // t2 waited for two tickets: wb/t4 came in cleanly at offer time and wb/t3 clashed.
  // The ticket the settle is handed is the object from before that first merge was
  // recorded, so `carrying` read off it forgets wb/t4 — and once t3 lands, the base
  // moves onto a commit that has not got wb/t4, which is the loss `carrying` exists
  // to prevent.
  let asked = 0;
  const h = harness({
    refresh: (id) => {
      if (id !== 't2') return { kind: 'up-to-date' };
      return ++asked <= 2
        ? { ...CLASH, with: 'wb/t3', paths: ['project/shared.py'], merged: ['newbase', 'wb/t4'] }
        : { kind: 'up-to-date' };
    },
  });
  try {
    standing(h.store, 't1');
    standing(h.store, 't2');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(
      h.store.ticket('t2').carrying,
      ['wb/t4', 'wb/t3'],
      'both of them, not only the one the settle brought in',
    );
  } finally {
    await h.close();
  }
});

test('a dependency clash a run cannot settle is undone, and the manager asked', async () => {
  const h = dependencyClash({ unresolved: (paths) => [...paths] });
  try {
    standing(h.store, 't1');
    standing(h.store, 't2');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(h.ran, ['implement'], 'one attempt, as with any other clash');
    assert.deepEqual(h.committed, [], 'nothing half-resolved was committed');
    assert.deepEqual(h.abandoned, ['t2'], 'the branch is back where it was');
    assert.deepEqual(h.prsOpened, [], 'and the pull request never saw it');

    const t2 = h.store.ticket('t2');
    assert.equal(t2.status, 'blocked');
    assert.deepEqual(t2.conflicts, ['project/shared.py']);
    assert.deepEqual(
      t2.conflictedWith,
      { ref: 'wb/t3', base: 'newbase' },
      'the branch it waits for, not the base, which is what the panel says',
    );
    const asked = t2.question?.question ?? '';
    assert.match(asked, /wb\/t3/, 'named as the branch it clashed with');
    assert.match(asked, /project\/shared\.py/);
    assert.match(asked, /resolution was tried/, 'and said to have been attempted');
  } finally {
    await h.close();
  }
});

/**
 * The same clash, found half a second earlier: on the branch the workbench is
 * offering for the first time, straight after verify. Clean while the work is being
 * built, and clashing from the moment there is work to offer — the offer finds it,
 * the run the offer hands the merge to finds the same merge still on disk, and after
 * `times` of them the branch is up to date.
 */
function clashingFirstOffer(opts: Parameters<typeof harness>[0] = {}, times = 2) {
  let asked = 0;
  const h = harness({
    ...opts,
    refresh: () => {
      // `ran` gains 'verify' when the run starts, and a stage refreshes before that,
      // so every refresh the stages ask for is clean and every one after them clashes.
      if (!h.ran.includes('verify')) return { kind: 'up-to-date' };
      return ++asked <= times ? CLASH : { kind: 'up-to-date' };
    },
  });
  return h;
}

test('a clash found as work is first offered is settled by a run too', async () => {
  // t36 on the FamilyTree board: it finished verify, was offered, clashed on six
  // files against a base that had moved while it built, and parked for a click that
  // would have said what every other one says.
  const handed: unknown[] = [];
  const askedAbout: (string | null)[] = [];
  const h = clashingFirstOffer({
    verdict: () => {
      askedAbout.push(h.store.ticket('t1').prUrl);
      return { kind: 'pending' };
    },
    runStage: async ({ conflict }) => {
      if (conflict !== undefined) handed.push(conflict);
      return ok('took both sides');
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(
      h.ran,
      ['plan', 'implement', 'review', 'verify', 'implement'],
      'the offer bought one implement run rather than parking',
    );
    assert.deepEqual(
      handed,
      [{ base: 'newbase', paths: ['src/domain/rules.ts'] }],
      'given the merge to finish, the way the start of a stage already is',
    );
    assert.deepEqual(h.prsOpened, ['https://example/pr/t1'], 'and then the work was offered');

    const t1 = h.store.ticket('t1');
    assert.equal(t1.status, 'awaiting_verdict', 'with nobody asked anything on the way');
    assert.equal(t1.base, 'newbase', 'measured from the base it has now taken in');
    assert.deepEqual(t1.conflicts, [], 'and nothing left for the manager to resolve');
    assert.deepEqual(h.abandoned, [], 'nothing to undo');
    assert.deepEqual(
      askedAbout.filter((url) => url === null),
      [],
      'the host was never asked for a verdict on a pull request that did not exist',
    );
  } finally {
    await h.close();
  }
});

test('a resolution that does not land at offer time is undone, and the manager asked', async () => {
  const h = clashingFirstOffer({ unresolved: (paths) => [...paths] });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.equal(
      h.committed.filter((m) => m.includes('implement')).length,
      1,
      'nothing half-resolved was committed on top of the work',
    );
    assert.deepEqual(h.abandoned, ['t1'], 'the branch is back where it was');
    assert.deepEqual(h.prsOpened, [], 'and the work was not offered');

    const t1 = h.store.ticket('t1');
    assert.equal(t1.status, 'blocked');
    assert.deepEqual(t1.conflicts, ['src/domain/rules.ts'], 'the panel can still list them');
    const asked = t1.question?.question ?? '';
    assert.match(asked, /src\/domain\/rules\.ts/, 'named as the clash it is');
    assert.match(asked, /resolution was tried/, 'and said to have been attempted');
    assert.match(asked, /still conflicted/, 'with what the attempt left');
  } finally {
    await h.close();
  }
});

test('a settle at offer time gets one attempt, and the offer it makes may not settle', async () => {
  // A branch nothing brings up to date: without `settle: false` on the way back out,
  // the offer would settle, offer, settle, offer, for as long as it kept clashing.
  const h = clashingFirstOffer({}, Infinity);
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(
      h.ran,
      ['plan', 'implement', 'review', 'verify', 'implement'],
      'one settling run, and the manager asked about what it did not settle',
    );
    assert.deepEqual(
      h.refreshed.map((r) => r.keepConflict),
      [true, true, true, true, false],
      'the two stages, the offer and its settle may all hand a merge on; the re-offer may not',
    );
    assert.equal(h.store.ticket('t1').status, 'blocked');
  } finally {
    await h.close();
  }
});

test('nothing else picks the ticket up between its settle and its offer', async () => {
  // The settling run is nested inside the `perform` that is opening the pull request,
  // and that already holds the ticket in flight. A settle that dropped the claim when
  // it finished left the ticket reading `implementing` with nothing running, and the
  // next tick started a real implement stage in the worktree being pushed from.
  const h = clashingFirstOffer({
    runStage: async () => {
      await h.orch.tick();
      return ok('took both sides');
    },
    openPr: async () => {
      await h.orch.tick();
      return 'https://example/pr/t1';
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(
      h.ran,
      ['plan', 'implement', 'review', 'verify', 'implement'],
      'the ticket was claimed throughout, so no tick found anything to start',
    );
    assert.deepEqual(h.prsOpened, ['https://example/pr/t1'], 'and it was offered once');
    assert.equal(h.store.ticket('t1').status, 'awaiting_verdict');
  } finally {
    await h.close();
  }
});

test('the manager can merge the offer here, and the ticket is done', async () => {
  const h = harness();
  try {
    standing(h.store, 't2');
    standing(h.store, 't1');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(h.prsMerged, ['https://example/pr/t1']);
    assert.equal(h.store.ticket('t1').status, 'done', 'the verdict is recorded here, not polled');
    assert.deepEqual(h.tidied, ['t1'], 'and the workspace goes with it');
    // The base has moved under everything else that is standing, exactly as it
    // would have if the merge had been done on GitHub.
    const refreshed = h.store.eventsFor('t2').filter((e) => e.type === 'refreshed');
    assert.equal(refreshed.length, 0, 'up to date here, but it was asked');
    assert.equal(h.store.ticket('t2').status, 'awaiting_verdict');
  } finally {
    await h.close();
  }
});

test('a merge onto a base that will not merge names the files and merges nothing', async () => {
  const h = harness({
    refresh: () => ({
      kind: 'conflicted',
      base: 'newbase',
      paths: ['src/api/server.ts'],
      // A merge that failed rather than conflicted: there is nothing on disk for a
      // resolution to finish, so this is the clash that goes straight to the manager.
      with: 'newbase',
      merged: [],
      commit: 'head0001',
      merging: false,
    }),
  });
  try {
    standing(h.store, 't1');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(h.prsMerged, [], 'nothing is merged over a clash');
    const ticket = h.store.ticket('t1');
    assert.equal(ticket.status, 'blocked');
    assert.deepEqual(ticket.conflicts, ['src/api/server.ts'], 'the panel can list them');
    assert.deepEqual(ticket.conflictedWith, { ref: 'newbase', base: 'newbase' }, 'with the base');
    assert.equal(ticket.mergeRequested, false, 'and it does not keep trying');
  } finally {
    await h.close();
  }
});

test('a merge the code host refuses parks the ticket rather than finishing it', async () => {
  const h = harness({
    merge: async () => {
      throw new Error('the base branch requires a review');
    },
  });
  try {
    standing(h.store, 't1');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    const ticket = h.store.ticket('t1');
    assert.equal(ticket.status, 'blocked');
    assert.match(ticket.question?.question ?? '', /requires a review/);
    assert.deepEqual(h.tidied, [], 'nothing was accepted, so nothing is thrown away');
  } finally {
    await h.close();
  }
});

/** One turn of the event loop, so anything that overlaps has the chance to. */
const turn = () => new Promise((resolve) => setImmediate(resolve));

test('one pull request merges at a time, the pass over the others included', async () => {
  // Merging brings the new base into every other offered branch, one at a time. Two
  // merges at once put two of those passes in the same worktrees.
  const order: string[] = [];
  const h = harness({
    merge: async (id) => {
      order.push(`merge ${id}`);
      await turn();
    },
    discard: async (id) => {
      order.push(`pass after ${id}`);
      await turn();
    },
  });
  try {
    standing(h.store, 't1');
    standing(h.store, 't2');
    h.store.append('t1', { type: 'merge_requested' });
    h.store.append('t2', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(order, ['merge t1', 'pass after t1', 'merge t2', 'pass after t2']);
    assert.deepEqual(h.prsMerged, ['https://example/pr/t1', 'https://example/pr/t2']);
    assert.equal(h.store.ticket('t1').status, 'done');
    assert.equal(h.store.ticket('t2').status, 'done');
  } finally {
    await h.close();
  }
});

test('a poll that finds three pull requests merged takes them one at a time', async () => {
  // No click is needed for the same pile-up: three merged on github.com between
  // polls used to start three passes over the same branches at once.
  const order: string[] = [];
  const h = harness({
    verdict: { kind: 'accepted' },
    discard: async (id) => {
      order.push(`enter ${id}`);
      await turn();
      order.push(`exit ${id}`);
    },
  });
  try {
    for (const id of ['t1', 't2', 't3']) standing(h.store, id);
    await h.orch.idle();

    assert.deepEqual(order, ['enter t1', 'exit t1', 'enter t2', 'exit t2', 'enter t3', 'exit t3']);
    for (const id of ['t1', 't2', 't3']) assert.equal(h.store.ticket(id).status, 'done');
  } finally {
    await h.close();
  }
});

test('a merge asked for while one is running says what it waits for, then merges', async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness({
    merge: async (id) => {
      if (id === 't1') await held;
    },
  });
  try {
    standing(h.store, 't1');
    standing(h.store, 't2');
    h.store.append('t1', { type: 'merge_requested' });
    h.store.append('t2', { type: 'merge_requested' });

    await h.orch.tick();
    await h.orch.tick();
    await h.orch.tick();

    // On the ticket rather than on stdout: a manager watching the board is not
    // watching `wb serve`'s output, and "merging…" for a ticket that has not started
    // is the workbench keeping the reason to itself.
    assert.deepEqual(
      h.store.eventsFor('t2').flatMap((e) => (e.type === 'merge_queued' ? [e.behind] : [])),
      ['t1'],
      'said once, not once a tick',
    );
    assert.deepEqual(h.announced, [], 'and nothing was said to nobody');
    assert.equal(h.store.ticket('t2').queuedBehind, 't1', 'which the panel reads off the ticket');
    assert.equal(h.store.ticket('t2').mergeRequested, true, 'the request still stands');
    assert.deepEqual(h.prsMerged, [], 'and nothing of it has happened yet');

    release();
    await h.orch.idle();

    assert.deepEqual(h.prsMerged, ['https://example/pr/t1', 'https://example/pr/t2']);
    assert.equal(h.store.ticket('t2').status, 'done', 'the queue drains on its own');
  } finally {
    release();
    await h.close();
  }
});

test('a ticket queued behind the same merge a second time says so a second time', async () => {
  // Said once per wait, not once in the life of the process. The host refuses both
  // merges and both tickets park; the manager sorts out whatever it was and accepts
  // them again — and t2 waiting behind t1 is news again, because the panel cleared
  // what it knew when t2 blocked.
  const entered: string[] = [];
  let refuse = true;
  let release = () => {};
  let held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness({
    merge: async (id) => {
      entered.push(id);
      await held;
      if (refuse) throw new Error('the base branch requires a review');
    },
  });
  try {
    standing(h.store, 't1');
    standing(h.store, 't2');
    h.store.append('t1', { type: 'merge_requested' });
    h.store.append('t2', { type: 'merge_requested' });
    await h.orch.tick();
    await waitFor(() => h.store.ticket('t2').queuedBehind === 't1', 't2 to queue behind t1');

    release();
    await h.orch.idle();
    assert.equal(h.store.ticket('t1').status, 'blocked', 'refused, so both park');
    assert.equal(h.store.ticket('t2').status, 'blocked');
    assert.equal(h.store.ticket('t2').queuedBehind, null, 'and the wait is over either way');

    // Sorted out, and both accepted again.
    refuse = false;
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    for (const id of ['t1', 't2'])
      h.store.append(id, { type: 'question_answered', answer: 'go on' });
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.tick();
    await waitFor(() => entered.length === 3, 't1 to take the gate a second time');
    h.store.append('t2', { type: 'merge_requested' });
    await h.orch.tick();
    await waitFor(
      () => h.store.ticket('t2').queuedBehind === 't1',
      't2 to be told what it is behind again',
    );

    assert.deepEqual(
      h.store.eventsFor('t2').flatMap((e) => (e.type === 'merge_queued' ? [e.behind] : [])),
      ['t1', 't1'],
      'a wait each time there was one',
    );

    release();
    await h.orch.idle();
    assert.deepEqual(h.prsMerged, ['https://example/pr/t1', 'https://example/pr/t2']);
  } finally {
    release();
    await h.close();
  }
});

test('the settles a merge sets off run beside the gate rather than inside it', async () => {
  // Five accepts thirteen seconds apart on the FamilyTree board: two landed, and the
  // other three said "merging…" for seven and a half minutes while the pass after
  // each landing ran an implement stage over one clashing branch after another,
  // inside the gate. Nothing was stuck, and nothing on the board said so.
  let release = () => {};
  const settling = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [];
  const h = harness({
    refresh: (id) => (id === 't2' || id === 't3' ? CLASH : { kind: 'up-to-date' }),
    runStage: async ({ ticket }) => {
      started.push(ticket.id);
      await settling;
      return { outcome: 'blocked', summary: 'could not finish it' };
    },
  });
  try {
    for (const id of ['t1', 't2', 't3', 't4']) standing(h.store, id);
    h.store.append('t1', { type: 'merge_requested' });
    h.store.append('t4', { type: 'merge_requested' });
    await h.orch.tick();
    await waitFor(() => h.prsMerged.length === 2, 'the queue behind t1 to drain');

    assert.deepEqual(h.prsMerged, ['https://example/pr/t1', 'https://example/pr/t4']);
    assert.deepEqual([...started].sort(), ['t2', 't3'], 'both settles were still going');
    assert.equal(h.store.ticket('t2').running, true);
    assert.equal(h.store.ticket('t3').running, true);
    assert.equal(h.store.ticket('t4').status, 'done', 'and the queued merge did not wait for them');
    assert.deepEqual(
      h.store.eventsFor('t4').flatMap((e) => (e.type === 'merge_queued' ? [e.behind] : [])),
      ['t1'],
      'having said on the ticket what it was behind',
    );

    release();
    await h.orch.idle();

    assert.deepEqual([...h.abandoned].sort(), ['t2', 't3'], 'nothing landed, so nothing is kept');
    assert.deepEqual(h.store.ticket('t2').conflicts, ['src/domain/rules.ts']);
    assert.equal(h.store.ticket('t3').status, 'blocked');
  } finally {
    release();
    await h.close();
  }
});

test('a ticket whose own merge is queued is left for that merge to settle', async () => {
  // The base will very likely move again before its turn comes, so settling it from
  // the pass buys a whole run against a base that is already history. The pass after
  // t1 therefore leaves t2 alone, and t2 is settled at the front of the queue by its
  // own merge — which holds the gate while it does it, and that is what t3 says.
  const order: string[] = [];
  let asked = 0;
  let release = () => {};
  const settling = new Promise<void>((resolve) => {
    release = resolve;
  });
  const h = harness({
    refresh: (id) => (id === 't2' && ++asked <= 2 ? CLASH : { kind: 'up-to-date' }),
    merge: async (id) => {
      order.push(`merge ${id}`);
    },
    runStage: async () => {
      order.push('settle t2');
      await settling;
      return ok('took both sides');
    },
  });
  try {
    for (const id of ['t1', 't2', 't3']) standing(h.store, id);
    for (const id of ['t1', 't2', 't3']) h.store.append(id, { type: 'merge_requested' });
    await h.orch.tick();
    await waitFor(
      () => h.store.ticket('t3').queuedBehind === 't2',
      't2 to reach the front and settle there',
    );

    // Had the pass after t1 settled it, this run would have been going beside a free
    // gate — and t3 would have merged straight past a t2 it never waited for.
    assert.deepEqual(order, ['merge t1', 'settle t2'], 'the pass after t1 started nothing');
    assert.deepEqual(h.prsMerged, ['https://example/pr/t1'], 'the settle is holding the gate');

    release();
    await h.orch.idle();

    assert.deepEqual(order, ['merge t1', 'settle t2', 'merge t2', 'merge t3']);
    assert.equal(
      h.refreshed.filter((r) => r.id === 't2').length,
      3,
      'its own merge’s, its settling run’s and the offer that settle makes — none the pass’s',
    );
    assert.equal(h.store.ticket('t2').status, 'done');
  } finally {
    release();
    await h.close();
  }
});

test('a merge the manager asked for is not asked about again once the clash is settled', async () => {
  // Their Accept is the answer. Reading the verdict again after the resolution puts a
  // whole agent run's window under a host read that answers null for a blip — and a
  // null there leaves the resolution committed and never pushed, followed by a merge
  // of a pull request whose head has none of it.
  let asked = 0;
  const h = harness({
    refresh: () => (++asked <= 2 ? CLASH : { kind: 'up-to-date' }),
    verdict: () => {
      throw new Error('error connecting to api.github.com');
    },
  });
  try {
    standing(h.store, 't1');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(h.announced, [], 'the host was not asked, so no outage was reported');
    assert.deepEqual(h.prsOpened, ['https://example/pr/t1'], 'the resolution was pushed');
    assert.deepEqual(h.prsMerged, ['https://example/pr/t1'], 'and merged, which is what was asked');
    assert.equal(h.store.ticket('t1').status, 'done');
  } finally {
    await h.close();
  }
});

test('a merge the manager asked for settles a clash with the base, then merges', async () => {
  // The same one attempt every other branch meeting its base gets, and then the
  // click they already made. Sending it back by hand cost a run on the FamilyTree
  // board: the resolution was three minutes in, finished, and a second implement
  // run started on top of it with the manager's brief.
  let asked = 0;
  const handed: unknown[] = [];
  const h = harness({
    refresh: () => (++asked <= 2 ? CLASH : { kind: 'up-to-date' }),
    runStage: async ({ conflict }) => {
      handed.push(conflict);
      return ok('took both sides');
    },
  });
  try {
    standing(h.store, 't1');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(h.ran, ['implement'], 'one resolution run, not a click that says resolve it');
    assert.deepEqual(handed, [{ base: 'newbase', paths: ['src/domain/rules.ts'] }]);
    assert.deepEqual(h.prsOpened, ['https://example/pr/t1'], 'pushed to the pull request');
    assert.deepEqual(h.prsMerged, ['https://example/pr/t1'], 'and merged in the same breath');
    assert.deepEqual(h.abandoned, [], 'nothing to undo');
    assert.equal(h.store.ticket('t1').status, 'done');
  } finally {
    await h.close();
  }
});

test('a merge whose clash will not settle blocks with the paths, having tried once', async () => {
  const h = harness({ refresh: () => CLASH, unresolved: (paths) => [...paths] });
  try {
    standing(h.store, 't1');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.deepEqual(h.ran, ['implement'], 'one attempt, and no second one from the next tick');
    assert.deepEqual(h.prsMerged, [], 'nothing is merged over a clash');
    assert.deepEqual(h.abandoned, ['t1'], 'and the branch is back where it was');

    const t1 = h.store.ticket('t1');
    assert.equal(t1.status, 'blocked');
    assert.deepEqual(t1.conflicts, ['src/domain/rules.ts'], 'the panel can list them');
    assert.match(t1.question?.question ?? '', /resolution was tried/);
    assert.equal(t1.mergeRequested, false, 'and it does not keep trying');
  } finally {
    await h.close();
  }
});

test('a merge left queued is still asked for after the workbench restarts', async () => {
  // The queue needs no state of its own: a merge asked for is a durable event, and
  // queuing is only this tick declining to act on it.
  const store = openStore(':memory:');
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = harness({
    store,
    merge: async (id) => {
      if (id === 't1') await held;
    },
  });
  try {
    standing(store, 't1');
    standing(store, 't2');
    store.append('t1', { type: 'merge_requested' });
    store.append('t2', { type: 'merge_requested' });
    await first.orch.tick();

    assert.deepEqual(first.prsMerged, [], 'the first merge has not finished');
    assert.equal(store.ticket('t2').mergeRequested, true);
  } finally {
    release();
    await first.close();
  }

  const second = harness({ store });
  try {
    await second.orch.idle();

    assert.deepEqual(second.prsMerged, ['https://example/pr/t2'], 'picked up where it left off');
    assert.equal(store.ticket('t2').status, 'done');
  } finally {
    await second.close();
    store.close();
  }
});

test('work that conflicts with the base it must land on is not offered', async () => {
  const h = harness({
    refresh: () => ({
      kind: 'conflicted',
      base: 'newbase',
      paths: ['src/domain/rules.ts'],
      with: 'newbase',
      merged: [],
      commit: 'head0001',
      merging: false,
    }),
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const ticket = h.store.ticket('t1');
    assert.equal(ticket.status, 'blocked');
    assert.match(ticket.question?.question ?? '', /src\/domain\/rules\.ts/, 'and says where');
    assert.deepEqual(h.prsOpened, [], 'nothing was offered against a base it cannot sit on');
  } finally {
    await h.close();
  }
});

test('a merge a stage stopped partway through is settled at the offer, not parked', async () => {
  // Left by a run that was handed the merge and stopped to ask something: `refresh` in
  // worktree.ts hands that merge back rather than tidying it away, so the offer finds
  // one it did not start. It used to park for a click; now it goes to a settling run
  // like any other clash with the base. This one cannot finish it either, and what
  // both runs left goes with the merge — the manager is asked about the work as it
  // stands, rather than about a branch carrying two unfinished resolutions.
  let runs = 0;
  const h = harness({
    refresh: () => ({
      kind: 'conflicted',
      base: 'newbase',
      paths: ['src/domain/rules.ts'],
      with: 'newbase',
      merged: [],
      commit: 'head0001',
      merging: true,
    }),
    // Each of the four stages finishes the merge it is handed. The fifth run is the
    // settle the offer buys, and it is the one that does not.
    runStage: async () =>
      ++runs < 5 ? ok('resolved') : { outcome: 'blocked', summary: 'could not finish it' },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(
      h.ran,
      ['plan', 'implement', 'review', 'verify', 'implement'],
      'the merge on disk was handed to a run rather than to the manager',
    );
    assert.deepEqual(h.abandoned, ['t1'], 'and when nothing landed, it went with everything else');

    const ticket = h.store.ticket('t1');
    assert.equal(ticket.status, 'blocked');
    assert.deepEqual(ticket.conflicts, ['src/domain/rules.ts'], 'so the manager is asked');
    assert.match(ticket.question?.question ?? '', /resolution was tried/, 'having tried one');
    assert.deepEqual(h.prsOpened, [], 'over a branch that was not offered');
  } finally {
    await h.close();
  }
});

test('work that deletes what the base added is not offered', async () => {
  // Four branches in a row reverted the same dependency, and every reviewer read
  // the deletion as the ticket's own work.
  const anchors: (string | undefined)[] = [];
  const h = harness({
    removedFromBase: (_id, from) => {
      anchors.push(from);
      return ['project/deps.lock', 'project/vendor/sdk.py'];
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const ticket = h.store.ticket('t1');
    assert.equal(ticket.status, 'blocked');
    const asked = ticket.question?.question ?? '';
    assert.match(asked, /project\/deps\.lock/);
    assert.match(asked, /project\/vendor\/sdk\.py/, 'every one of them, not the first');
    assert.match(asked, /put them back/, 'and what the ticket can do about it');
    assert.deepEqual(h.prsOpened, [], 'and nothing was offered');
    assert.deepEqual(ticket.conflicts, [], 'not a clash git has an opinion about');
    assert.deepEqual(anchors, ['abc1234'], 'measured from what the ticket is measured from');
  } finally {
    await h.close();
  }
});

test('a standing branch that reverts the base it is brought up to is parked too', async () => {
  // A resolution reverts as well as a merge does, so the pass over the other pull
  // requests after a merge asks the same question the first offer did.
  const h = harness({
    verdict: (id) => (id === 't1' ? { kind: 'accepted' } : { kind: 'pending' }),
    refresh: () => ({ kind: 'merged', base: 'newbase', commit: 'merge01', merged: ['newbase'] }),
    removedFromBase: (id) => (id === 't2' ? ['project/deps.lock'] : []),
  });
  try {
    standing(h.store, 't2');
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(h.prsOpened, ['https://example/pr/t1'], 'the one that reverted nothing');
    assert.equal(h.store.ticket('t1').status, 'done', 'offered and merged exactly as before');

    const t2 = h.store.ticket('t2');
    assert.equal(t2.status, 'blocked');
    assert.match(t2.question?.question ?? '', /project\/deps\.lock/, 'and says which file');
  } finally {
    await h.close();
  }
});

test('work the new base breaks is not offered either', async () => {
  let asked = 0;
  // Only the refresh at the offer, which is the one this is about: the base moved
  // while verify ran, so this is the first time the two are in a tree together. A
  // base that came in earlier, at the start of a stage, is checked at the end of that
  // stage instead — see loop.test.ts — and would never reach this door.
  let refreshes = 0;
  const h = harness({
    refresh: () =>
      ++refreshes === 3
        ? { kind: 'merged', base: 'newbase', commit: 'merge01', merged: ['newbase'] }
        : { kind: 'up-to-date' },
    // The first call is the implement run's end-of-run check, which passes; verify's
    // own refresh is up-to-date, so verify runs none. The failing call is the one after
    // the offer-time merge: the clash a merge resolves silently is the one worth
    // finding.
    checks: () => [
      asked++ === 0
        ? { command: 'yarn test', ok: true, output: '' }
        : { command: 'yarn test', ok: false, output: 'rules.test.ts: 1 failing' },
    ],
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const ticket = h.store.ticket('t1');
    assert.equal(ticket.status, 'blocked');
    assert.match(ticket.question?.question ?? '', /1 failing/, 'with the failure, not a summary');
    assert.equal(ticket.commits.at(-1), 'merge01', 'the merge is still on the branch');
    assert.deepEqual(h.prsOpened, []);
  } finally {
    await h.close();
  }
});

test('a check the code host failed sends the work back instead of merging it', async () => {
  // The repository whose real test can only run in Actions, with secrets a worktree
  // does not have: the only way it gates on that test is the merge waiting for it.
  const h = harness({
    merge: async () => ({
      kind: 'checks_failed',
      results: [
        { command: 'lint', ok: true, output: '' },
        { command: 'integration', ok: false, output: 'AssertionError: 2 != 3' },
      ],
    }),
  });
  try {
    standing(h.store, 't1');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    // Where the failure put it, read at the moment it was recorded: the loop carries
    // straight on from there, and by the time it is idle the rework has been built,
    // reviewed, verified and offered again on the same pull request.
    const events = h.store.eventsFor('t1');
    const at = events.findIndex((e) => e.type === 'pr_checks_run');
    assert.notEqual(at, -1, 'the wait is in the ticket’s history');
    const sent = deriveTicket(events.slice(0, at + 1));

    assert.equal(sent.status, 'implementing', 'back to the stage that can put it right');
    assert.match(sent.changes ?? '', /`integration` failed:\nAssertionError: 2 != 3/);
    assert.equal(sent.revisions, 1, 'and it costs a revision, like any other round of changes');

    assert.deepEqual(h.ran, ['implement', 'review', 'verify'], 'the work was made again');
    assert.deepEqual(h.prsMerged, [], 'nothing was merged');
    assert.deepEqual(h.tidied, [], 'and nothing was tidied up, because nothing was accepted');
  } finally {
    await h.close();
  }
});

test('checks that never finish park the ticket naming what is still running', async () => {
  const h = harness({
    merge: async () => ({ kind: 'checks_pending', pending: ['integration', 'docs'] }),
  });
  try {
    standing(h.store, 't1');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    const t = h.store.ticket('t1');
    assert.equal(t.status, 'blocked');
    assert.match(t.question?.question ?? '', /integration/);
    assert.match(t.question?.question ?? '', /docs/);
    assert.deepEqual(h.prsMerged, [], 'and the pull request is left for them to finish');
  } finally {
    await h.close();
  }
});

test('checks that pass merge the pull request, and say what was waited for', async () => {
  const h = harness({
    merge: async () => ({
      kind: 'merged',
      results: [{ command: 'integration', ok: true, output: '' }],
    }),
  });
  try {
    standing(h.store, 't1');
    h.store.append('t1', { type: 'merge_requested' });
    await h.orch.idle();

    assert.equal(h.store.ticket('t1').status, 'done');
    assert.deepEqual(h.prsMerged, ['https://example/pr/t1']);
    assert.equal(h.store.eventsFor('t1').filter((e) => e.type === 'pr_checks_run').length, 1);
  } finally {
    await h.close();
  }
});
