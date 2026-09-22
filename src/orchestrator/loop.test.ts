import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { reconcile, type RunResult } from './loop.ts';
import { create, during, harness, MODELS, ok, waitFor, type Harness } from './harness.ts';
import { openStore } from '../store/store.ts';
import type { EventBody, Stage } from '../domain/events.ts';
import { DEFAULT_POLICY } from '../domain/rules.ts';
import { buildBrief } from '../agents/brief.ts';
import { loadAgents } from '../agents/load.ts';

const agents = loadAgents([fileURLToPath(new URL('../../agents', import.meta.url))]);

test('the loop drives a ticket to the plan gate and then waits', async () => {
  const h = harness();
  try {
    create(h.store);
    await h.orch.idle();

    assert.deepEqual(h.ran, ['plan'], 'it plans, and does not run ahead of the gate');
    assert.equal(h.store.ticket('t1').status, 'plan_gate');
    assert.equal(h.store.ticket('t1').plan, 'plan done');
  } finally {
    await h.close();
  }
});

test('approving the plan carries the ticket through to a pull request', async () => {
  const h = harness();
  try {
    create(h.store);
    await h.orch.idle();

    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(h.ran, ['plan', 'implement', 'review', 'verify']);
    assert.deepEqual(h.prsOpened, ['https://example/pr/t1']);
    assert.equal(h.store.ticket('t1').status, 'awaiting_verdict');
  } finally {
    await h.close();
  }
});

test('a review that does not approve sends the ticket round again', async () => {
  const h = harness({
    stages: {
      review: (attempt) =>
        attempt === 1
          ? { outcome: 'completed', summary: 'found a bug', rejected: 'retries are unbounded' }
          : ok('looks right now'),
    },
    verdict: { kind: 'accepted' },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    // Rejected at review, so it re-plans and stops at the gate a second time.
    assert.deepEqual(h.ran, ['plan', 'implement', 'review', 'plan']);
    const t = h.store.ticket('t1');
    assert.equal(t.status, 'plan_gate');
    assert.equal(t.rejection, 'retries are unbounded', 'the reason reaches the next plan');

    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(h.ran.slice(4), ['implement', 'review', 'verify']);
    assert.equal(h.store.ticket('t1').status, 'done');
  } finally {
    await h.close();
  }
});

test('a question parks the ticket, and the answer resumes that same stage', async () => {
  const h = harness({
    stages: {
      implement: (attempt) =>
        attempt === 1
          ? {
              outcome: 'blocked',
              summary: 'need a decision',
              question: { question: 'which config is live?', reasoning: 'two disagree' },
            }
          : ok('implemented'),
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const blocked = h.store.ticket('t1');
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.question?.question, 'which config is live?');
    assert.deepEqual(h.ran, ['plan', 'implement'], 'nothing runs while it waits');

    h.store.append('t1', { type: 'question_answered', answer: 'the one in etc/' });
    await h.orch.idle();

    assert.deepEqual(h.ran, ['plan', 'implement', 'implement', 'review', 'verify']);
  } finally {
    await h.close();
  }
});

test('answering a question carries on the conversation rather than paying for it twice', async () => {
  // t4 re-planned from scratch after an interruption: $0.16 for a plan that already
  // existed. The stage was re-run, not continued.
  const resumedWith: (string | undefined)[] = [];
  const h = harness({
    runStage: async ({ resume, ticket }) => {
      resumedWith.push(resume);
      return resume === undefined && resumedWith.length === 1
        ? {
            outcome: 'blocked',
            summary: 'waiting on the manager',
            question: { question: 'which config is live?', reasoning: 'two disagree' },
            sessionId: 'sess-abc',
          }
        : ok(`planned, knowing: ${ticket.answer}`);
    },
  });

  try {
    create(h.store);
    await h.orch.idle();
    assert.deepEqual(resumedWith, [undefined], 'the first run has nothing to carry on from');
    assert.equal(h.store.ticket('t1').session, 'sess-abc');

    h.store.append('t1', { type: 'question_answered', answer: 'the one in etc/' });
    await h.orch.idle();

    assert.deepEqual(resumedWith, [undefined, 'sess-abc'], 'the second picks it back up');
    assert.equal(h.store.ticket('t1').status, 'plan_gate');
    assert.equal(h.store.ticket('t1').session, null, 'and it is spent once used');
  } finally {
    await h.close();
  }
});

test('a stage with no conversation to resume simply starts again', async () => {
  // Nothing here may depend on a session existing: it lives outside the workbench,
  // on one machine, and a ticket must still move when it is gone.
  const resumedWith: (string | undefined)[] = [];
  const h = harness({
    runStage: async ({ resume }) => {
      resumedWith.push(resume);
      return resumedWith.length === 1
        ? {
            outcome: 'blocked',
            summary: 'waiting',
            question: { question: 'which?', reasoning: 'unclear' },
            // No sessionId: the runner could not tell us one.
          }
        : ok('planned from the top');
    },
  });

  try {
    create(h.store);
    await h.orch.idle();
    assert.equal(h.store.ticket('t1').session, null);

    h.store.append('t1', { type: 'question_answered', answer: 'this one' });
    await h.orch.idle();

    assert.deepEqual(resumedWith, [undefined, undefined], 'asked to start afresh');
    assert.equal(h.store.ticket('t1').status, 'plan_gate', 'and it still got there');
  } finally {
    await h.close();
  }
});

test('the checks run between implement and review, not after a review is bought', async () => {
  // Where in the cycle they go is the whole of this. Run at the start of verify, a
  // broken test was found only after a review had been paid for; run here, the round
  // that broke it is the round that hears about it.
  const order: string[] = [];
  const h = harness({
    checks: () => {
      order.push('checks');
      return [{ command: 'yarn test', ok: true, output: '131 passing' }];
    },
    runStage: async ({ stage }) => {
      order.push(stage);
      return ok(`${stage} done`);
    },
  });

  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(order, ['plan', 'implement', 'checks', 'review', 'verify']);
  } finally {
    await h.close();
  }
});

test('a second review is handed the round before it, and the first is handed none', async () => {
  // Without this every round reviews from nothing and finds new things at the first
  // round's rate, however many rounds have gone.
  const seen: unknown[] = [];
  let reviews = 0;
  const h = harness({
    runStage: async ({ stage, previously }) => {
      if (stage !== 'review') return ok(`${stage} done`);
      seen.push(previously);
      return ++reviews === 1
        ? { outcome: 'completed', summary: 'not yet', changes: '- retry.ts:14 unbounded' }
        : ok('addressed');
    },
  });

  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(h.ran, ['plan', 'implement', 'review', 'implement', 'review', 'verify']);
    assert.equal(seen[0], undefined, 'the first round has nothing before it to check');
    // The commit the branch stood at when that review looked, not the one the review
    // run itself left behind: what it read was the implement run's work.
    assert.deepEqual(seen[1], { changes: '- retry.ts:14 unbounded', at: 'c0ffee2' });
  } finally {
    await h.close();
  }
});

