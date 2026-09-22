import { test } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApi, type ApiDeps } from './server.ts';
import { createClient, type Client } from './client.ts';
import { deleteDoc } from './documents.ts';
import { openStore, type Store } from '../store/store.ts';
import { loadSkills, parseSkill } from '../agents/load.ts';
import { CONFIG_FILE, loadConfig, type Config } from '../config.ts';
import type { Proposal } from '../domain/events.ts';
import type { ChatRunner } from '../run/chat.ts';
import { PRESET_VALUES } from './presets.ts';
import type { Setting } from './settings.ts';

/**
 * A throwaway workbench home, of the shape `wb init` leaves behind: the workbench's
 * own agents copied in, and a skill of the project's own.
 *
 * The skill is written here rather than copied from the workbench, whose one shipped
 * skill is about naming a ticket — how a repository writes Python is that repository's
 * to say. Copying them was what tied these tests to this directory being the
 * workbench's own.
 */
function scratchConfig() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-api-'));
  fs.writeFileSync(path.join(home, CONFIG_FILE), '{}');
  const own = fileURLToPath(new URL('..', import.meta.url));
  fs.cpSync(path.join(own, '..', 'agents'), path.join(home, 'agents'), { recursive: true });

  fs.mkdirSync(path.join(home, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'here' }),
  );
  fs.mkdirSync(path.join(home, 'skills', 'writing-python'), { recursive: true });
  fs.writeFileSync(
    path.join(home, 'skills', 'writing-python', 'SKILL.md'),
    '---\nname: writing-python\ndescription: How Python is written in this repository.\n---\n\n# Python\n',
  );
  return loadConfig(home);
}

/** A real server on an ephemeral port, with a real client talking to it. */
async function withApi(
  fn: (wb: Client, store: Store, config: Config, base: string) => Promise<void>,
  deps: ApiDeps = {},
): Promise<void> {
  const store = openStore(':memory:');
  const config = scratchConfig();
  const api = createApi(store, config, deps);
  const port = await api.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(createClient(base), store, config, base);
  } finally {
    await api.close();
    store.close();
    fs.rmSync(config.home, { recursive: true, force: true });
  }
}

test('a ticket can be created and read back over HTTP', async () => {
  await withApi(async (wb) => {
    const created = await wb.create('Add a retry', 'It gives up too early.');
    assert.equal(created.id, 't1');
    assert.equal(created.status, 'backlog');

    const { ticket, events } = await wb.ticket('t1');
    assert.equal(ticket.title, 'Add a retry');
    assert.deepEqual(
      events.map((e) => e.type),
      ['ticket_created'],
    );
  });
});

test('ids keep counting up', async () => {
  await withApi(async (wb) => {
    await wb.create('one', '');
    await wb.create('two', '');
    const tickets = await wb.tickets();
    assert.deepEqual(
      tickets.map((t) => t.id),
      ['t1', 't2'],
    );
  });
});

test('the manager can approve, reject and answer through the API', async () => {
  await withApi(async (wb, store) => {
    await wb.create('a thing', '');
    store.append('t1', { type: 'stage_started', stage: 'plan', runId: 'r1' });
    store.append('t1', {
      type: 'stage_finished',
      runId: 'r1',
      outcome: 'completed',
      summary: 'the plan',
    });

    await wb.approve('t1');
    assert.equal((await wb.ticket('t1')).ticket.status, 'implementing');

    await wb.reject('t1', 'wrong problem');
    const sentBack = (await wb.ticket('t1')).ticket;
    assert.equal(sentBack.status, 'planning');
    assert.equal(sentBack.rejection, 'wrong problem');
  });
});

test('answering a blocked ticket resumes it', async () => {
  await withApi(async (wb, store) => {
    await wb.create('a thing', '');
    store.append('t1', { type: 'stage_started', stage: 'plan', runId: 'r1' });
    store.append('t1', {
      type: 'question_asked',
      runId: 'r1',
      question: 'which config?',
      reasoning: 'two disagree',
    });
    store.append('t1', {
      type: 'stage_finished',
      runId: 'r1',
      outcome: 'blocked',
      summary: 'waiting',
    });
    assert.equal((await wb.ticket('t1')).ticket.status, 'blocked');

    await wb.answer('t1', 'the one in etc/');
    const resumed = (await wb.ticket('t1')).ticket;
    assert.equal(resumed.status, 'planning');
    assert.equal(resumed.question, null);
  });
});

test('an interrupted ticket can be carried on, or restarted from the top', async () => {
  await withApi(async (wb, store) => {
    /** What `reconcile` leaves behind for a stage the workbench was stopped in. */
    const stoppedMidStage = () => {
      store.append('t1', { type: 'stage_started', stage: 'plan', runId: 'r1' });
      store.append('t1', { type: 'session_started', runId: 'r1', sessionId: 'sess-abc' });
      store.append('t1', {
        type: 'stage_finished',
        runId: 'interrupted',
        outcome: 'interrupted',
        summary: 'the workbench stopped while this stage was running',
        sessionId: 'sess-abc',
      });
    };

    await wb.create('a thing', '');
    stoppedMidStage();
    const parked = (await wb.ticket('t1')).ticket;
    assert.equal(parked.status, 'blocked');
    assert.equal(parked.interrupted, true, 'stopped, not broken');

    await wb.carryOn('t1');
    const carrying = (await wb.ticket('t1')).ticket;
    assert.equal(carrying.status, 'planning');
    assert.equal(carrying.session, 'sess-abc', 'with the run it stopped in the middle of');

    // And the other way round: restarting is still there, and still throws it away.
    stoppedMidStage();
    await wb.restart('t1');
    assert.equal((await wb.ticket('t1')).ticket.session, null);
  });
});

