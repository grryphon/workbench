import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { forScale, loadAgent, loadAgents, loadSkills, parseSkill, STAGES } from './load.ts';
import { buildBrief, whatHappenedTo } from './brief.ts';
import { deriveTicket } from '../domain/ticket.ts';
import { PACKAGE_ROOT } from '../config.ts';
import type { Event, EventBody } from '../domain/events.ts';

const AGENTS_DIR = fileURLToPath(new URL('../../agents', import.meta.url));
const agents = loadAgents([AGENTS_DIR]);

/**
 * A plugin of the shape a project's `.workbench/` holds: a manifest naming it, and a
 * skill under it. Built here rather than read from the workbench's own directory: the
 * one skill that ships is about naming a ticket, and how a repository writes Python is
 * that repository's to say, not something a tool can bring with it.
 */
function scratchPlugin(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-plugin-'));
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(root, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ name: 'here' }),
  );
  fs.mkdirSync(path.join(root, 'skills', 'writing-python'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'skills', 'writing-python', 'SKILL.md'),
    '---\nname: writing-python\ndescription: How Python is written in this repository.\n---\n\n# Python\n',
  );
  return root;
}

const PLUGIN_ROOT = scratchPlugin();
const skills = loadSkills(PLUGIN_ROOT);

/**
 * A brief is mostly prose, so it is tempting to test it by quoting that prose back.
 * Do not. An assertion here earns its place one of two ways:
 *
 * 1. **The expected value comes from this file's own fixture** — a ticket title, a
 *    scratch path, a diff — so it shows an input reaching the output. Make fixtures
 *    distinctive; matching a word the agent instructions also happen to use proves
 *    nothing.
 * 2. **It exercises a branch or a transform** — a section appearing for one stage and
 *    not another, a heading being demoted, a fence being added.
 *
 * Matching a sentence that is a constant in `brief.ts` or in `agents/*.md` is neither.
 * It only asserts that the constant is still the constant, and it makes the wording
 * expensive to improve — which is exactly the change you most want to be cheap.
 */

function ticketFrom(bodies: EventBody[]) {
  const events: Event[] = bodies.map((b, i) => ({
    ...b,
    id: i + 1,
    ticketId: 't1',
    at: '2026-08-04T00:00:00Z',
  }));
  return deriveTicket(events);
}

const CREATED: EventBody = {
  type: 'ticket_created',
  title: 'Add a retry',
  body: 'The upload gives up on the first failure.',
};

test('the four shipped agent definitions load and validate', () => {
  assert.deepEqual(Object.keys(agents).sort(), [...STAGES].sort());
  for (const stage of STAGES) {
    assert.equal(agents[stage].stage, stage);
    assert.ok(agents[stage].instructions.length > 100, `${stage} has real instructions`);
  }
});

test('the read-only stages have no tool that can change anything', () => {
  for (const stage of ['plan', 'review'] as const) {
    const { allowedTools } = agents[stage];
    for (const tool of ['Write', 'Edit', 'Bash', 'NotebookEdit']) {
      assert.ok(
        !allowedTools.includes(tool),
        `${stage} must not be granted ${tool}: it is meant to change nothing`,
      );
    }
  }
});

test('every stage can ask the manager a question', () => {
  for (const stage of STAGES) {
    assert.ok(
      agents[stage].allowedTools.includes('AskUserQuestion'),
      `${stage} must be able to ask rather than assume`,
    );
  }
});

test('the shipped skill loads and validates', () => {
  // Broken frontmatter here surfaces in every home `wb init` has written, at the start
  // of every stage run, rather than in this suite.
  const description = parseSkill(
    fs.readFileSync(path.join(PACKAGE_ROOT, 'skills', 'naming-a-ticket', 'SKILL.md'), 'utf8'),
    'naming-a-ticket',
  );
  assert.ok(description.length > 20, 'naming-a-ticket needs a description worth deciding on');
});