test('a second implement run is handed what the first said it did, and nobody else is', async () => {
  // A rework round is revising work it was not there for. Without this it rediscovers
  // its own commits by reading the files it wrote them into.
  const seen: [Stage, string | undefined][] = [];
  let reviews = 0;
  const h = harness({
    runStage: async ({ stage, didBefore }) => {
      seen.push([stage, didBefore]);
      if (stage !== 'review') return ok(`${stage} done`);
      return ++reviews === 1
        ? { outcome: 'completed', summary: 'not yet', changes: '- retry.ts:14 unbounded' }
        : ok('addressed');
    },
  });

  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(seen, [
      ['plan', undefined],
      ['implement', undefined],
      ['review', undefined],
      ['implement', 'implement done'],
      ['review', undefined],
      ['verify', undefined],
    ]);
  } finally {
    await h.close();
  }
});

test('a failing standing check is another round of implement, not a new plan', async () => {
  // It used to be a rejection: a new plan, the gate, and a whole cycle — after a
  // review had already been read. It is an objection like any other now, back to the
  // stage that wrote the code, carrying the output it broke on.
  let asked = 0;
  const h = harness({
    checks: () =>
      asked++ === 0
        ? [
            { command: 'yarn test', ok: false, output: '3 tests failed\n  at retry.ts:14' },
            { command: 'yarn typecheck', ok: true, output: '' },
          ]
        : [{ command: 'yarn test', ok: true, output: '131 passing' }],
  });

  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(
      h.ran,
      ['plan', 'implement', 'implement', 'review', 'verify'],
      'nobody was asked to read work that does not pass the suite',
    );

    const sentBack = h.store
      .eventsFor('t1')
      .find((e) => e.type === 'stage_finished' && e.changes !== undefined);
    const changes = sentBack?.type === 'stage_finished' ? (sentBack.changes ?? '') : '';
    assert.match(changes, /yarn test/, 'the next round is told which check');
    assert.match(changes, /3 tests failed[\s\S]*retry\.ts:14/, 'and what it said');
    assert.equal(
      sentBack?.type === 'stage_finished' ? sentBack.rejected : 'missing',
      undefined,
      'a broken test is not a verdict on the approach',
    );

    const t = h.store.ticket('t1');
    assert.equal(t.revisions, 1, 'and it costs a revision, like any other round of comments');
    assert.equal(t.rejection, null);
  } finally {
    await h.close();
  }
});

test('checks that keep failing run out of rounds and buy a new plan', async () => {
  // The cap that holds every other objection holds this one: something that survives
  // being addressed twice is evidence about the approach, not about the execution.
  const h = harness({ checks: [{ command: 'yarn test', ok: false, output: '1 failing' }] });

  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(h.ran, ['plan', 'implement', 'implement', 'implement', 'plan']);

    const t = h.store.ticket('t1');
    assert.equal(t.status, 'plan_gate', 're-planned and stopped at the gate');
    assert.match(t.rejection ?? '', /after 2 attempts to address it/);
    assert.match(t.rejection ?? '', /1 failing/, 'and the next plan is told what broke');
  } finally {
    await h.close();
  }
});

test('what the checks said is on the record, not just in an agent summary', async () => {
  // Whether the tests passed is the most important fact about a ticket. It should be
  // observed and written down, not narrated by something with an opinion.
  const h = harness({ checks: [{ command: 'yarn test', ok: true, output: '131 passing' }] });

  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const ran = h.store.eventsFor('t1').filter((e) => e.type === 'checks_run');
    assert.equal(ran.length, 1, 'once, for the change that was made');
    assert.deepEqual(ran[0]?.type === 'checks_run' ? ran[0].results : [], [
      { command: 'yarn test', ok: true, output: '131 passing' },
    ]);
    assert.equal(
      during(h.store, 't1', 'implement').filter((e) => e.type === 'checks_run').length,
      1,
      'recorded under the run whose work it was',
    );
    assert.equal(h.store.ticket('t1').status, 'awaiting_verdict', 'and it carried on');
  } finally {
    await h.close();
  }
});

test('the passing checks are handed to review and verify so neither runs them again', async () => {
  const seen = new Map<Stage, unknown>();
  const h = harness({
    checks: [{ command: 'yarn test', ok: true, output: '131 passing' }],
    runStage: async ({ stage, checks }) => {
      seen.set(stage, checks);
      return ok(`${stage} done`);
    },
  });

  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const passed = [{ command: 'yarn test', ok: true, output: '131 passing' }];
    assert.deepEqual(seen.get('review'), passed, 'read back from the record, not run again');
    assert.deepEqual(seen.get('verify'), passed);
    assert.equal(seen.get('implement'), undefined, 'the run that makes the change has none yet');
  } finally {
    await h.close();
  }
});