test('asking for the merge records it, and only where there is an offer to merge', async () => {
  await withApi(async (wb, store) => {
    await wb.create('a thing', '');
    await assert.rejects(() => wb.merge('t1'), /no pull request to merge/);

    store.append('t1', { type: 'pr_opened', url: 'https://example/pr/1' });
    const asked = await wb.merge('t1');
    assert.equal(asked.mergeRequested, true, 'the orchestrator picks it up from here');
    assert.equal(asked.status, 'awaiting_verdict', 'the API merges nothing itself');

    // A ticket sent back keeps its `prUrl` and is being worked on again: merging
    // it would land whatever the rework has got to so far.
    store.append('t1', { type: 'changes_requested', changes: 'rename it' });
    await assert.rejects(() => wb.merge('t1'), /no pull request to merge/);
  });
});

test('a merge takes no method, and one an older client sends is ignored', async () => {
  await withApi(async (wb, store, _config, base) => {
    await wb.create('a thing', '');
    store.append('t1', { type: 'pr_opened', url: 'https://example/pr/1' });

    assert.equal((await wb.merge('t1')).mergeRequested, true);

    // A client from when there was a choice gets the one merge there is, rather
    // than a refusal it can do nothing about.
    const older = await fetch(`${base}/tickets/t1/merge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'squash' }),
    });
    assert.equal(older.status, 200);
    assert.equal(store.ticket('t1').mergeRequested, true);
  });
});

test('the work-in-progress limit is readable and settable', async () => {
  await withApi(async (wb) => {
    assert.equal((await wb.policy()).wipLimit, 2);
    assert.equal((await wb.setPolicy({ wipLimit: 3 })).wipLimit, 3);
    assert.equal((await wb.policy()).wipLimit, 3, 'and it survives the round trip');
  });
});

test('the analytics are read off the whole log, across every ticket', async () => {
  await withApi(async (wb, store) => {
    await wb.create('feature: a thing', '');
    store.append('t1', { type: 'stage_started', stage: 'plan', runId: 'r1' });
    store.append('t1', {
      type: 'stage_finished',
      runId: 'r1',
      outcome: 'completed',
      summary: 'planned',
      costUsd: 2,
    });
    store.append('t1', { type: 'verdict', verdict: 'accepted' });
    await wb.create('fix: another', '');

    const { headline, money } = await wb.analytics();
    assert.equal(headline.tickets, 2);
    assert.equal(headline.accepted, 1);
    assert.equal(headline.totalUsd, 2);
    assert.deepEqual(headline.dearest, { id: 't1', title: 'feature: a thing', costUsd: 2 });
    assert.deepEqual(
      money.byStage.find((s) => s.label === 'plan'),
      { label: 'plan', value: 2 },
    );
  });
});

test('bad requests are refused with a reason, not a stack trace', async () => {
  await withApi(async (wb, store) => {
    await assert.rejects(() => wb.create('', ''), /needs a title/);

    await wb.create('a thing', '');
    await assert.rejects(() => wb.reject('t1', '   '), /say why/);
    await assert.rejects(() => wb.answer('t1', ''), /answer is needed/);
    await assert.rejects(() => wb.ticket('nope'), /no ticket nope/);
    await assert.rejects(() => wb.approve('nope'), /no ticket nope/);

    // Carrying on is only for a ticket the workbench stopped mid-run. Anywhere
    // else there is no run to come back to, and the refusal says which of the two
    // moves was the one wanted rather than appearing to work.
    await assert.rejects(() => wb.carryOn('t1'), /no run to carry on, so restart/);

    store.append('t1', { type: 'stage_started', stage: 'plan', runId: 'r1' });
    store.append('t1', {
      type: 'question_asked',
      runId: 'r1',
      question: 'which config?',
      reasoning: 'two disagree',
    });
    store.append('t1', {
      type: 'stage_finished',
      runId: 'r1',
      outcome: 'blocked',
      summary: 'waiting',
      sessionId: 'sess-abc',
    });
    const asked = await wb.ticket('t1');
    await assert.rejects(() => wb.carryOn('t1'), /waiting on an answer/);
    assert.deepEqual(await wb.ticket('t1'), asked, 'and nothing was written down');
  });
});

test('a client with nothing to talk to says where it tried', async () => {
  // The address, not the advice. Quoting the whole sentence back made this fail when
  // the advice changed to a command that exists, which is the edit it should welcome.
  const wb = createClient('http://127.0.0.1:1');
  await assert.rejects(() => wb.tickets(), /127\.0\.0\.1:1/);
});

/**
 * Something on the port that is not a workbench, answering every route the same
 * way. A dev server's SPA fallback is the one that bites: it is the reason a route
 * left out of the proxy list looks like a reply rather than a mistake.
 */
async function withPretender(status: number, fn: (wb: Client) => Promise<void>): Promise<void> {
  const pretender = http.createServer((_req, res) => {
    res.writeHead(status, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Workbench</title>');
  });
  await new Promise<void>((ok) => pretender.listen(0, '127.0.0.1', ok));
  try {
    const { port } = pretender.address() as AddressInfo;
    await fn(createClient(`http://127.0.0.1:${port}`));
  } finally {
    await new Promise<void>((ok) => pretender.close(() => ok()));
  }
}

test('a page where an answer should be is refused, not read as an empty one', async () => {
  // The failure this replaces was silent: 200 with an unparseable body became {},
  // every field came back undefined, and the caller was told it had succeeded.
  await withPretender(200, async (wb) => {
    await assert.rejects(() => wb.docs('agent'), /text\/html/);
  });
});

test('a failure that carries no reason is reported by its status', async () => {
  // The other side of it: an error reply owes us nothing parseable, and falling
  // back to the status is what keeps a crash behind a proxy legible.
  await withPretender(503, async (wb) => {
    await assert.rejects(() => wb.tickets(), /503/);
  });
});

test('the event stream carries events as they are appended', async () => {
  const store = openStore(':memory:');
  const api = createApi(store, scratchConfig());
  const port = await api.listen(0);

  try {
    const response = await fetch(`http://127.0.0.1:${port}/events`);
    const reader = response.body!.getReader();
    await reader.read(); // the ": connected" preamble

    store.append('t1', { type: 'ticket_created', title: 'streamed', body: '' });

    const { value } = await reader.read();
    const text = new TextDecoder().decode(value);
    assert.match(text, /^data: /);

    const event = JSON.parse(text.replace(/^data: /, '').trim()) as Record<string, unknown>;
    assert.equal(event['type'], 'ticket_created');
    assert.equal(event['ticketId'], 't1');

    await reader.cancel();
  } finally {
    await api.close();
    store.close();
  }
});

test('a ticket can be cancelled, whatever it was doing', async () => {
  await withApi(async (wb) => {
    const ticket = await wb.create('a thing', 'do it');
    await wb.cancel(ticket.id, 'changed my mind');

    const { ticket: stopped, events } = await wb.ticket(ticket.id);
    assert.equal(stopped.status, 'cancelled');
    assert.ok(
      events.some((e) => e.type === 'cancelled' && e.reason === 'changed my mind'),
      'the reason is on the record',
    );
  });
});

test('a ticket can carry on from one that left work behind', async () => {
  await withApi(async (wb, store) => {
    await wb.create('the first attempt', '');
    await assert.rejects(() => wb.create('carry on', '', { from: 't1' }), /left no work/);

    store.append('t1', { type: 'stage_started', stage: 'implement', runId: 'r1' });
    store.append('t1', {
      type: 'stage_finished',
      runId: 'r1',
      outcome: 'completed',
      summary: 'wrote a draft',
      commit: 'abc1234',
    });
    store.append('t1', { type: 'gave_up', reason: 'planned 3 times' });

    const carried = await wb.create('carry on', 'fix the units', { from: 't1' });
    assert.equal(carried.continues, 't1', 'and it says what it continues');

    await assert.rejects(() => wb.create('carry on', '', { from: 't99' }), /no ticket t99/);
  });
});

test('a ticket can be rewritten over HTTP', async () => {
  await withApi(async (wb) => {
    await wb.create('a thing', 'the details');

    const retitled = await wb.edit('t1', { title: 'a better thing' });
    assert.equal(retitled.title, 'a better thing');
    assert.equal(retitled.body, 'the details', 'what was not sent is left alone');

    assert.equal((await wb.edit('t1', { body: '' })).body, '', 'and clearing it is allowed');

    // The gate is one of the things a rewrite can say, on its own or with the rest.
    assert.equal((await wb.edit('t1', { requiresApproval: false })).requiresApproval, false);
    const gated = await wb.edit('t1', { title: 'gated again', requiresApproval: true });
    assert.equal(gated.requiresApproval, true);
    assert.equal(gated.title, 'gated again');
    assert.equal((await wb.edit('t1', { body: 'x' })).requiresApproval, true, 'unsaid, it stays');

    await assert.rejects(() => wb.edit('t1', { title: '  ' }), /needs a title/);
    await assert.rejects(() => wb.edit('t1', {}), /nothing to change/);
  });
});

test('the manager can commit a ticket to the queue and take it back', async () => {
  await withApi(async (wb) => {
    const created = await wb.create('an idea', '');
    assert.equal(created.status, 'backlog');

    await wb.queue('t1');
    assert.equal((await wb.ticket('t1')).ticket.status, 'queued');

    await wb.backlog('t1');
    assert.equal((await wb.ticket('t1')).ticket.status, 'backlog');
  });
});

test('offered work can be sent back, or kept and put right', async () => {
  await withApi(async (wb, store) => {
    await wb.create('a thing', '');
    // Nothing planned yet: there is no work to keep, so only the expensive no
    // is on offer — the other would send it to implement with nothing to build.
    await assert.rejects(() => wb.changes('t1', 'fix it'), /nothing has been planned/);

    store.append('t1', { type: 'stage_started', stage: 'plan', runId: 'r1' });
    store.append('t1', {
      type: 'stage_finished',
      runId: 'r1',
      outcome: 'completed',
      summary: 'the plan',
    });
    store.append('t1', { type: 'pr_opened', url: 'https://example/pr/1' });

    const fixing = await wb.changes('t1', '- the units are wrong');
    assert.equal(fixing.status, 'implementing');
    assert.equal(fixing.changes, '- the units are wrong');
    assert.equal(fixing.prUrl, 'https://example/pr/1', 'still headed for the same pull request');

    await assert.rejects(() => wb.changes('t1', '  '), /say what to put right/);

    // And not once it is over. This is what the conflicts box presses, and the
    // paths outlive the clash by a moment: a merged ticket would go back to
    // implement to resolve conflicts that the merge settled.
    store.append('t1', { type: 'verdict', verdict: 'accepted' });
    await assert.rejects(() => wb.changes('t1', 'one more thing'), /this ticket is over/);
  });
});

test('merged work can be sent back to be tweaked', async () => {
  await withApi(async (wb, store) => {
    await wb.create('a thing', '');
    store.append('t1', { type: 'pr_opened', url: 'https://example/pr/1' });
    store.append('t1', { type: 'verdict', verdict: 'accepted' });
    assert.equal((await wb.ticket('t1')).ticket.status, 'done');

    // The expensive no was never gated on the ticket being live; the panel is what
    // had no way of reaching it once the work had merged.
    await wb.reject('t1', 'shorten the summary line');
    const tweaking = (await wb.ticket('t1')).ticket;
    assert.equal(tweaking.status, 'planning');
    assert.equal(tweaking.rejection, 'shorten the summary line');
    assert.equal(tweaking.offered, false);
  });
});

test('a ticket can be written already waiting for others', async () => {
  await withApi(async (wb) => {
    await wb.create('the dependency', '');
    await wb.create('another', '');

    // The moment you know what the work follows is the moment you write it down.
    const held = await wb.create('the one that waits', '', { waitsFor: ['t1', 't2'] });
    assert.deepEqual(held.waitsFor, ['t1', 't2']);
    assert.equal(held.status, 'backlog', 'and it still waits in the backlog as usual');

    // Checked before anything is created, so a typo leaves no ticket behind that
    // says nothing about what it was supposed to wait for.
    await assert.rejects(() => wb.create('bad', '', { waitsFor: ['t9'] }), /no ticket t9/);
    assert.equal((await wb.tickets()).length, 3, 'and nothing was created');
  });
});

test('the manager can put a ticket in front of another, or last', async () => {
  await withApi(async (wb) => {
    for (const title of ['one', 'two', 'three']) await wb.create(title, '');

    const moved = await wb.move('t3', 't1');
    assert.deepEqual(
      moved.map((t) => t.id),
      ['t3', 't1', 't2'],
      'the whole order comes back, because that is what changed',
    );
    assert.deepEqual(
      (await wb.move('t3', null)).map((t) => t.id),
      ['t1', 't2', 't3'],
    );

    await assert.rejects(() => wb.move('t1', 't1'), /before itself/);
    await assert.rejects(() => wb.move('t1', 't9'), /no ticket t9/);
  });
});

test('a ticket can be held until another offers its work, and let go again', async () => {
  await withApi(async (wb, store) => {
    await wb.create('the dependency', '');
    await wb.create('the one that waits', '');

    await wb.create('another dependency', '');

    // The whole set each time, so taking one off is sending the rest.
    assert.deepEqual((await wb.wait('t2', ['t1', 't3'])).waitsFor, ['t1', 't3']);
    assert.deepEqual((await wb.wait('t2', ['t1'])).waitsFor, ['t1']);
    assert.deepEqual((await wb.wait('t2', [])).waitsFor, [], 'and an empty list lets it go');

    // Named twice is waited for once.
    assert.deepEqual((await wb.wait('t2', ['t1', 't1'])).waitsFor, ['t1']);

    await assert.rejects(() => wb.wait('t2', ['t2']), /cannot wait for itself/);
    await assert.rejects(() => wb.wait('t2', ['t1', 't9']), /no ticket t9/);
    assert.deepEqual((await wb.ticket('t2')).ticket.waitsFor, ['t1'], 'and nothing was written');

    // A ring of tickets waiting on each other would never start, and nothing
    // downstream would be able to say why.
    await assert.rejects(() => wb.wait('t1', ['t2']), /hold each other up/);

    store.append('t4', { type: 'ticket_created', title: 'a fourth', body: '' });
    store.append('t4', { type: 'waits_for', tickets: ['t2'] });
    await assert.rejects(() => wb.wait('t1', ['t4']), /hold each other up/);
  });
});

test('the board is served, and the api routes still win', async () => {
  const store = openStore(':memory:');
  const api = createApi(store, scratchConfig());
  const port = await api.listen(0);

  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);

    const json = await fetch(`http://127.0.0.1:${port}/tickets`);
    assert.match(json.headers.get('content-type') ?? '', /application\/json/);
  } finally {
    await api.close();
    store.close();
  }
});

test('a second workbench on the same port says so, rather than crashing', async () => {
  const store = openStore(':memory:');
  const first = createApi(store, scratchConfig());
  const port = await first.listen(0);
  const second = createApi(store, scratchConfig());

  try {
    await assert.rejects(
      () => second.listen(port),
      /already running on port/,
      'an ordinary mistake, not a stack trace from inside node',
    );
  } finally {
    await first.close();
    store.close();
  }
});

test('the plan gate is asked for when the ticket is written, and kept', async () => {
  await withApi(async (wb) => {
    assert.equal((await wb.create('gated by default', '')).requiresApproval, true);
    assert.equal(
      (await wb.create('asked for one', '', { requiresApproval: true })).requiresApproval,
      true,
    );

    const ungated = await wb.create('no gate', 'go on then', { requiresApproval: false });
    assert.equal(ungated.requiresApproval, false);

    // It survives the round trip, because it is on the event rather than in memory.
    const { ticket, events } = await wb.ticket(ungated.id);
    assert.equal(ticket.requiresApproval, false);
    assert.ok(
      events.some((e) => e.type === 'ticket_created' && e.requiresApproval === false),
      'the choice is on the record, where the ticket is rebuilt from',
    );
  });
});

/**
 * A chat agent that never leaves this process. What it says is what it was told to
 * say — the interesting part is what the routes do with it, not what it thinks.
 */
function stubChat(proposals: Proposal[] = [], costUsd = 0.03): ChatRunner {
  return async ({ message }) => ({
    text: `heard: ${message}`,
    proposals,
    costUsd,
    sessionId: 's1',
  });
}

test('a chat turn appends what was said and what came back', async () => {
  await withApi(
    async (wb, store) => {
      await wb.create('Add a retry', 'It gives up too early.');
      const chat = await wb.chat('t1', 'is this ready to start?');

      assert.deepEqual(
        chat.turns.map((t) => [t.role, t.text]),
        [
          ['manager', 'is this ready to start?'],
          ['agent', 'heard: is this ready to start?'],
        ],
      );
      assert.equal(chat.session, 's1', 'so the next turn carries on rather than re-reading');

      assert.deepEqual(
        store.eventsFor('t1').map((e) => e.type),
        ['ticket_created', 'chat_said', 'chat_said'],
      );
      // Talking about a ticket must not be able to spend it past its ceiling and
      // stop the work being talked about.
      assert.equal(store.ticket('t1').costUsd, 0);
    },
    { chat: stubChat() },
  );
});

test('a chat with nothing wired into it says so rather than failing', async () => {
  await withApi(async (wb, store) => {
    await wb.create('Add a retry', '');
    await assert.rejects(() => wb.chat('t1', 'hello?'), /no chat agent/);
    assert.equal(store.eventsFor('t1').length, 1, 'and nothing is said on its behalf');
  });
});

test('accepting a proposal appends the event the button would, and says it came from the chat', async () => {
  const rename: Proposal = { action: 'edit', why: 'it says nothing', title: 'Add a retry' };
  await withApi(
    async (wb, store) => {
      await wb.create('thing', '');
      const chat = await wb.chat('t1', 'what should it be called?');
      assert.deepEqual(
        chat.turns[1]?.proposals.map((p) => [p.at, p.accepted]),
        [[0, false]],
      );

      const after = await wb.acceptProposal('t1', 0);
      assert.equal(after.title, 'Add a retry');
      assert.deepEqual(
        store.eventsFor('t1').map((e) => e.type),
        ['ticket_created', 'chat_said', 'chat_said', 'ticket_edited', 'chat_accepted'],
      );

      // And the pane says so, rather than offering the same thing again.
      const said = await wb.chat('t1', 'done?');
      assert.deepEqual(
        said.turns[1]?.proposals.map((p) => p.accepted),
        [true],
      );
    },
    { chat: stubChat([rename]) },
  );
});

test('a proposal that breaks the rule of the action it names is refused, and appends nothing', async () => {
  const wrong: Proposal[] = [
    { action: 'ship', why: 'good enough' },
    { action: 'changes', why: 'nearly', text: 'fix the retry' },
  ];
  await withApi(
    async (wb, store) => {
      await wb.create('thing', '');
      await wb.chat('t1', 'anything to do?');
      const before = store.eventsFor('t1').length;

      await assert.rejects(() => wb.acceptProposal('t1', 0), /may not propose "ship"/);
      // The same refusal `/tickets/:id/changes` gives: no plan, nothing to work from.
      await assert.rejects(() => wb.acceptProposal('t1', 1), /nothing has been planned yet/);
      await assert.rejects(() => wb.acceptProposal('t1', 7), /has no proposal 7/);

      assert.equal(store.eventsFor('t1').length, before);
    },
    { chat: stubChat(wrong) },
  );
});

test('only a number names a proposal, so a request naming none accepts nothing', async () => {
  await withApi(
    async (wb, store) => {
      await wb.create('thing', '');
      await wb.chat('t1', 'anything to do?');
      const before = store.eventsFor('t1').length;

      // Every one of these used to be `Number`ed into 0 — which is a real proposal,
      // so a request that named nothing took the first offer up.
      const accept = wb.acceptProposal as unknown as (id: string, at: unknown) => Promise<unknown>;
      for (const at of [null, '', ' ', false, [], '0', undefined]) {
        await assert.rejects(() => accept('t1', at), /has no proposal/, JSON.stringify(at ?? null));
      }

      assert.equal(store.eventsFor('t1').length, before);
    },
    { chat: stubChat([{ action: 'queue', why: 'it is ready' }]) },
  );
});

test('a proposal accepted twice is performed once, and the second says why not', async () => {
  await withApi(
    async (wb, store) => {
      await wb.create('thing', '');
      await wb.chat('t1', 'ready?');
      await wb.acceptProposal('t1', 0);
      const after = store.eventsFor('t1').map((e) => e.type);
      assert.deepEqual(after.slice(-2), ['queued', 'chat_accepted']);

      await assert.rejects(() => wb.acceptProposal('t1', 0), /already been accepted/);
      assert.deepEqual(
        store.eventsFor('t1').map((e) => e.type),
        after,
        'the second accept appends nothing at all',
      );
    },
    { chat: stubChat([{ action: 'queue', why: 'it is ready' }]) },
  );
});

test('two accepts of one proposal at once leave one event, not two', async () => {
  await withApi(
    async (wb, store) => {
      await wb.create('thing', '');
      await wb.chat('t1', 'is the plan right?');

      const both = await Promise.allSettled([
        wb.acceptProposal('t1', 0),
        wb.acceptProposal('t1', 0),
      ]);
      assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);

      assert.equal(
        store.eventsFor('t1').filter((e) => e.type === 'plan_rejected').length,
        1,
        'the rejection is appended once however the two requests were interleaved',
      );
    },
    { chat: stubChat([{ action: 'reject', why: 'wrong shape', text: 'start from the store' }]) },
  );
});