test("a project's skills load, qualified by the plugin that carries them", () => {
  assert.ok(skills.length > 0, 'the fixture has skills, or none of this matters');
  for (const { name, description } of skills) {
    assert.match(name, /^here:/, 'the name is the one an agent has to type');
    assert.ok(description.length > 20, `${name} needs a description worth deciding on`);
  }
});

test('a project that has declared no skills is not a broken one', () => {
  // A home written before `wb init` copied the shipped skill in, or one whose skills
  // have all been deleted. Reading the manifest first made an empty `skills/` a crash.
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bare-'));
  assert.deepEqual(loadSkills(bare), []);
  fs.rmSync(bare, { recursive: true, force: true });
});

test('every stage is told what it knows how to do, and how to read it', () => {
  for (const stage of STAGES) {
    const brief = buildBrief({
      ticket: ticketFrom([CREATED]),
      agent: agents[stage],
      worktree: '/tmp/wb/t1',
      skills,
    });

    for (const { name, description } of skills) {
      assert.ok(brief.includes(name), `${stage} is not told about ${name}`);
      assert.ok(brief.includes(description), `${stage} cannot tell what ${name} is for`);
    }
  }
});

test('a bad agent file fails loudly rather than silently weakening a guardrail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-agents-'));
  const write = (front: string, body = 'do the thing, at length, with detail') =>
    fs.writeFileSync(path.join(dir, 'plan.md'), `---\n${front}\n---\n\n${body}\n`);

  const good = [
    'stage: plan',
    'model: claude-opus-5',
    'effort: high',
    'permissionMode: dontAsk',
    'maxTurns: 40',
    'maxBudgetUsd: 5',
    'allowedTools: [Read]',
    'disallowedTools: [Write]',
  ].join('\n');

  write(good);
  assert.equal(loadAgent(dir, 'plan').model, 'claude-opus-5');

  write(good.replace('allowedTools: [Read]', 'allowedTools: [Reed]'));
  assert.throws(() => loadAgent(dir, 'plan'), /unknown tools: Reed/, 'a typo is caught');

  write(good.replace('effort: high', 'effort: enormous'));
  assert.throws(() => loadAgent(dir, 'plan'), /effort must be one of/);

  write(good.replace('disallowedTools: [Write]', 'disallowedTools: [Read]'));
  assert.throws(() => loadAgent(dir, 'plan'), /both allowed and disallowed/);

  write(good.replace('allowedTools: [Read]', 'allowedTools: []'));
  assert.throws(() => loadAgent(dir, 'plan'), /grants no tools/);

  write(good, '');
  assert.throws(() => loadAgent(dir, 'plan'), /no instructions/);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a stage the project has replaced is used, and only that stage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-agents-'));
  const mine = fs.readFileSync(path.join(AGENTS_DIR, 'plan.md'), 'utf8');
  fs.writeFileSync(path.join(dir, 'plan.md'), mine.replace('You are the', 'Mine says the'));

  const loaded = loadAgents([dir, AGENTS_DIR]);
  assert.match(loaded.plan.instructions, /^Mine says the/);
  for (const stage of STAGES.filter((s) => s !== 'plan')) {
    assert.equal(loaded[stage].instructions, agents[stage].instructions, `${stage} is untouched`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

test('the plan brief carries the ticket but not a plan', () => {
  const brief = buildBrief({
    ticket: ticketFrom([CREATED]),
    agent: agents.plan,
    worktree: '/tmp/wb/t1',
  });

  assert.match(brief, /Add a retry/);
  assert.match(brief, /gives up on the first failure/);
  assert.doesNotMatch(brief, /The approved plan/);
});

test('a re-plan is given the objection and the plan it was against', () => {
  const ticket = ticketFrom([
    CREATED,
    { type: 'stage_started', stage: 'plan', runId: 'r1' },
    { type: 'stage_finished', runId: 'r1', outcome: 'completed', summary: 'first plan' },
    { type: 'plan_rejected', reason: 'retries must be bounded' },
  ]);

  const brief = buildBrief({ ticket, agent: agents.plan, worktree: '/tmp/wb/t1' });
  assert.match(brief, /Why this came back/);
  assert.match(brief, /retries must be bounded/);
  // Without this the objection is unreadable: it says the answer was wrong and never
  // says what the answer was.
  assert.match(brief, /first plan/);
});

test('review is given the plan and the diff, and does not have to find them', () => {
  const ticket = ticketFrom([
    CREATED,
    { type: 'stage_started', stage: 'plan', runId: 'r1' },
    {
      type: 'stage_finished',
      runId: 'r1',
      outcome: 'completed',
      summary: '## Approach\n\nwrap in a retry',
    },
    { type: 'plan_approved' },
  ]);

  const brief = buildBrief({
    ticket,
    agent: agents.review,
    worktree: '/tmp/wb/t1',
    diff: '+ retry(3)',
  });

  assert.match(brief, /The approved plan[\s\S]*wrap in a retry/);
  // The plan's own headings are demoted, so they read as the plan's rather than as
  // more sections of the brief telling the agent what to do.
  assert.match(brief, /#### Approach/);
  assert.match(brief, /```diff\n\+ retry\(3\)\n```/);
});

test('verify is told which checks must pass', () => {
  const brief = buildBrief({
    ticket: ticketFrom([CREATED]),
    agent: agents.verify,
    worktree: '/tmp/wb/t1',
    checks: [
      { command: 'yarn test', ok: true, output: '131 passing' },
      { command: 'yarn typecheck', ok: true, output: '' },
    ],
  });

  assert.match(brief, /Checks already run[\s\S]*`yarn test`[\s\S]*`yarn typecheck`/);
  assert.match(brief, /131 passing/, 'and what they said, so it need not run them again');
  assert.match(brief, /after the implement run that produced/, 'and when they were run');
});

test('a stage told no checks were run is told that, rather than left to assume', () => {
  // The claim is in `agents/verify.md`: the workbench has run the suite for you. On a
  // project with none configured that is false, and a missing section reads exactly
  // like the one thing nobody wants — a suite that passed somewhere out of sight.
  const brief = buildBrief({
    ticket: ticketFrom([CREATED]),
    agent: agents.verify,
    worktree: '/tmp/wb/t1',
    checks: [],
  });

  assert.match(brief, /## Checks already run/, 'the section is there');
  assert.match(brief, /Nothing has been run against the tree in front of you/);
  assert.match(brief, /do not assume a suite has passed/);
});

test('a stage handed a merge is told what clashed and that it must finish it', () => {
  const brief = buildBrief({
    ticket: ticketFrom([CREATED]),
    agent: agents.implement,
    worktree: '/tmp/wb/t1',
    conflict: { base: 'abc1234def', paths: ['src/rules.ts', 'src/rules.test.ts'] },
  });

  assert.match(brief, /A merge to finish first/);
  assert.match(brief, /`src\/rules\.ts`[\s\S]*`src\/rules\.test\.ts`/, 'both of them, by name');
  assert.match(brief, /abc1234d/, 'and what it is merging in');
  assert.match(brief, /`git add`/, 'and how to settle a path, which nothing else here can');
  assert.match(brief, /blocked and commits nothing/, 'the stage cannot walk away from it');
  // Before the ticket, because it is the first thing the stage does.
  assert.ok(brief.indexOf('A merge to finish first') < brief.indexOf('## Ticket'));
});

test('a merge against a branch this ticket waited for names the branch', () => {
  // A sha of another ticket's tip says nothing anybody can act on. The branch says
  // which ticket's work this has to sit beside, which is the whole of the question.
  const brief = buildBrief({
    ticket: ticketFrom([CREATED]),
    agent: agents.implement,
    worktree: '/tmp/wb/t1',
    conflict: { base: 'abc1234def', paths: ['src/rules.ts'], with: 'wb/t37' },
  });

  assert.match(brief, /`wb\/t37` is work this ticket waited for/);
  assert.doesNotMatch(brief, /The base moved on to/, 'because it is not the base that moved');
  assert.doesNotMatch(brief, /abc1234d/, 'and the sha of one says nothing here');
  assert.match(brief, /`git add`/, 'the rest of it is the same merge to finish');
  assert.match(brief, /blocked and commits nothing/);
});

test('verify handed a merge is told its checks were run before that merge', () => {
  // They were run when implement finished, and this merge came afterwards. Nothing
  // has asked the two sides sitting together — a tree full of markers fails for the
  // markers — so a section left to speak for itself would have the stage trusting
  // output about a tree it is not looking at.
  const brief = buildBrief({
    ticket: ticketFrom([CREATED]),
    agent: agents.verify,
    worktree: '/tmp/wb/t1',
    checks: [{ command: 'yarn test', ok: true, output: '131 passing' }],
    conflict: { base: 'abc1234def', paths: ['src/rules.ts'] },
  });

  assert.match(brief, /## Checks already run/, 'what implement left was checked');
  assert.match(brief, /was run before this merge/, 'but not what is in front of this stage');
  assert.match(brief, /runs them again\s+once this stage is over/, 'and who does ask them');
});

test('a stage with no merge waiting is told nothing about one', () => {
  const brief = buildBrief({
    ticket: ticketFrom([CREATED]),
    agent: agents.implement,
    worktree: '/tmp/wb/t1',
  });

  assert.doesNotMatch(brief, /A merge to finish first/);
});

test('an answered question is handed back with the resumed stage', () => {
  const brief = buildBrief({
    ticket: ticketFrom([CREATED]),
    agent: agents.implement,
    worktree: '/tmp/wb/t1',
    answer: 'use the config in etc/',
  });

  assert.match(brief, /Answer to your question[\s\S]*use the config in etc\//);
});

test('empty sections are left out entirely', () => {
  const brief = buildBrief({
    ticket: ticketFrom([CREATED]),
    agent: agents.plan,
    worktree: '/tmp/wb/t1',
    diff: '   ',
  });

  assert.doesNotMatch(brief, /The change so far/);
  assert.doesNotMatch(brief, /Checks already run/, 'and a stage given none is told nothing');
});

test('every stage is told what the project is, rather than going to find out', () => {
  const brief = buildBrief({
    ticket: ticketFrom([CREATED]),
    agent: agents.verify,
    worktree: '/tmp/wb/t1',
    about: '# the project\n\nThere is no CI. The checks in this brief are the whole suite.',
  });

  assert.match(brief, /## About this project[\s\S]*There is no CI/);
  // It comes before the ticket: what the project is frames what the ticket means.
  assert.ok(brief.indexOf('About this project') < brief.indexOf('## Ticket'));
});

test("the project file's own headings nest under it rather than posing as sections", () => {
  // Otherwise the project's "## How to work here" is indistinguishable from the
  // brief's own "## Ticket", and an agent cannot tell context from instruction.
  const brief = buildBrief({
    ticket: ticketFrom([CREATED]),
    agent: agents.plan,
    worktree: '/tmp/wb/t1',
    about: ['# the project', '', '## How to work here', '', 'Tidy first.'].join('\n'),
  });

  assert.match(brief, /^### the project$/m);
  assert.match(brief, /^#### How to work here$/m);
  assert.doesNotMatch(brief, /^## How to work here$/m);
});

test('a hash inside a code fence is a shell comment, not a heading', () => {
  const brief = buildBrief({
    ticket: ticketFrom([CREATED]),
    agent: agents.plan,
    worktree: '/tmp/wb/t1',
    about: ['# Project', '', '```bash', '# install first', 'yarn install', '```'].join('\n'),
  });

  assert.match(brief, /^### Project$/m, 'the real heading moved');
  assert.match(brief, /^# install first$/m, 'the comment did not');
});

test('a project with nothing written about it gets no empty heading', () => {
  for (const about of [undefined, '', '   \n  ']) {
    const brief = buildBrief({
      ticket: ticketFrom([CREATED]),
      agent: agents.plan,
      worktree: '/tmp/wb/t1',
      about,
    });
    assert.doesNotMatch(brief, /About this project/);
  }
});

test('every stage after the plan is told which scale the plan declared', () => {
  // The brief states the scale and stops. What it *means* is each agent's own
  // business, said in its own markdown — review scales how far it reads, verify
  // scales how hard it probes, and those do not correspond.
  for (const stage of ['implement', 'review', 'verify'] as const) {
    for (const scale of ['small', 'standard', 'large'] as const) {
      const brief = buildBrief({
        ticket: ticketFrom([CREATED]),
        agent: agents[stage],
        worktree: '/tmp/wb/t1',
        scale,
      });
      assert.match(
        brief,
        new RegExp(`How much this warrants[\\s\\S]*${scale}`),
        `${stage}/${scale}`,
      );
    }
  }
});

test('the plan is not told a scale, because it is the stage that decides one', () => {
  const planning = buildBrief({
    ticket: ticketFrom([CREATED]),
    agent: agents.plan,
    worktree: '/tmp/wb/t1',
    scale: 'small',
  });
  assert.doesNotMatch(planning, /How much this warrants/, 'it would read its own answer back');
});

test('each agent says what the scale means for its own job, not the brief', () => {
  // The failure this catches: guidance that lives in one place and is handed to
  // three specialists says something slightly wrong to at least two of them.
  for (const scale of ['small', 'standard', 'large'] as const) {
    assert.match(agents.review.instructions, new RegExp(`\\*\\*${scale}\\*\\*`), `review/${scale}`);
    assert.match(agents.verify.instructions, new RegExp(`\\*\\*${scale}\\*\\*`), `verify/${scale}`);
  }
});

test('the stages that can write are told where to put working-out', () => {
  const brief = buildBrief({
    ticket: ticketFrom([CREATED]),
    agent: agents.verify,
    worktree: '/tmp/wb/t1',
    scratch: '/tmp/wb/t1.scratch',
  });

  assert.match(brief, /\/tmp\/wb\/t1\.scratch/);
});

test('the stages that cannot write are not told about a place to write', () => {
  // Plan and review have no Write, Edit or Bash. A scratch directory means nothing
  // to them, and saying so is a paragraph of brief nobody can act on.
  for (const stage of ['plan', 'review'] as const) {
    const brief = buildBrief({
      ticket: ticketFrom([CREATED]),
      agent: agents[stage],
      worktree: '/tmp/wb/t1',
      scratch: '/tmp/wb/t1.scratch',
    });
    // The path, not the word: the plan agent's own instructions say "re-plan from
    // scratch", which is nothing to do with a directory.
    assert.doesNotMatch(brief, /t1\.scratch/, `${stage} has nothing to write with`);
  }
});

test('a ticket on somebody else’s branch is told whose it is and where the work goes', () => {
  const on = buildBrief({
    ticket: ticketFrom([{ ...CREATED, on: 'their-feature' } as typeof CREATED]),
    agent: agents.implement,
    worktree: '/tmp/wb/t1',
  });
  assert.match(
    on,
    /Where you are working[\s\S]*`their-feature`, a branch the workbench does not own/,
  );
  assert.match(on, /pushed back to it/);

  const plain = buildBrief({
    ticket: ticketFrom([CREATED]),
    agent: agents.implement,
    worktree: '/tmp/wb/t1',
  });
  assert.doesNotMatch(plain, /a branch the workbench does not own/, 'and no other ticket is');
});

test('every brief says where the agent is, and what is deliberately not there', () => {
  // Live runs opened by reading the main checkout, being refused, working out they
  // were in a worktree, and reading the same files again — four wasted calls in
  // review alone. The guard was right; nobody had told the agent.
  const brief = buildBrief({
    ticket: ticketFrom([CREATED]),
    agent: agents.implement,
    worktree: '/tmp/wb/t1',
    // Not 'workbench', which the implement instructions mention anyway: a fixture
    // has to be distinctive or matching it proves nothing about the input reaching
    // the output.
    absent: ['kept-off-disk'],
  });

  assert.match(brief, /Where you are working[\s\S]*\/tmp\/wb\/t1/);
  assert.match(brief, /kept-off-disk/, 'and what was deliberately left out of it');
});

test('the stage told to fix something is told exactly what, and no other stage is', () => {
  const ticket = ticketFrom([
    CREATED,
    { type: 'stage_started', stage: 'plan', runId: 'r1' },
    { type: 'stage_finished', runId: 'r1', outcome: 'completed', summary: 'the plan' },
    { type: 'plan_approved' },
    { type: 'stage_started', stage: 'implement', runId: 'r2' },
    { type: 'stage_finished', runId: 'r2', outcome: 'completed', summary: 'done' },
    { type: 'stage_started', stage: 'review', runId: 'r3' },
    {
      type: 'stage_finished',
      runId: 'r3',
      outcome: 'completed',
      summary: 'three things',
      changes: '- retry.ts:14 the backoff is unbounded',
    },
  ]);

  const brief = buildBrief({ ticket, agent: agents.implement, worktree: '/tmp/wb/t1' });
  assert.match(brief, /Changes to make/);
  assert.match(brief, /the backoff is unbounded/);
  // Not "already reviewed": a failing standing check is a change list too, and it
  // arrives without anybody having read the work. What is true of both is the plan.
  assert.match(brief, /revision of work already done to an approved plan/);

  // Review sees the same list, but as the round before this one and never as work
  // to do — that section is for the stage that has to make the change.
  const review = buildBrief({ ticket, agent: agents.review, worktree: '/tmp/wb/t1' });
  assert.doesNotMatch(review, /Changes to make/);
});

test('a later review is given the round before it, and a first review is not', () => {
  const ticket = ticketFrom([CREATED]);
  const round = { changes: '- retry.ts:14 the backoff is unbounded', since: '+ cap = 5' };

  const later = buildBrief({
    ticket,
    agent: agents.review,
    worktree: '/tmp/wb/t1',
    diff: '+ retry(3)\n+ cap = 5',
    previousReview: round,
  });

  assert.match(later, /## The round before this one/);
  assert.match(later, /the backoff is unbounded/);
  assert.match(later, /```diff\n\+ cap = 5\n```/, 'and what has been done since it looked');
  // The two questions only a reviewer that has seen this before can answer.
  assert.match(later, /was each of those items addressed/);
  assert.match(later, /did addressing it break anything/);
  // And the rule that stops a later round being another first round.
  assert.match(later, /only if it fails one of the completion criteria/);
  assert.match(later, /goes under `LATER:`/);

  const first = buildBrief({
    ticket,
    agent: agents.review,
    worktree: '/tmp/wb/t1',
    diff: '+ retry(3)',
  });
  assert.doesNotMatch(first, /The round before this one/, 'there is no round before the first');

  // Nobody else re-reviews, so nobody else is told what review last said.
  for (const stage of STAGES.filter((s) => s !== 'review')) {
    const brief = buildBrief({
      ticket,
      agent: agents[stage],
      worktree: '/tmp/wb/t1',
      previousReview: round,
    });
    assert.doesNotMatch(brief, /The round before this one/, `${stage} is not reviewing again`);
  }
});

test('an implement run revising a change is told what the last one said it did', () => {
  const ticket = ticketFrom([CREATED]);
  const didBefore = 'capped the backoff in retry.ts, and a test that would have caught it';

  const again = buildBrief({
    ticket,
    agent: agents.implement,
    worktree: '/tmp/wb/t1',
    diff: '+ cap = 5',
    didBefore,
  });

  assert.match(again, /## What the last implement run did/);
  assert.match(again, /capped the backoff in retry\.ts/);
  // The account and the change it produced, read together.
  assert.match(again, /The change below is what that run produced/);

  const first = buildBrief({ ticket, agent: agents.implement, worktree: '/tmp/wb/t1' });
  assert.doesNotMatch(first, /What the last implement run did/, 'a first round did nothing before');

  // Nobody else is revising it. Review and verify are judging the change itself, and
  // an account of it from the stage they are judging is not evidence.
  for (const stage of STAGES.filter((s) => s !== 'implement')) {
    const brief = buildBrief({ ticket, agent: agents[stage], worktree: '/tmp/wb/t1', didBefore });
    assert.doesNotMatch(brief, /What the last implement run did/, `${stage} is not revising it`);
  }
});

test('a ticket carrying on from another is told what it is carrying on from', () => {
  const events: EventBody[] = [
    { type: 'ticket_created', title: 'the first attempt', body: 'write the report' },
    { type: 'stage_started', stage: 'implement', runId: 'r1' },
    {
      type: 'stage_finished',
      runId: 'r1',
      outcome: 'completed',
      summary: 'wrote a draft',
      commit: 'abc1234',
      changes: undefined,
    },
    { type: 'gave_up', reason: 'planned 3 times without a result anyone accepted' },
  ];
  const stopped = ticketFrom(events);

  const story = whatHappenedTo(
    stopped,
    events.map((body, i) => ({ ...body, id: i + 1, ticketId: 't1', at: '2026-08-06T00:00:00Z' })),
  );

  assert.match(story, /1 commit\(s\)/, 'says the work is already here');
  assert.match(story, /carrying it on, not/, 'and that it is not to be written again');
  assert.match(story, /planned 3 times/, 'and why the last attempt stopped');

  const carrying = ticketFrom([
    { type: 'ticket_created', title: 'salvage it', body: 'fix the units', continues: 't1' },
  ]);
  const brief = buildBrief({
    ticket: carrying,
    agent: agents.plan,
    worktree: '/tmp/wb/t2',
    continues: story,
  });
  assert.match(brief, /What you are carrying on from/);
  assert.match(brief, /planned 3 times/);
});

test('every objection travels, not only the last one the ticket kept', () => {
  const events: EventBody[] = [
    { type: 'ticket_created', title: 'the first attempt', body: 'write the report' },
    { type: 'stage_started', stage: 'review', runId: 'r1' },
    {
      type: 'stage_finished',
      runId: 'r1',
      outcome: 'completed',
      summary: 'sent it back',
      rejected: 'the headline claim is contradicted by table 2 of the same report',
    },
    { type: 'stage_started', stage: 'review', runId: 'r2' },
    {
      type: 'stage_finished',
      runId: 'r2',
      outcome: 'completed',
      summary: 'sent it back again',
      rejected: 'the same plot-edge artefact survives in the summary',
    },
    { type: 'gave_up', reason: 'planned 3 times without a result anyone accepted' },
  ];

  const story = whatHappenedTo(
    ticketFrom(events),
    events.map((body, i) => ({ ...body, id: i + 1, ticketId: 't1', at: '2026-08-06T00:00:00Z' })),
  );

  // The ticket keeps only the latest in `rejection`. That the objection recurred is
  // the thing the next attempt most needs, and it is only visible in all of them.
  assert.match(story, /Objected to 2 times/, 'says how many times');
  assert.match(story, /contradicted by/, 'and what the first one was');
  assert.match(story, /plot-edge artefact/, 'as well as the one that followed it');
});

test('a small ticket runs under smaller ceilings, and only the ceilings change', () => {
  for (const stage of STAGES) {
    const full = agents[stage];
    const small = forScale(full, 'small');

    assert.ok(small.maxTurns <= full.maxTurns, `${stage}: fewer turns when small`);
    assert.ok(small.maxBudgetUsd <= full.maxBudgetUsd, `${stage}: less money when small`);

    // The job, the tools and the guardrails are the same job at any size.
    assert.equal(small.instructions, full.instructions);
    assert.deepEqual(small.allowedTools, full.allowedTools);
    assert.deepEqual(small.disallowedTools, full.disallowedTools);
    assert.equal(small.model, full.model);

    // Nothing declared for standard, so it is the definition as written.
    assert.deepEqual(forScale(full, 'standard'), { ...full, ...full.scales.standard });
  }

  // The one that prompted this: reviewing t13 cost more than doing it.
  assert.ok(
    forScale(agents.review, 'small').maxBudgetUsd <
      forScale(agents.implement, 'small').maxBudgetUsd,
    'reviewing a small ticket may not cost more than building it',
  );
});

test('a standard ticket builds at high effort, and only a large one at xhigh', () => {
  // Implement is 40–44% of spend and put out 20–30k tokens a run at `xhigh`. A
  // standard ticket now runs at `high`; `large` keeps the top-level ceiling. The
  // failure this catches is a silent revert of that line to `xhigh`, which would
  // undo the saving without anything else looking different.
  assert.equal(forScale(agents.implement, 'standard').effort, 'high');
  assert.equal(forScale(agents.implement, 'large').effort, 'xhigh');
});

test('a per-scale block is validated as strictly as the rest of the frontmatter', () => {
  const cases: [string, RegExp][] = [
    ['small: { effort: enormous }', /small\.effort must be one of/],
    ['small: { maxTurns: 0 }', /small\.maxTurns must be a number greater than zero/],
    ['small: { maxTurns: 2.5 }', /small\.maxTurns must be a whole number/],
    ['small: { model: something-cheap }', /small may only set effort, maxTurns, maxBudgetUsd/],
    ['small: 60', /small must be a block of ceilings/],
  ];

  for (const [line, complaint] of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-scale-'));
    fs.writeFileSync(
      path.join(dir, 'plan.md'),
      [
        '---',
        'stage: plan',
        'model: m',
        'effort: high',
        'permissionMode: dontAsk',
        'maxTurns: 40',
        'maxBudgetUsd: 5',
        'allowedTools: [Read]',
        line,
        '---',
        'do the thing',
      ].join('\n'),
    );
    assert.throws(() => loadAgent(dir, 'plan'), complaint, line);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('every stage is given the shape of the worktree, and none is given Glob', () => {
  // Plan spent a quarter of its tool calls on Glob and review an eighth, both learning
  // a shape that is the same every ticket. The map is worked out before the run starts,
  // so knowing it costs no turn at all.
  for (const stage of STAGES) {
    const brief = buildBrief({
      ticket: ticketFrom([CREATED]),
      agent: agents[stage],
      worktree: '/tmp/wb/t1',
      map: 'lib/\n  solve.py  112 lines — 5 functions',
    });

    assert.match(brief, /What is in the worktree/, stage);
    assert.match(brief, /solve\.py {2}112 lines/, stage);
  }
});

test('a tool taken away is refused in context, not at the guard', () => {
  // Dropping a tool from allowedTools only stops it being auto-approved: the model is
  // still offered it, calls it, and loses a turn to a refusal. disallowedTools is the
  // one option that takes it out of the prompt.
  for (const stage of STAGES) {
    const agent = agents[stage];
    assert.ok(
      !agent.allowedTools.includes('Glob'),
      `${stage} should orient from the map in its brief`,
    );
    assert.ok(
      agent.disallowedTools.includes('Glob'),
      `${stage} must not be offered Glob it cannot use`,
    );
  }
});

test('a brief with no map says nothing about one', () => {
  const brief = buildBrief({
    ticket: ticketFrom([CREATED]),
    agent: agents.plan,
    worktree: '/tmp/wb/t1',
  });

  assert.doesNotMatch(brief, /What is in the worktree/);
});

test('no stage is told about a tool it was not granted', () => {
  // t16 was told to follow a skill, had no tool to read one, and stopped to ask the
  // manager while holding it. The same mistake with a tool name is cheaper to make and
  // just as expensive: the agent believes the instruction, calls it, and loses a turn.
  for (const stage of STAGES) {
    const agent = agents[stage];
    const mentioned = agent.instructions.match(/mcp__wb__[a-z_]+/g) ?? [];

    for (const name of new Set(mentioned)) {
      assert.ok(
        agent.allowedTools.includes(name),
        `${stage}.md names ${name} but ${stage} is not granted it`,
      );
    }
  }
});