test('with no checks configured the stages are told that, rather than left to assume', async () => {
  const seen = new Map<Stage, unknown>();
  const h = harness({
    runStage: async ({ stage, checks }) => {
      seen.set(stage, checks);
      return ok(`${stage} done`);
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.equal(h.store.eventsFor('t1').filter((e) => e.type === 'checks_run').length, 0);
    assert.deepEqual(h.ran, ['plan', 'implement', 'review', 'verify'], 'every stage still runs');
    assert.deepEqual(seen.get('review'), [], 'and both are told nothing was run');
    assert.deepEqual(seen.get('verify'), []);
  } finally {
    await h.close();
  }
});

test('a stage that throws parks the ticket rather than looping it back to plan', async () => {
  const h = harness({
    stages: {
      implement: () => {
        throw new Error('the model service is down');
      },
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const t = h.store.ticket('t1');
    assert.equal(t.status, 'blocked');
    assert.equal(t.rejection, null, 'a crash is not a rejection');
    assert.deepEqual(h.ran, ['plan', 'implement'], 'it does not retry itself');

    const finished = h.store
      .eventsFor('t1')
      .filter((e) => e.type === 'stage_finished')
      .at(-1);
    assert.equal(finished?.type === 'stage_finished' && finished.outcome, 'failed');
    assert.match(
      finished?.type === 'stage_finished' ? finished.summary : '',
      /model service is down/,
    );
  } finally {
    await h.close();
  }
});

test('no more than the work-in-progress limit run at the same time', async () => {
  const release: (() => void)[] = [];
  let concurrent = 0;
  let peak = 0;

  const h = harness({
    runStage: async () => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      await new Promise<void>((resolve) => release.push(resolve));
      concurrent--;
      return ok('done');
    },
  });
  const queued = () => h.store.tickets().filter((t) => t.status === 'queued').length;

  try {
    for (const id of ['t1', 't2', 't3', 't4']) create(h.store, id);

    await h.orch.tick();
    await waitFor(() => concurrent === 2, 'two runs in flight');
    assert.equal(queued(), 2, 'two wait');

    // Finish one. Its slot should be taken by a ticket that was waiting.
    release.shift()?.();
    await waitFor(() => queued() === 1, 'the freed slot to be refilled');
    assert.equal(concurrent, 2, 'the loop refills the slot rather than leaving it idle');

    await drain();
    assert.equal(peak, 2, 'never more than two at once, across the whole run');
    assert.equal(queued(), 0);
  } finally {
    await drain(); // never leave a run un-released: close() waits for them
    await h.close();
  }

  /** Lets every started run finish, including ones that start while draining. */
  async function drain(): Promise<void> {
    for (let i = 0; i < 100 && (release.length > 0 || concurrent > 0); i++) {
      release.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
});

test('a ticket held behind another does not start, and starts when it is let go', async () => {
  const h = harness();
  try {
    create(h.store, 't1');
    create(h.store, 't2');
    h.store.append('t2', { type: 'waits_for', tickets: ['t1'] });

    await h.orch.idle();
    assert.equal(h.ran.length, 1, 'only the one it is waiting on was planned');
    assert.equal(h.store.ticket('t2').status, 'queued');

    // Its work is offered: nothing more will be committed on it, which is all the
    // ticket behind it was ever waiting for.
    h.store.append('t1', { type: 'pr_opened', url: 'http://pr/1' });
    await h.orch.idle();
    assert.equal(h.store.ticket('t2').status, 'plan_gate');
  } finally {
    await h.close();
  }
});

test('sending a ticket back holds what waits on it again', async () => {
  const h = harness();
  try {
    create(h.store, 't1');
    create(h.store, 't2');
    h.store.append('t2', { type: 'waits_for', tickets: ['t1'] });

    // t1 offers its work, so t2 is free to start.
    h.store.append('t1', { type: 'pr_opened', url: 'http://pr/1' });
    await h.orch.idle();
    assert.equal(h.store.ticket('t2').status, 'plan_gate');

    // Now t1 is sent back, and gets stuck part-way through the rework. It keeps
    // its pull request the whole time.
    h.store.append('t1', { type: 'changes_requested', changes: 'the units are wrong' });
    h.store.append('t1', { type: 'blocked', reason: 'asked you something' });

    // Written, told what it waits for, and only then committed to — the order the
    // API writes them in, and the reason a new ticket cannot start before its
    // condition is on it.
    h.store.append('t3', { type: 'ticket_created', title: 'ticket t3', body: 'do it' });
    h.store.append('t3', { type: 'waits_for', tickets: ['t1'] });
    h.store.append('t3', { type: 'queued' });

    await h.orch.idle();
    // Waiting again, because t1 is committing again — reading `prUrl` for this
    // said it had let go, since a reworked ticket still has one.
    assert.equal(h.store.ticket('t3').status, 'queued', 't3 waits for the rework');
    assert.equal(h.store.ticket('t1').prUrl, 'http://pr/1', 'and t1 kept its pull request');
  } finally {
    await h.close();
  }
});

test('a ticket held behind one that was cancelled is let go, not stranded', async () => {
  const h = harness();
  try {
    create(h.store, 't1');
    create(h.store, 't2');
    h.store.append('t2', { type: 'waits_for', tickets: ['t1'] });
    h.store.append('t1', { type: 'cancelled', reason: 'not now' });

    // Nothing will ever pick t1 up again, so nothing may be left waiting on it:
    // a queue held up by a ticket nobody is working on is the one failure here
    // that has no way out and no way to see it.
    await h.orch.idle();
    assert.equal(h.store.ticket('t2').status, 'plan_gate');
  } finally {
    await h.close();
  }
});

test('a blocked ticket gives up its slot rather than holding it', async () => {
  const h = harness({
    stages: {
      plan: {
        outcome: 'blocked',
        summary: 'waiting',
        question: { question: 'which?', reasoning: 'unclear' },
      },
    },
  });
  try {
    for (const id of ['t1', 't2', 't3', 't4']) create(h.store, id);
    await h.orch.idle();

    // All four get planned two at a time: waiting on the manager occupies no slot.
    assert.equal(h.ran.length, 4);
    assert.equal(h.store.tickets().filter((t) => t.status === 'blocked').length, 4);
    assert.equal(h.store.tickets().filter((t) => t.status === 'queued').length, 0);
  } finally {
    await h.close();
  }
});

test('a ticket that keeps coming back stops for the manager, work intact', async () => {
  // Review never approves, so the ticket loops: plan, implement, review, plan...
  const h = harness({
    stages: { review: { outcome: 'completed', summary: 'no', rejected: 'no' } },
  });
  try {
    create(h.store);

    // The gate stops the ticket every time round, so this needs a manager who keeps
    // approving. That is the case the cap is for: the loop cannot run away by itself.
    for (let i = 0; i < 10; i++) {
      await h.orch.idle();
      if (h.store.ticket('t1').status !== 'plan_gate') break;
      h.store.append('t1', { type: 'plan_approved' });
    }
    await h.orch.idle();

    const ticket = h.store.ticket('t1');
    // Blocked, not gave_up: the work stands and the manager decides what to do
    // with it. Every real ticket the workbench has run died at this point.
    assert.equal(ticket.status, 'blocked');
    assert.match(ticket.question?.question ?? '', /ship what is there/);
    assert.equal(ticket.cycles, DEFAULT_POLICY.maxCycles);
    assert.equal(
      h.ran.filter((s) => s === 'plan').length,
      DEFAULT_POLICY.maxCycles,
      'it planned the allowed number of times and no more',
    );
  } finally {
    await h.close();
  }
});

test('what a failed run spent is recorded, and counts against the ticket', async () => {
  // A failure is often the expensive ending — a budget ceiling, a session limit —
  // so a failure recorded as costing nothing under-counts exactly the runs that
  // cost the most, and the ticket's total is short by the largest amounts.
  const h = harness({
    stages: {
      implement: { outcome: 'failed', summary: 'the run stopped', costUsd: 3 },
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const finished = h.store
      .eventsFor('t1')
      .filter((e) => e.type === 'stage_finished')
      .at(-1);
    assert.equal(finished?.type === 'stage_finished' && finished.outcome, 'failed');
    assert.equal(finished?.type === 'stage_finished' ? finished.costUsd : undefined, 3);
    assert.equal(h.store.ticket('t1').costUsd, 3, 'and it is what the ticket has spent');
  } finally {
    await h.close();
  }
});

test('the loop stops a ticket that has spent its budget', async () => {
  const h = harness({
    stages: {
      plan: {
        outcome: 'completed',
        summary: 'a costly plan',
        costUsd: DEFAULT_POLICY.maxTicketUsd,
      },
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(h.ran, ['plan'], 'implement never started');
    assert.equal(h.store.ticket('t1').status, 'gave_up');
  } finally {
    await h.close();
  }
});

test('cancelling stops a stage that is already running', async () => {
  let sawAbort = false;
  let release: (() => void) | undefined;

  const h = harness({
    runStage: async ({ signal }) => {
      // A real stage is inside the model service here, deaf to everything but this.
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve();
        });
      });
      return { outcome: 'failed', summary: 'the manager stopped this run' };
    },
  });

  try {
    create(h.store);
    void h.orch.tick();
    await waitFor(() => release !== undefined, 'the stage to start');

    h.store.append('t1', { type: 'cancelled', reason: 'changed my mind' });
    await waitFor(() => sawAbort, 'the run to be told to stop');
    await h.orch.idle();

    const ticket = h.store.ticket('t1');
    assert.equal(ticket.status, 'cancelled', 'and the late failure does not un-cancel it');
    assert.equal(ticket.running, false, 'so the slot is free again');
  } finally {
    release?.();
    await h.close();
  }
});

test('a stopped board starts nothing, and starting again picks the ticket up', async () => {
  const h = harness();
  try {
    h.store.setStopped(true);
    create(h.store);
    await h.orch.idle();

    assert.deepEqual(h.ran, [], 'no stage was bought');
    assert.equal(h.store.ticket('t1').status, 'queued', 'it is still waiting its turn');

    h.store.setStopped(false);
    await h.orch.idle();

    assert.deepEqual(h.ran, ['plan'], 'and it goes the moment the board does');
  } finally {
    await h.close();
  }
});

test('interrupting a running stage parks it to be carried on, not to be paid for again', async () => {
  let sawAbort = false;
  let release: (() => void) | undefined;

  const h = harness({
    runStage: async ({ signal, emit, runId }) => {
      // Named the moment the model service names it, as a real run does — this is
      // what an interrupted stage has left to carry on from.
      emit({ type: 'session_started', runId, sessionId: 'sess-abc' });
      await new Promise<void>((resolve) => {
        release = resolve;
        signal.addEventListener('abort', () => {
          sawAbort = true;
          resolve();
        });
      });
      // What a runner really answers an aborted signal with. Left alone it would be
      // recorded as a stage that broke, and a broken stage is bought again.
      return { outcome: 'failed', summary: 'the manager stopped this run' };
    },
  });

  try {
    create(h.store);
    void h.orch.tick();
    await waitFor(() => release !== undefined, 'the stage to start');

    // The second press of STOP: the board is already stopped and the manager is not
    // waiting for what is in flight.
    h.store.setStopped(true);
    assert.deepEqual(h.orch.interrupt(), ['t1'], 'it says what it stopped');
    await waitFor(() => sawAbort, 'the run to be told to stop');
    await h.orch.idle();

    const ticket = h.store.ticket('t1');
    assert.equal(ticket.running, false, 'the slot is free');
    assert.equal(ticket.interrupted, true, 'and the board offers to carry it on');
    assert.equal(ticket.session, 'sess-abc', 'from the conversation it kept');
  } finally {
    release?.();
    await h.close();
  }
});

test('a session limit holds every stage on that model, and lifts by itself', async () => {
  // Thirteen of twenty-three failed runs ended here, and every one of them was
  // restarted by hand after the reset. Another ticket's plan runs on the same model,
  // so it would only spend a stage being told the same thing: it waits too.
  const resets = '2026-09-14T21:30:00.000Z';
  let now = Date.parse('2026-09-14T20:00:00Z');
  const resumedWith: (string | undefined)[] = [];

  const h = harness({
    now: () => now,
    runStage: async ({ resume, stage }) => {
      resumedWith.push(resume);
      return resumedWith.length === 1
        ? {
            outcome: 'interrupted',
            summary: "You've hit your session limit · resets 10:30pm (Europe/London)",
            sessionId: 'sess-abc',
            limitedUntil: resets,
            limitedModel: MODELS.plan,
          }
        : ok(`${stage} done`);
    },
  });

  try {
    create(h.store, 't1');
    await h.orch.idle();

    const parked = h.store.ticket('t1');
    assert.equal(parked.status, 'blocked');
    assert.equal(parked.interrupted, true, 'parked as stopped rather than as broken');
    assert.equal(parked.session, 'sess-abc', 'holding the run to carry on');
    assert.equal(parked.limitedUntil, resets, 'and the time it carries on at');
    assert.equal(parked.limitedModel, MODELS.plan, 'and the model whose capacity ran out');

    create(h.store, 't2');
    await h.orch.idle();
    assert.equal(resumedWith.length, 1, 'nothing else is bought while the limit stands');
    assert.equal(h.store.ticket('t2').status, 'queued');
    // Counted, not merely found: saying it is the point, and saying it on every tick
    // is what `wasLimited` is for.
    const said = (what: RegExp) => h.announced.filter((m) => what.test(m)).length;
    assert.equal(said(/session limit is in force/), 1, 'and the wait is said out loud, once');

    now = Date.parse('2026-09-14T21:30:01Z');
    await h.orch.idle();

    assert.equal(said(/session limit on .+ has lifted/), 1, 'and the lift, once');
    assert.equal(said(/session limit is in force/), 1, 'without saying the wait again');

    assert.ok(
      resumedWith.includes('sess-abc'),
      'the parked stage carries itself on, mid-conversation',
    );
    assert.equal(h.store.ticket('t1').status, 'plan_gate', 'without anyone pressing anything');
    assert.equal(h.store.ticket('t1').limitedUntil, null, 'and the board is not waiting any more');
    assert.equal(h.store.ticket('t2').status, 'plan_gate');
  } finally {
    await h.close();
  }
});

test('a limit on one model does not hold the stages that run on another', async () => {
  // The stages stopped sharing a model: plan is on one, the three that write code on
  // another. A plan that ran out of capacity says nothing about the coding model, so
  // an approved ticket goes on being built while it waits. If the limit really is on
  // the whole account, the implement run gets the same message and parks itself —
  // one run to find that out, against a board that would otherwise stand still.
  const now = Date.parse('2026-09-14T20:00:00Z');

  const h = harness({
    now: () => now,
    runStage: async ({ stage }) =>
      stage === 'plan'
        ? {
            outcome: 'interrupted',
            summary: "You've hit your session limit · resets 10:30pm (Europe/London)",
            sessionId: 'sess-abc',
            limitedUntil: '2026-09-14T21:30:00.000Z',
            limitedModel: MODELS.plan,
          }
        : ok(`${stage} done`),
  });

  try {
    // t2 is past its gate before the limit lands, so what it needs next is implement.
    create(h.store, 't2');
    h.store.append('t2', {
      type: 'stage_finished',
      runId: 'r0',
      outcome: 'completed',
      summary: 'planned',
    });
    h.store.append('t2', { type: 'plan_approved' });

    create(h.store, 't1');
    await h.orch.idle();

    assert.equal(h.store.ticket('t1').limitedUntil, '2026-09-14T21:30:00.000Z', 'the plan waits');
    assert.equal(
      h.store.ticket('t2').status,
      'awaiting_verdict',
      'while the work on the other model was built, reviewed, verified and offered',
    );
    assert.deepEqual(h.ran, ['plan', 'implement', 'review', 'verify']);
  } finally {
    await h.close();
  }
});

test('two models limited at once each hold their own stages, to their own time', async () => {
  // Several tickets can be parked at the same moment on different models, and the
  // resets are whatever each model's window says. Neither is a reason to hold the
  // other, and neither waits for the other's time.
  const planResets = '2026-09-14T21:30:00.000Z';
  const codeResets = '2026-09-14T22:30:00.000Z';
  let now = Date.parse('2026-09-14T20:00:00Z');
  const limited = new Set<Stage>(['plan', 'implement']);

  const h = harness({
    now: () => now,
    runStage: async ({ stage }) =>
      limited.delete(stage)
        ? {
            outcome: 'interrupted',
            summary: "You've hit your session limit · resets (Europe/London)",
            sessionId: `sess-${stage}`,
            limitedUntil: stage === 'plan' ? planResets : codeResets,
            limitedModel: MODELS[stage],
          }
        : ok(`${stage} done`),
  });

  try {
    create(h.store, 't2');
    h.store.append('t2', {
      type: 'stage_finished',
      runId: 'r0',
      outcome: 'completed',
      summary: 'planned',
    });
    h.store.append('t2', { type: 'plan_approved' });

    create(h.store, 't1');
    await h.orch.idle();

    assert.equal(h.store.ticket('t1').limitedUntil, planResets, 'the plan waits for its reset');
    assert.equal(h.store.ticket('t2').limitedUntil, codeResets, 'the implement for a later one');

    // Half past ten: the thinking model is back and the coding model is not.
    now = Date.parse('2026-09-14T21:30:01Z');
    await h.orch.idle();

    assert.equal(h.store.ticket('t1').status, 'plan_gate', 'so the plan carried itself on');
    assert.equal(h.store.ticket('t2').limitedUntil, codeResets, 'and the implement still waits');

    now = Date.parse('2026-09-14T22:30:01Z');
    await h.orch.idle();

    assert.equal(h.store.ticket('t2').status, 'awaiting_verdict', 'each at its own time');
  } finally {
    await h.close();
  }
});

test('a limit left on a ticket that has moved on is over, not carried on for ever', async () => {
  // `stage_continued` is refused for anything but a ticket parked mid-stage, and a
  // refused append still wakes this loop and still leaves the time set — so trying
  // it on a ticket that has gone elsewhere is a tick that appends, wakes itself and
  // appends again, without end.
  let now = Date.parse('2026-09-14T20:00:00Z');
  const h = harness({
    now: () => now,
    runStage: async ({ stage }) =>
      stage === 'plan' && h.store.ticket('t1').limitedUntil === null
        ? {
            outcome: 'interrupted',
            summary: "You've hit your session limit · resets 10:30pm (Europe/London)",
            sessionId: 'sess-abc',
            limitedUntil: '2026-09-14T21:30:00.000Z',
            limitedModel: MODELS.plan,
          }
        : ok(`${stage} done`),
  });

  try {
    create(h.store, 't1');
    await h.orch.idle();
    assert.equal(h.store.ticket('t1').limitedUntil, '2026-09-14T21:30:00.000Z');

    // The run that was given up on reports back after all, and takes the ticket on
    // to the gate. The time it parked with is still on it, and is now nobody's.
    h.store.append('t1', {
      type: 'stage_finished',
      runId: 'r1',
      outcome: 'completed',
      summary: 'planned after all',
    });
    assert.equal(h.store.ticket('t1').status, 'plan_gate');

    now = Date.parse('2026-09-14T21:30:01Z');
    create(h.store, 't2');
    // Settles: under the endless append it never would, and `idle` says so.
    await h.orch.idle();

    assert.equal(
      h.store.eventsFor('t1').filter((e) => e.type === 'stage_continued').length,
      0,
      'nothing is carried on that cannot be',
    );
    assert.equal(h.store.ticket('t1').status, 'plan_gate', 'and the ticket is left where it is');
  } finally {
    await h.close();
  }
});

test('stopping while the standing checks run finds nothing left to abandon', async () => {
  // They run after the agent has answered and after the run has given up its claim on
  // being stoppable, so there is nothing in flight for STOP to reach. What is left is
  // the workbench's own bookkeeping, and the round that has been paid for stands
  // rather than being thrown away at the end of it.
  let interrupted: string[] | undefined;
  let h: Harness;

  h = harness({
    checks: () => {
      if (interrupted === undefined) {
        h.store.setStopped(true);
        interrupted = h.orch.interrupt();
      }
      return [{ command: 'yarn test', ok: true, output: '131 passing' }];
    },
  });

  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(interrupted, [], 'the agent is already done: there is nothing to stop');
    assert.deepEqual(h.ran, ['plan', 'implement'], 'and a stopped board asks for nothing more');

    const t = h.store.ticket('t1');
    assert.equal(t.running, false, 'the slot is free');
    assert.equal(t.interrupted, false, 'nothing was abandoned, so nothing is offered to resume');
    assert.equal(t.status, 'reviewing', 'and the round that was bought is kept');
  } finally {
    await h.close();
  }
});

test('a stage that dies while its work is being checked leaves nothing to stop', async () => {
  // The whole run belongs to the run, the checks at the end of it as much as the
  // agent, and a run that dies in there has to give the name back as surely as one
  // that finishes. Left behind, STOP reports abandoning a run that was already over.
  const h = harness({
    checks: () => {
      throw new Error('the suite could not be run');
    },
  });

  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const t = h.store.ticket('t1');
    assert.equal(t.status, 'blocked', 'the ticket parks on what went wrong');
    assert.match(t.question?.question ?? '', /the suite could not be run/);
    assert.deepEqual(h.orch.interrupt(), [], 'and there is nothing left to stop');
  } finally {
    await h.close();
  }
});

test('a run that broke while stopped does not mark the next stage stopped', async () => {
  // The other half of the leak: STOP reached this run, so its name went into
  // `broken`, and then the run died before the agent. Whatever runs next under that
  // id must not find itself already stopped and be recorded `interrupted` before it
  // has begun — a stage nobody stopped, reported as one that was.
  let firstRefresh = true;
  let h: Harness;

  h = harness({
    refresh: () => {
      if (!firstRefresh) return { kind: 'up-to-date' };
      firstRefresh = false;
      h.store.setStopped(true);
      h.orch.interrupt();
      throw new Error('could not bring the base in');
    },
  });

  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.equal(h.store.ticket('t1').status, 'blocked', 'the run that broke parked it');

    // Started again the way the manager starts one: the board goes back on, and the
    // ticket is put back into the stage it stopped in.
    h.store.setStopped(false);
    h.store.append('t1', { type: 'stage_restarted' });
    await h.orch.idle();

    assert.ok(h.ran.includes('implement'), 'the stage runs');
    const finished = h.store
      .eventsFor('t1')
      .filter((e) => e.type === 'stage_finished' && e.outcome === 'interrupted');
    assert.deepEqual(finished, [], 'and nothing is recorded as stopped');
    assert.equal(h.store.ticket('t1').status, 'awaiting_verdict', 'it carries on to the end');
  } finally {
    await h.close();
  }
});

test('a ticket left running by a crash is picked up rather than wedged', async () => {
  const store = openStore(':memory:');
  try {
    create(store);
    store.append('t1', { type: 'stage_started', stage: 'implement', runId: 'r1' });
    store.append('t1', { type: 'session_started', runId: 'r1', sessionId: 'sess-abc' });
    assert.equal(store.ticket('t1').running, true, 'nothing will ever finish this run');

    assert.deepEqual(reconcile(store), ['t1']);

    const ticket = store.ticket('t1');
    assert.equal(ticket.running, false, 'it no longer holds a slot for ever');
    assert.equal(ticket.status, 'blocked', 'and it shows up as needing the manager');
    assert.equal(ticket.interrupted, true, 'as stopped rather than as broken');
    assert.equal(ticket.session, 'sess-abc', 'holding the run it can carry on from');
    assert.deepEqual(reconcile(store), [], 'a second start has nothing left to pick up');
  } finally {
    store.close();
  }
});

test('continuing an interrupted stage runs it on the conversation it had', async () => {
  // Everything an interrupted run spent used to be spent again from the top, and
  // restarting is routine now: it is how an update is picked up.
  const resumedWith: (string | undefined)[] = [];
  const h = harness({
    runStage: async ({ resume }) => {
      resumedWith.push(resume);
      return ok('planned');
    },
  });

  try {
    create(h.store);
    h.store.append('t1', { type: 'stage_started', stage: 'plan', runId: 'r1' });
    h.store.append('t1', { type: 'session_started', runId: 'r1', sessionId: 'sess-abc' });
    assert.deepEqual(reconcile(h.store), ['t1']);

    h.store.append('t1', { type: 'stage_continued' });
    await h.orch.idle();

    assert.deepEqual(resumedWith, ['sess-abc'], 'it picked the run back up');
    assert.equal(h.store.ticket('t1').status, 'plan_gate', 'and the stage finished');
  } finally {
    await h.close();
  }
});

test('restarting an interrupted stage runs it from the top instead', async () => {
  const resumedWith: (string | undefined)[] = [];
  const h = harness({
    runStage: async ({ resume }) => {
      resumedWith.push(resume);
      return ok('planned');
    },
  });

  try {
    create(h.store);
    h.store.append('t1', { type: 'stage_started', stage: 'plan', runId: 'r1' });
    h.store.append('t1', { type: 'session_started', runId: 'r1', sessionId: 'sess-abc' });
    reconcile(h.store);

    h.store.append('t1', { type: 'stage_restarted' });
    await h.orch.idle();

    assert.deepEqual(resumedWith, [undefined], 'nothing carried over');
  } finally {
    await h.close();
  }
});

test('changes review asked for reach implement again however a stuck run is picked up', async () => {
  // t19: review asked for two things, the implement run answering them stopped to ask a
  // question, and the manager restarted it. The restart's brief had no list in it, the
  // run found nothing to do, and a second review was bought to say neither was touched.
  const question = { question: 'Edit is refused — how?', reasoning: 'no tool to write with' };
  const cases: { how: string; stuck: RunResult; move: EventBody; resume?: string }[] = [
    {
      how: 'restarted',
      stuck: { outcome: 'blocked', summary: 'waiting on the manager', question },
      move: { type: 'stage_restarted' },
    },
    {
      how: 'answered, with no conversation to resume',
      stuck: { outcome: 'blocked', summary: 'waiting on the manager', question },
      move: { type: 'question_answered', answer: 'use the one in etc/' },
    },
    {
      // A resumed run is sent no brief, but one that cannot be picked back up falls
      // back to the top and builds it from this same ticket.
      how: 'answered, resuming its conversation',
      stuck: { outcome: 'blocked', summary: 'waiting on the manager', question, sessionId: 's-1' },
      move: { type: 'question_answered', answer: 'use the one in etc/' },
      resume: 's-1',
    },
    {
      how: 'continued, with no conversation to resume',
      stuck: { outcome: 'interrupted', summary: 'the workbench stopped' },
      move: { type: 'stage_continued' },
    },
  ];

  for (const { how, stuck, move, resume } of cases) {
    const briefs: string[] = [];
    const resumedWith: (string | undefined)[] = [];
    const runs = new Map<Stage, number>();
    const h = harness({
      runStage: async (args) => {
        const n = (runs.get(args.stage) ?? 0) + 1;
        runs.set(args.stage, n);
        if (args.stage === 'review' && n === 1) {
          return {
            outcome: 'completed',
            summary: 'two things',
            changes: '- retry.ts:14 the backoff is unbounded',
          };
        }
        if (args.stage !== 'implement' || n === 1) return ok(`${args.stage} done`);
        briefs.push(buildBrief({ ticket: args.ticket, agent: agents.implement, worktree: '/w' }));
        resumedWith.push(args.resume);
        return n === 2 ? stuck : ok('both fixed');
      },
    });

    try {
      create(h.store);
      await h.orch.idle();
      h.store.append('t1', { type: 'plan_approved' });
      await h.orch.idle();
      assert.equal(h.store.ticket('t1').status, 'blocked', `${how}: parked mid-round`);
      assert.match(briefs[0] ?? '', /the backoff is unbounded/, `${how}: the first run had it`);

      h.store.append('t1', move);
      await h.orch.idle();

      assert.equal(briefs.length, 2, `${how}: implement ran again`);
      assert.equal(resumedWith[1], resume, `${how}: on the conversation it should have`);
      assert.match(briefs[1] ?? '', /## Changes to make/, `${how}: and was told what to change`);
      assert.match(briefs[1] ?? '', /the backoff is unbounded/, how);
      assert.deepEqual(
        h.ran,
        ['plan', 'implement', 'review', 'implement', 'implement', 'review', 'verify'],
        `${how}: and one review of the fix was enough`,
      );
    } finally {
      await h.close();
    }
  }
});

test('being logged out pauses the board rather than burning it', async () => {
  let loggedIn = false;
  const h = harness({
    credentials: () =>
      loggedIn
        ? { ok: true, how: 'a test' }
        : { ok: false, why: 'the Claude CLI is not logged in', fix: 'run: claude setup-token' },
  });

  try {
    for (const id of ['t1', 't2']) create(h.store, id);
    await h.orch.idle();

    // The point of the whole design: nothing was attempted, so nothing was spent.
    assert.deepEqual(h.ran, [], 'no stage ran');
    for (const id of ['t1', 't2']) {
      const t = h.store.ticket(id);
      assert.equal(t.status, 'queued', 'still waiting, not blocked and not failed');
      assert.equal(t.cycles, 0, 'no cycle consumed');
      assert.equal(t.costUsd, 0, 'nothing spent');
    }
    assert.equal(
      h.store.eventsFor('t1').length,
      2,
      'nothing was written down but the ticket and the decision to do it',
    );
    assert.equal(h.announced.length, 1, 'said once, not once per ticket per tick');
    assert.match(h.announced[0] ?? '', /paused[\s\S]*setup-token/);

    // The same news for anyone who was not watching the terminal.
    assert.deepEqual(h.orch.paused(), {
      why: 'the Claude CLI is not logged in',
      fix: 'run: claude setup-token',
      resumes: true,
    });

    // Logging back in needs no restart and nothing cleaned up.
    loggedIn = true;
    await h.orch.idle();

    assert.deepEqual(h.ran, ['plan', 'plan'], 'both tickets picked themselves up');
    assert.equal(h.store.ticket('t1').status, 'plan_gate');
    assert.equal(h.announced.length, 2);
    assert.match(h.announced[1] ?? '', /carrying on/);
    assert.equal(h.orch.paused(), undefined, 'and the board stops saying it is paused');
  } finally {
    await h.close();
  }
});

test('losing credentials mid-flight stops the next stage, not the current ticket', async () => {
  let loggedIn = true;
  const h = harness({
    credentials: () =>
      loggedIn ? { ok: true, how: 'a test' } : { ok: false, why: 'expired', fix: 'log in' },
    stages: {
      plan: () => {
        // The token dies while the plan is running.
        loggedIn = false;
        return { outcome: 'completed', summary: 'the plan', costUsd: 0.2 };
      },
    },
  });

  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(h.ran, ['plan'], 'implement never started');
    const t = h.store.ticket('t1');
    assert.equal(t.status, 'implementing', 'it is waiting to implement, not broken');
    assert.equal(t.costUsd, 0.2, 'and it kept the record of what it had already spent');
    assert.deepEqual(h.orch.paused(), { why: 'expired', fix: 'log in', resumes: true });
  } finally {
    await h.close();
  }
});

test('a refused credential stops the board, not just the ticket that found out', async () => {
  // Presence is not acceptance: the check said "Ready" and the API said 401. Without
  // this, the workbench works through the queue spending a stage on each ticket to
  // learn the same thing.
  const h = harness({
    stages: {
      plan: {
        outcome: 'failed',
        summary:
          'Claude Code returned an error result: Failed to authenticate. API Error: 401 OAuth access token is invalid.',
      },
    },
  });

  try {
    for (const id of ['t1', 't2', 't3']) create(h.store, id);
    await h.orch.idle();

    // Everything already in flight when the answer arrives pays for it, so the
    // blast radius is the work-in-progress limit rather than the whole queue.
    assert.equal(h.ran.length, DEFAULT_POLICY.wipLimit, 'only what was already running');
    assert.equal(h.store.ticket('t3').status, 'queued', 'the queue behind it was spared');
    const said = h.announced.at(-1) ?? '';
    assert.match(
      said,
      /paused[\s\S]*401[\s\S]*CLAUDE_CODE_OAUTH_TOKEN/,
      'says what and how to fix',
    );
    assert.doesNotMatch(
      said,
      /start on their own/,
      'and does not promise a resume that cannot happen: a refused credential has to be replaced',
    );

    // Sticky: the local check still finds a credential, because there is one. Only a
    // real call knows it is refused, so re-checking must not undo the stop.
    const ranBefore = h.ran.length;
    await h.orch.idle();
    assert.equal(h.ran.length, ranBefore, 'and it stays stopped');

    // And the board is told the same, including that this one will not resume itself.
    const shown = h.orch.paused();
    assert.match(shown?.why ?? '', /401/);
    assert.match(shown?.fix ?? '', /CLAUDE_CODE_OAUTH_TOKEN/);
    assert.equal(shown?.resumes, false);
  } finally {
    await h.close();
  }
});

test('a conflict at the start of a stage is handed to the stage, not to the manager', async () => {
  const handed: { stage: Stage; paths: string[]; with?: string }[] = [];
  const h = harness({
    refresh: (id) =>
      id === 't1' && handed.length === 0
        ? {
            kind: 'conflicted',
            base: 'newbase',
            paths: ['src/rules.ts'],
            // The merge is still going, so the branch has not moved and nothing has
            // landed on it: the ref that stopped it is the one still on disk.
            with: 'newbase',
            merged: [],
            commit: 'head0001',
            merging: true,
          }
        : { kind: 'up-to-date' },
    runStage: async ({ stage, conflict }) => {
      if (conflict) handed.push({ stage, paths: conflict.paths, with: conflict.with });
      return ok(`${stage} done`);
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    // No branch named: what a stage start brings in is the base and nothing else, so
    // the sha the brief gives is what the merge is against.
    assert.deepEqual(handed, [{ stage: 'implement', paths: ['src/rules.ts'], with: undefined }]);
    const conflicted = during(h.store, 't1', 'implement').filter((e) => e.type === 'conflicted');
    assert.equal(conflicted.length, 1, 'recorded on the ticket, with what clashed');
    assert.deepEqual(conflicted[0]?.type === 'conflicted' ? conflicted[0].paths : [], [
      'src/rules.ts',
    ]);

    // The whole point: the stage runs, and resolving it is part of the run rather
    // than something a person is asked about a day later.
    assert.deepEqual(h.ran, ['plan', 'implement', 'review', 'verify']);
    assert.ok(
      h.committed.some((c) => c.startsWith('t1: implement')),
      'and its work is committed',
    );
    assert.equal(h.store.ticket('t1').status, 'awaiting_verdict');
  } finally {
    await h.close();
  }
});

test('a merge verify was handed is checked once verify has resolved it', async () => {
  // The results in its brief are from the implement run, and this merge came after
  // them. Nothing else will ask: `open_pr` refreshes a branch that is by then up to
  // date and runs nothing, so the change most likely to break the suite would be the
  // one offered without it ever being run against what it merged.
  let refreshes = 0;
  let asked = 0;
  const order: string[] = [];
  const h = harness({
    refresh: () =>
      ++refreshes === 2
        ? {
            kind: 'conflicted',
            base: 'newbase',
            paths: ['src/rules.ts'],
            // The merge is still going, so the branch has not moved and nothing has
            // landed on it: the ref that stopped it is the one still on disk.
            with: 'newbase',
            merged: [],
            commit: 'head0001',
            merging: true,
          }
        : { kind: 'up-to-date' },
    // Passing for the work implement left, failing once the merge is on top of it:
    // the clash a resolution makes silently is the one worth finding.
    checks: () => {
      order.push('checks');
      return asked++ === 0
        ? [{ command: 'yarn test', ok: true, output: '' }]
        : [{ command: 'yarn test', ok: false, output: 'rules.test.ts: 1 failing' }];
    },
    runStage: async ({ stage }) => {
      order.push(stage);
      return ok(`${stage} done`);
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(
      order.slice(0, 6),
      ['plan', 'implement', 'checks', 'review', 'verify', 'checks'],
      'asked of the tree the stage resolved, not the one it was given',
    );
    assert.equal(
      during(h.store, 't1', 'verify').filter((e) => e.type === 'checks_run').length,
      1,
      'and what they said is on the ticket',
    );

    assert.match(
      h.store.ticket('t1').rejection ?? '',
      /1 failing/,
      'a suite the merge broke sends the work back, with the failure itself',
    );
    assert.deepEqual(
      order.slice(6),
      ['plan'],
      'to a new plan rather than to a pull request nobody ran the suite against',
    );
    assert.deepEqual(h.prsOpened, []);
  } finally {
    await h.close();
  }
});

test('a base that merged in at the start of verify is checked before the work is offered', async () => {
  // The quiet one: no conflict, nothing for a stage to resolve, the base simply goes
  // in and verify runs on code the suite has not been run against — the results in its
  // brief are the implement run's, from before the merge. And nothing downstream asks
  // either, because this merge is exactly what makes `open_pr` find a branch already
  // up to date and run nothing.
  let refreshes = 0;
  let asked = 0;
  const order: string[] = [];
  const seen = new Map<Stage, unknown>();
  const h = harness({
    refresh: () =>
      ++refreshes === 2
        ? { kind: 'merged', base: 'newbase', commit: 'merge01', merged: ['newbase'] }
        : { kind: 'up-to-date' },
    checks: () => {
      order.push('checks');
      return asked++ === 0
        ? [{ command: 'yarn test', ok: true, output: '' }]
        : [{ command: 'yarn test', ok: false, output: 'rules.test.ts: 1 failing' }];
    },
    runStage: async ({ stage, checks }) => {
      order.push(stage);
      seen.set(stage, checks);
      return ok(`${stage} done`);
    },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    assert.deepEqual(
      order.slice(0, 6),
      ['plan', 'implement', 'checks', 'review', 'verify', 'checks'],
      'the base that came in silently is asked about once the stage is over',
    );
    assert.equal(
      during(h.store, 't1', 'verify').filter((e) => e.type === 'checks_run').length,
      1,
      'and what they said is on the ticket',
    );
    assert.deepEqual(
      seen.get('verify'),
      [],
      'and the implement run’s results are not offered as output of a tree that has moved',
    );
    assert.match(
      h.store.ticket('t1').rejection ?? '',
      /1 failing/,
      'a suite the new base broke sends the work back, with the failure itself',
    );
    assert.deepEqual(h.prsOpened, [], 'rather than to a pull request nobody ran it against');
  } finally {
    await h.close();
  }
});

test('the base a resolved merge brought in is recorded when the stage commits it', async () => {
  // Until the commit there is nothing on the branch to move the base to, and after
  // it there had better be: the diff every later stage reads is taken from the
  // ticket's base, so an old one shows the merged-in work as this ticket's own.
  let refreshes = 0;
  const h = harness({
    refresh: () =>
      refreshes++ === 0
        ? {
            kind: 'conflicted',
            base: 'newbase',
            paths: ['src/rules.ts'],
            // The merge is still going, so the branch has not moved and nothing has
            // landed on it: the ref that stopped it is the one still on disk.
            with: 'newbase',
            merged: [],
            commit: 'head0001',
            merging: true,
          }
        : { kind: 'up-to-date' },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const refreshed = during(h.store, 't1', 'implement').filter((e) => e.type === 'refreshed');
    assert.equal(refreshed.length, 1, 'the merge is on the branch, so the base has moved');
    assert.equal(h.store.ticket('t1').base, 'newbase');

    // The merge commit is named twice — by the refresh and by the stage that made
    // it — and is one commit.
    const merge = refreshed[0]?.type === 'refreshed' ? refreshed[0].commit : '';
    assert.deepEqual(
      h.store.ticket('t1').commits.filter((c) => c === merge),
      [merge],
    );
  } finally {
    await h.close();
  }
});

test('a stage that leaves the merge unfinished is blocked, and commits nothing', async () => {
  const h = harness({
    refresh: () => ({
      kind: 'conflicted',
      base: 'newbase',
      paths: ['src/rules.ts'],
      with: 'newbase',
      merged: [],
      commit: 'head0001',
      merging: true,
    }),
    unresolved: (paths) => [...paths],
    stages: { implement: ok('rewrote the retry loop') },
  });
  try {
    create(h.store);
    await h.orch.idle();
    h.store.append('t1', { type: 'plan_approved' });
    await h.orch.idle();

    const ticket = h.store.ticket('t1');
    assert.equal(ticket.status, 'blocked');
    assert.deepEqual(h.ran, ['plan', 'implement'], 'and the ticket goes no further');

    assert.deepEqual(
      h.committed.filter((c) => c.includes('implement')),
      [],
      'committing would put the markers on the branch as though they were work',
    );
    const finished = h.store.eventsFor('t1').findLast((e) => e.type === 'stage_finished');
    assert.equal(finished?.type === 'stage_finished' ? finished.outcome : '', 'blocked');
    const summary = finished?.type === 'stage_finished' ? finished.summary : '';
    assert.match(summary, /src\/rules\.ts/, 'saying what is unfinished');
    assert.match(summary, /rewrote the retry loop/, 'and keeping what the run said it did');
  } finally {
    await h.close();
  }
});