test('the agents are readable, and what each declares is said with it', async () => {
  await withApi(async (wb) => {
    const agents = await wb.docs('agent');
    assert.deepEqual(
      agents.map((a) => a.name),
      ['plan', 'implement', 'review', 'verify', 'chat'],
      'in the order they run, and then the one that is not in the loop at all',
    );

    const plan = agents[0]!;
    assert.match(plan.where, /agents\/plan\.md$/);
    assert.match(plan.about, /turns/, 'what it costs, from its own frontmatter');
    assert.match(plan.text, /^---/, 'the file as written, frontmatter and all');
  });
});

test('an agent that would not load is refused, and the file is left as it was', async () => {
  await withApi(async (wb) => {
    const before = (await wb.docs('agent'))[0]!;

    await assert.rejects(
      () => wb.saveDoc('agent', 'plan', before.text.replace('effort: high', 'effort: sideways')),
      /effort must be one of/,
      'the complaint names the field, because it reaches the person who typed it',
    );
    await assert.rejects(
      () => wb.saveDoc('agent', 'nonesuch', 'hello'),
      /no agent called nonesuch/,
    );

    assert.equal((await wb.docs('agent'))[0]!.text, before.text);
  });
});

test('an agent saved from the board is what the next stage is run from', async () => {
  await withApi(async (wb) => {
    const before = (await wb.docs('agent'))[0]!;
    const saved = await wb.saveDoc('agent', 'plan', `${before.text}\nAnd one more thing.\n`);

    assert.match(saved.text, /And one more thing\./);
    assert.equal((await wb.docs('agent'))[0]!.text, saved.text, 'on disk, not only in the reply');
  });
});

