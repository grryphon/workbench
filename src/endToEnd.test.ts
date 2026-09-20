import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openStore, type Store } from './store/store.ts';
import { createOrchestrator, reconcile, type Orchestrator } from './orchestrator/loop.ts';
import { createFakeRunner } from './run/fakeRunner.ts';
import { createCheckRunner } from './run/checks.ts';
import { loadAgents } from './agents/load.ts';
import { diff, gitWorkspace, worktreeFor, type GitConfig } from './git/worktree.ts';

const run = promisify(execFile);

/** Written down and committed to. A ticket left in the backlog never starts. */
function queued(store: Store, id: string, title: string, body = ''): void {
  store.append(id, { type: 'ticket_created', title, body });
  store.append(id, { type: 'queued' });
}

type Rig = {
  store: Store;
  orch: Orchestrator;
  cfg: GitConfig;
  prs: string[];
  /** What each stage run was asked to pick back up, in order. */
  resumed: (string | undefined)[];
  close: () => Promise<void>;
};

/**
 * The whole workbench on a real repository with a fake agent: real worktrees,
 * real commits, real diffs, real rules. Only the model service and GitHub are
 * stood in for.
 */
async function rig(checks: string[] = []): Promise<Rig> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'wb-e2e-'));
  const repoRoot = path.join(root, 'repo');
  await fs.mkdir(path.join(repoRoot, 'workbench', 'src'), { recursive: true });

  const git = (...args: string[]) => run('git', args, { cwd: repoRoot });
  await git('init', '-b', 'main');
  await git('config', 'user.email', 'test@example.com');
  await git('config', 'user.name', 'Test');
  await fs.writeFile(path.join(repoRoot, 'workbench', 'src', 'rules.ts'), 'guardrails\n');
  await fs.writeFile(path.join(repoRoot, 'README.md'), '# project\n');
  await git('add', '-A');
  await git('commit', '-m', 'first');

  const cfg: GitConfig = {
    repoRoot,
    worktreeRoot: path.join(root, 'worktrees'),
    base: 'main',
    protectedPaths: ['workbench'],
  };

  const store = openStore(':memory:');
  const prs: string[] = [];
  const resumed: (string | undefined)[] = [];

  // The shipped agent definitions, so what the guard allows here is what it will
  // allow in a real run. Wrapped only to watch what each run was asked to pick
  // back up — the runner itself is untouched.
  const fake = createFakeRunner({
    agents: () => loadAgents([fileURLToPath(new URL('../agents', import.meta.url))]),
    protectedPaths: cfg.protectedPaths,
  });

  const orch = createOrchestrator({
    store,
    // The real workspace on a real repository. Only the code host is stood in for:
    // there is nothing to push to and nothing to merge.
    workspace: gitWorkspace(cfg),
    host: {
      openPr: async (ticket) => {
        const url = `https://example/pr/${ticket.id}`;
        prs.push(url);
        return url;
      },
      verdict: async () => ({ kind: 'pending' }),
      merge: async () => ({ kind: 'merged' }),
    },
    runStage: (args) => {
      resumed.push(args.resume);
      return fake(args);
    },
    // The real check runner on a real worktree: whether the tests pass is the one
    // thing in this loop that must not be stood in for.
    checks: createCheckRunner(checks),
    credentials: async () => ({ ok: true, how: 'a test' }),
    modelFor: () => 'a test model',
    announce: () => {},
  });

  return {
    store,
    orch,
    cfg,
    prs,
    resumed,
    close: async () => {
      await orch.stop();
      store.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test('a ticket goes from created to pull request, doing real work on disk', async () => {
  const r = await rig();
  try {
    queued(r.store, 't1', 'Record the ticket', 'Leave a note in the repository.');

    await r.orch.idle();
    assert.equal(r.store.ticket('t1').status, 'plan_gate', 'it stops for the manager');
    assert.match(r.store.ticket('t1').plan ?? '', /Plan for "Record the ticket"/);

    r.store.append('t1', { type: 'plan_approved' });
    await r.orch.idle();

    const t = r.store.ticket('t1');
    assert.equal(t.status, 'awaiting_verdict');
    assert.deepEqual(r.prs, ['https://example/pr/t1']);

    // The work is really there, on its own branch.
    const wt = worktreeFor(r.cfg, 't1');
    const written = await fs.readFile(path.join(wt.path, 'fake-work', 't1.md'), 'utf8');
    assert.match(written, /# Record the ticket/);

    const changed = await diff(r.cfg, wt);
    assert.match(changed, /fake-work\/t1\.md/);
    assert.doesNotMatch(changed, /workbench\//, 'the workbench is untouched by the ticket');
  } finally {
    await r.close();
  }
});

test('every stage ran, in order, and each one recorded its tool use', async () => {
  const r = await rig();
  try {
    queued(r.store, 't1', 'a thing');
    await r.orch.idle();
    r.store.append('t1', { type: 'plan_approved' });
    await r.orch.idle();

    const events = r.store.eventsFor('t1');
    const stages = events.filter((e) => e.type === 'stage_started').map((e) => e.stage);
    assert.deepEqual(stages, ['plan', 'implement', 'review', 'verify']);

    // The plan called this small, and every stage ran anyway. Scale is a dial on how
    // deep each stage goes, never on whether it happens — deleting two files got the
    // full treatment once, and the answer is a shorter look, not a shorter process.
    assert.equal(r.store.ticket('t1').scale, 'small');

    const tools = events.filter((e) => e.type === 'tool_requested');
    assert.equal(tools.length, 4, 'one recorded tool call per stage');
    assert.ok(
      tools.every((e) => e.type === 'tool_requested' && e.allowed),
      'and none of them was refused',
    );

    // Every event a run emits carries that run's id — so the record says which
    // stage each line came from, rather than leaving it to be inferred from the
    // order. A runner inventing its own id per message is what this catches.
    const runIds = new Set(events.filter((e) => e.type === 'stage_started').map((e) => e.runId));
    assert.equal(runIds.size, 4, 'four runs');
    for (const e of events) {
      if ('runId' in e) assert.ok(runIds.has(e.runId), `${e.type} belongs to a run`);
    }
  } finally {
    await r.close();
  }
});

// Rejection and question handling are state-machine behaviour, tested in
// lifecycle.test.ts as pure transitions and in loop.test.ts as a running loop.
// Repeating them here against a real repository would only re-run git.

test('a real failing check, on a real worktree, sends the work back for nothing', async () => {
  // The whole chain for real: a command actually runs in the actual worktree, its
  // actual exit code decides, and the work goes straight back to the stage that wrote
  // it — no review and no verify bought, so the path that finds a broken test is the
  // cheapest one there is.
  const r = await rig(['echo "2 tests failed" >&2; exit 1']);
  try {
    queued(r.store, 't1', 'a thing');
    await r.orch.idle();
    r.store.append('t1', { type: 'plan_approved' });
    await r.orch.idle();

    const stages = r.store
      .eventsFor('t1')
      .filter((e) => e.type === 'stage_started')
      .map((e) => e.stage);
    assert.deepEqual(
      stages,
      ['plan', 'implement', 'implement', 'implement', 'plan'],
      'the rounds a plan is allowed, and then a new plan — with nobody asked to read it',
    );

    const t = r.store.ticket('t1');
    assert.equal(t.status, 'plan_gate', 'back round to planning once the rounds ran out');
    assert.match(t.rejection ?? '', /2 tests failed/, 'carrying what actually broke');
    assert.deepEqual(r.prs, [], 'and nothing was offered as a pull request');

    const ran = r.store.eventsFor('t1').filter((e) => e.type === 'checks_run');
    assert.equal(ran.length, 3, 'recorded every round, not narrated');
  } finally {
    await r.close();
  }
});

test('a real passing check lets the ticket through to a pull request', async () => {
  const r = await rig(['test -f fake-work/t1.md']);
  try {
    queued(r.store, 't1', 'a thing');
    await r.orch.idle();
    r.store.append('t1', { type: 'plan_approved' });
    await r.orch.idle();

    assert.equal(r.store.ticket('t1').status, 'awaiting_verdict');
    assert.deepEqual(r.prs, ['https://example/pr/t1']);
  } finally {
    await r.close();
  }
});

test('two tickets run side by side without treading on each other', async () => {
  const r = await rig();
  try {
    for (const id of ['t1', 't2']) queued(r.store, id, `ticket ${id}`);
    await r.orch.idle();
    for (const id of ['t1', 't2']) r.store.append(id, { type: 'plan_approved' });
    await r.orch.idle();

    assert.deepEqual(r.prs.sort(), ['https://example/pr/t1', 'https://example/pr/t2']);

    for (const id of ['t1', 't2']) {
      const changed = await diff(r.cfg, worktreeFor(r.cfg, id));
      assert.match(changed, new RegExp(`fake-work/${id}\\.md`));
      assert.doesNotMatch(changed, new RegExp(`fake-work/${id === 't1' ? 't2' : 't1'}\\.md`));
    }
  } finally {
    await r.close();
  }
});

test('a stage the workbench died in the middle of carries on rather than starting again', async () => {
  // Session resume had never actually run: neither real ticket ever asked a
  // question, so nothing had ever been resumed and the whole path was assumed
  // rather than exercised. This is it, end to end, on a real repository.
  const r = await rig();
  try {
    queued(r.store, 't1', 'Record the ticket', 'Leave a note in the repository.');
    await r.orch.idle();
    r.store.append('t1', { type: 'plan_approved' });

    // The workbench being killed mid-stage, as it leaves the database: a run that
    // started, said what conversation it was, and that nothing will ever answer.
    r.store.append('t1', { type: 'stage_started', stage: 'implement', runId: 'r-killed' });
    r.store.append('t1', {
      type: 'session_started',
      runId: 'r-killed',
      sessionId: 'sess-killed',
    });

    assert.deepEqual(reconcile(r.store), ['t1'], 'the next start picks it up');
    const parked = r.store.ticket('t1');
    assert.equal(parked.status, 'blocked', 'and parks it for the manager');
    assert.equal(parked.interrupted, true, 'as stopped rather than as broken');
    assert.equal(parked.session, 'sess-killed', 'holding the run it can carry on from');
    assert.deepEqual(r.resumed, [undefined], 'and nothing has started on its own');

    r.store.append('t1', { type: 'stage_continued' });
    await r.orch.idle();

    assert.deepEqual(
      r.resumed.filter((one) => one !== undefined),
      ['sess-killed'],
      'the implement stage picked that conversation back up, and nothing else did',
    );

    // And it really finished: the work is on disk and the ticket went the rest of
    // the way, so carrying on is a whole stage rather than a flag.
    const t = r.store.ticket('t1');
    assert.equal(t.status, 'awaiting_verdict');
    assert.equal(t.interrupted, false, 'it is no longer waiting to be picked up');
    const wt = worktreeFor(r.cfg, 't1');
    assert.match(
      await fs.readFile(path.join(wt.path, 'fake-work', 't1.md'), 'utf8'),
      /# Record the ticket/,
    );
  } finally {
    await r.close();
  }
});

test('restarting an interrupted stage runs it from the top instead', async () => {
  // The other half of the promise: carrying on is offered, never imposed.
  const r = await rig();
  try {
    queued(r.store, 't1', 'Record the ticket');
    await r.orch.idle();
    r.store.append('t1', { type: 'plan_approved' });
    r.store.append('t1', { type: 'stage_started', stage: 'implement', runId: 'r-killed' });
    r.store.append('t1', {
      type: 'session_started',
      runId: 'r-killed',
      sessionId: 'sess-killed',
    });
    reconcile(r.store);

    r.store.append('t1', { type: 'stage_restarted' });
    await r.orch.idle();

    assert.deepEqual(
      r.resumed.filter((one) => one !== undefined),
      [],
      'nothing was carried over',
    );
    assert.equal(r.store.ticket('t1').status, 'awaiting_verdict', 'and it still finished');
  } finally {
    await r.close();
  }
});

test('each stage commits its work, so the next stage can see it', async () => {
  const r = await rig();
  try {
    queued(r.store, 't1', 'Record it');
    await r.orch.idle();
    r.store.append('t1', { type: 'plan_approved' });
    await r.orch.idle();

    const wt = worktreeFor(r.cfg, 't1');
    const { stdout: log } = await run('git', ['log', '--oneline', 'main..HEAD'], {
      cwd: wt.path,
    });
    assert.match(log, /implement: Record it \(t1\)/, 'the implementation was committed');

    // The whole point: review and verify read the diff, and it must not be empty.
    assert.notEqual(await diff(r.cfg, wt), '', 'the diff the later stages read is not empty');

    const { stdout: dirty } = await run('git', ['status', '--porcelain'], { cwd: wt.path });
    assert.equal(dirty.trim(), '', 'nothing is left uncommitted for the pull request to miss');
  } finally {
    await r.close();
  }
});