test('a skill is refused if nothing would ever decide to read it', async () => {
  await withApi(async (wb) => {
    const skills = await wb.docs('skill');
    assert.ok(skills.length > 0, 'the workbench ships with some');
    const one = skills[0]!;
    assert.match(one.where, /skills\/.*\/SKILL\.md$/);
    assert.equal(one.about.length > 0, true, 'its description, which is its whole trigger');

    await assert.rejects(
      () => wb.saveDoc('skill', one.name, '---\ndescription: ""\n---\n\nSomething.'),
      /no description/,
    );
  });
});

test('a name being typed comes back with a better one, and what the ticket says', async () => {
  const asked: { title: string; body: string }[] = [];
  await withApi(
    async (wb) => {
      const suggestion = await wb.checkName('Pushes', 'They give up early.');
      assert.deepEqual(suggestion, { name: 'Retry failed pushes', why: 'it named no verb' });
      assert.deepEqual(asked, [{ title: 'Pushes', body: 'They give up early.' }]);

      // Nothing typed is nothing to ask about, and asking would cost money for it.
      assert.deepEqual(await wb.checkName('   ', ''), { name: null });
      assert.equal(asked.length, 1);
    },
    {
      checkName: async (title, body) => {
        asked.push({ title, body });
        return { name: 'Retry failed pushes', why: 'it named no verb' };
      },
    },
  );
});

test('with nobody to ask, the name check answers that it has nothing, and asks nobody', async () => {
  // A workbench running fake agents wires no checker, and this is what it answers.
  // Costing money to try the workbench out is exactly what fake agents exist to avoid.
  await withApi(async (wb) => {
    assert.deepEqual(await wb.checkName('Pushes', ''), { name: null });
  });
});

test('the form opening says so, and a workbench with nobody to ask takes it anyway', async () => {
  let warmed = 0;
  await withApi(
    async (wb) => {
      assert.deepEqual(await wb.warmNameCheck(), { ok: true });
      assert.equal(warmed, 1);
    },
    { warmNameCheck: () => warmed++ },
  );

  // Fake agents wire no checker and so have nothing to get ready. Saying so must
  // still not be an error the board has to handle.
  await withApi(async (wb) => {
    assert.deepEqual(await wb.warmNameCheck(), { ok: true });
  });
});

test("a ticket's pane opening says so, and says which ticket", async () => {
  // Unlike a name check, what gets ready here is bound to one ticket: where it
  // reads, what it may read and the tools it is given are all that ticket's, so
  // nothing can be started until this arrives.
  const warmed: string[] = [];
  await withApi(
    async (wb) => {
      await wb.create('Add a retry', 'It gives up too early.');
      assert.deepEqual(await wb.warmChat('t1'), { ok: true });
      assert.deepEqual(warmed, ['t1']);
    },
    { warmChat: (ticket) => warmed.push(ticket.id) },
  );

  // Fake agents wire no chat and so have nothing to get ready. Saying so must
  // still not be an error the board has to handle.
  await withApi(async (wb) => {
    await wb.create('Add a retry', 'It gives up too early.');
    assert.deepEqual(await wb.warmChat('t1'), { ok: true });
  });
});

test('a skill added from the board is one every stage can load', async () => {
  await withApi(async (wb, _store, config) => {
    const made = await wb.createDoc('skill', 'writing-reports');
    assert.equal(made.where, path.join('skills', 'writing-reports', 'SKILL.md'));
    assert.ok(made.about.length > 0, 'a description from the moment it exists');

    assert.deepEqual(
      (await wb.docs('skill')).map((d) => d.name),
      ['writing-python', 'writing-reports'],
    );

    const file = path.join(config.home, 'skills', 'writing-reports', 'SKILL.md');
    assert.equal(fs.readFileSync(file, 'utf8'), made.text, 'on disk, not only in the reply');
    assert.equal(
      parseSkill(made.text, 'writing-reports'),
      made.about,
      'what it starts as loads — an unloadable one would stop every stage',
    );
  });
});

test('the first skill in a home with no plugin manifest is still named', async () => {
  await withApi(async (wb, _store, config) => {
    fs.rmSync(path.join(config.home, 'skills', 'writing-python'), { recursive: true });
    fs.rmSync(path.join(config.home, '.claude-plugin'), { recursive: true });

    await wb.createDoc('skill', 'writing-reports');
    assert.deepEqual(
      loadSkills(config.home).map((s) => s.name),
      ['workbench:writing-reports'],
      'without the manifest this home would have no name to offer the skill under',
    );
  });
});

test('a skill deleted from the board takes its whole directory with it', async () => {
  await withApi(async (wb, _store, config) => {
    const dir = path.join(config.home, 'skills', 'writing-python');
    fs.writeFileSync(path.join(dir, 'example.md'), 'the rest of it');

    assert.equal(await wb.deleteDoc('skill', 'writing-python'), 'writing-python');
    assert.equal(fs.existsSync(dir), false, 'a skill is its directory, not only its SKILL.md');
    assert.deepEqual(await wb.docs('skill'), []);
  });
});

test('a skill directory the board would not have named that way is still removable', async () => {
  await withApi(async (wb, _store, config) => {
    const dir = path.join(config.home, 'skills', 'Writing_Python');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'SKILL.md'), '---\ndescription: An older one.\n---\n\n# Old\n');

    assert.deepEqual(
      (await wb.docs('skill')).map((d) => d.name),
      ['Writing_Python', 'writing-python'],
      'listed and saveable, so what the Delete button offers has to be a deletion',
    );
    assert.equal(await wb.deleteDoc('skill', 'Writing_Python'), 'Writing_Python');
    assert.equal(fs.existsSync(dir), false);
  });
});

test('a skill whose name YAML would read as a number still loads as its own name', async () => {
  await withApi(async (wb) => {
    const made = await wb.createDoc('skill', '2024');
    assert.equal(
      parseSkill(made.text, '2024'),
      made.about,
      'unquoted, its frontmatter would call it the number 2024 and refuse to load',
    );
  });
});

test('adding and removing are refused for anything that is not a skill of its own', async () => {
  await withApi(async (wb, _store, config) => {
    const skills = path.join(config.home, 'skills');
    const before = fs.readdirSync(skills);

    await assert.rejects(() => wb.createDoc('agent', 'planner'), /stages are fixed/);
    await assert.rejects(() => wb.deleteDoc('agent', 'plan'), /stages are fixed/);
    await assert.rejects(() => wb.createDoc('skill', 'writing-python'), /already a skill/);
    await assert.rejects(() => wb.createDoc('skill', ''), /not a skill name/);
    await assert.rejects(() => wb.createDoc('skill', 'over/there'), /not a skill name/);
    await assert.rejects(() => wb.createDoc('skill', '..'), /not a skill name/);
    await assert.rejects(() => wb.deleteDoc('skill', 'nonesuch'), /no skill called nonesuch/);
    // A separator or `..` never survives a URL — one collapses the path and the other
    // matches no route — so removing by such a name is refused where the check lives.
    assert.throws(() => deleteDoc(config, 'skill', 'over/there'), /not a skill name/);
    assert.throws(() => deleteDoc(config, 'skill', '..'), /not a skill name/);

    assert.deepEqual(fs.readdirSync(skills), before, 'and the disk is as it was');
    // The four stages and the one that talks about a ticket: fixed, every one of
    // them, which is what refusing to add or remove any of them leaves.
    assert.deepEqual((await wb.docs('agent')).map((d) => d.name).sort(), [
      'chat',
      'implement',
      'plan',
      'review',
      'verify',
    ]);
  });
});

test('the settings say what the workbench is set to, and a limit changed there holds', async () => {
  await withApi(async (wb) => {
    const before = await wb.settings();
    const wip = before.find((s) => s.key === 'wipLimit');
    assert.equal(wip?.value, 2);
    assert.equal(wip?.restart, false, 'a limit takes effect at once');

    const after = await wb.setSettings({ wipLimit: '4' });
    assert.equal(after.find((s) => s.key === 'wipLimit')?.value, 4);
    assert.equal((await wb.policy()).wipLimit, 4, 'the rules read the same number');
  });
});

test('a setting that is a fact about the installation cannot be set', async () => {
  await withApi(async (wb) => {
    await assert.rejects(() => wb.setSettings({ repoRoot: '/tmp' }), /not something you set/);
    await assert.rejects(() => wb.setSettings({ maxRevisions: 9 }), /not something you set/);
    await assert.rejects(() => wb.setSettings({ nonesuch: 1 }), /no setting called nonesuch/);
    await assert.rejects(() => wb.setSettings({ wipLimit: 0 }), /at least 1/);
  });
});

test('a configured setting is written to the config file, and a default is taken back out', async () => {
  await withApi(async (wb) => {
    const where = (await wb.settings()).find((s) => s.key === 'home')?.value as string;
    const file = () =>
      JSON.parse(fs.readFileSync(path.join(where, CONFIG_FILE), 'utf8')) as Record<string, unknown>;

    const after = await wb.setSettings({ base: 'trunk', checks: 'yarn test\nyarn typecheck' });
    assert.equal(after.find((s) => s.key === 'base')?.restart, true, 'and it says so');
    assert.equal(file()['base'], 'trunk');
    assert.deepEqual(file()['checks'], ['yarn test', 'yarn typecheck']);

    // Back at the default, so the file stops mentioning it: what is in there is
    // what this project decided, not a copy of every default.
    await wb.setSettings({ base: 'main' });
    assert.equal('base' in file(), false);
  });
});

test('the instance colour is kept in the config file, and clearing it takes the key out', async () => {
  await withApi(async (wb) => {
    const where = (await wb.settings()).find((s) => s.key === 'home')?.value as string;
    const file = () =>
      JSON.parse(fs.readFileSync(path.join(where, CONFIG_FILE), 'utf8')) as Record<string, unknown>;

    const colour = (all: Setting[]) => all.find((s) => s.key === 'colour');
    const before = colour(await wb.settings());
    assert.equal(before?.value, '', 'no colour until one is chosen');
    // The board draws swatches by walking these, so they have to come with the setting.
    assert.deepEqual(before?.choices, PRESET_VALUES);

    const preset = PRESET_VALUES[0] as string;
    const after = await wb.setSettings({ colour: preset.toUpperCase() });
    assert.equal(colour(after)?.value, preset, 'and it is written the one way');
    // The board reads it every time it loads, so saying "next start" would be a lie.
    assert.equal(colour(after)?.restart, false);
    assert.equal(file()['colour'], preset);

    // No colour is the default, so the file stops mentioning it rather than holding
    // an empty string nobody can read a decision out of.
    const cleared = await wb.setSettings({ colour: '' });
    assert.equal(colour(cleared)?.value, '');
    assert.equal('colour' in file(), false);
  });
});

test('the ticket prefixes are a list in the config file, and the default is taken back out', async () => {
  await withApi(async (wb) => {
    const where = (await wb.settings()).find((s) => s.key === 'home')?.value as string;
    const file = () =>
      JSON.parse(fs.readFileSync(path.join(where, CONFIG_FILE), 'utf8')) as Record<string, unknown>;

    const prefixes = (all: Setting[]) => all.find((s) => s.key === 'ticketPrefixes');
    assert.deepEqual(prefixes(await wb.settings())?.value, ['feature', 'fix', 'chore', 'docs']);

    const after = await wb.setSettings({ ticketPrefixes: 'spike\n\n  refactor  ' });
    assert.deepEqual(prefixes(after)?.value, ['spike', 'refactor']);
    // The form reads it every time it opens, so saying "next start" would be a lie.
    assert.equal(prefixes(after)?.restart, false);
    assert.deepEqual(file()['ticketPrefixes'], ['spike', 'refactor']);

    await wb.setSettings({ ticketPrefixes: 'feature\nfix\nchore\ndocs' });
    assert.equal('ticketPrefixes' in file(), false);
  });
});

test('a prose setting keeps its blank lines, and empty is refused', async () => {
  await withApi(async (wb) => {
    const where = (await wb.settings()).find((s) => s.key === 'home')?.value as string;
    const file = () =>
      JSON.parse(fs.readFileSync(path.join(where, CONFIG_FILE), 'utf8')) as Record<string, unknown>;

    const setting = (all: Setting[]) => all.find((s) => s.key === 'estimatePrompt');
    const shipped = setting(await wb.settings());
    assert.equal(shipped?.type, 'prose');
    assert.match(String(shipped?.value), /RANGE:/, 'the prompt that ships is what it is set to');

    // The paragraphs are the whole reason this is not a `lines` setting: that one
    // drops every blank line, which would eat a prompt a little more each save.
    const own = 'Guess how long.\n\nCompare it to what is below.';
    const after = await wb.setSettings({ estimatePrompt: own });
    assert.equal(setting(after)?.value, own);
    assert.equal(setting(after)?.restart, false, 'it is read per call, not at startup');
    assert.equal(file()['estimatePrompt'], own);

    await assert.rejects(() => wb.setSettings({ estimatePrompt: '  ' }), /cannot be empty/);
    assert.equal(file()['estimatePrompt'], own, 'and the refusal wrote nothing');

    await wb.setSettings({ estimatePrompt: String(shipped?.value) });
    assert.equal('estimatePrompt' in file(), false, 'back at the default, back out of the file');
  });
});

test('a colour that is not one of the presets is refused, and nothing is written', async () => {
  await withApi(async (wb) => {
    const where = (await wb.settings()).find((s) => s.key === 'home')?.value as string;
    const file = () =>
      JSON.parse(fs.readFileSync(path.join(where, CONFIG_FILE), 'utf8')) as Record<string, unknown>;

    const complaint = /Instance colour must be one of/;
    await assert.rejects(() => wb.setSettings({ colour: 'blue' }), complaint);
    await assert.rejects(() => wb.setSettings({ colour: '#xyz' }), complaint);
    // Well formed and still not on offer: the point of the set is that it is the set.
    await assert.rejects(() => wb.setSettings({ colour: '#3a7d6f' }), complaint);
    assert.equal('colour' in file(), false);
  });
});

test('stopping refuses every write and leaves every read alone', async () => {
  await withApi(async (wb, store) => {
    await wb.create('a thing', '');

    assert.deepEqual(await wb.stopped(), { stopped: false, running: [], paused: null });
    assert.deepEqual(await wb.stop(), { stopped: true, running: [], interrupted: [] });
    assert.equal(store.stopped(), true, 'and it is written down, so a restart still has it');

    // Whatever the board or the command line was asked to do, this is what it says
    // instead — and it names the way back rather than only refusing.
    const refusal = /the workbench is stopped — "wb start" to start it again/;
    await assert.rejects(() => wb.create('another', ''), refusal);
    await assert.rejects(() => wb.queue('t1'), refusal);
    await assert.rejects(() => wb.setPolicy({ wipLimit: 3 }), refusal);

    // The board still has to render, and show the way back.
    assert.equal((await wb.tickets()).length, 1);
    assert.equal((await wb.ticket('t1')).ticket.title, 'a thing');

    await wb.start();
    assert.equal(store.stopped(), false);
    await wb.queue('t1');
    assert.equal((await wb.ticket('t1')).ticket.status, 'queued');
  });
});

test('the board is told why agent work is paused, not just the terminal', async () => {
  const held = { why: 'the Claude CLI is not logged in', fix: 'run: claude setup-token' };

  await withApi(
    async (wb) => {
      assert.deepEqual((await wb.stopped()).paused, { ...held, resumes: true });
    },
    {
      orchestrator: {
        interrupt: () => [],
        tick: async () => {},
        paused: () => ({ ...held, resumes: true }),
      },
    },
  );

  // No orchestrator at all — the CLI's own client talking to a bare server.
  await withApi(async (wb) => assert.equal((await wb.stopped()).paused, null));
});

test('stopping again interrupts the runs that were left to finish', async () => {
  const interrupted: string[] = ['t1'];
  const ticked: number[] = [];

  await withApi(
    async (wb, store) => {
      await wb.create('a thing', '');
      store.append('t1', { type: 'stage_started', stage: 'plan', runId: 'r1' });

      const first = await wb.stop();
      assert.deepEqual(first, { stopped: true, running: ['t1'], interrupted: [] });
      assert.equal((await wb.stopped()).paused, null, 'nothing is paused, so nothing to say');

      // The second press, which is the impatient one. The loop is what stops the
      // runs; this route only says so, and reports what it stopped.
      const second = await wb.stop();
      assert.deepEqual(second.interrupted, ['t1']);

      await wb.start();
      assert.deepEqual(ticked, [1], 'starting looks for work at once, not in thirty seconds');
    },
    {
      orchestrator: {
        interrupt: () => interrupted,
        tick: async () => ticked.push(1),
        paused: () => undefined,
      },
    },
  );
});
