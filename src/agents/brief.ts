import type { CheckRun, Event, Scale } from '../domain/events.ts';
import type { Ticket } from '../domain/ticket.ts';
import type { AgentDef, SkillDef } from './load.ts';

export type BriefInput = {
  ticket: Ticket;
  agent: AgentDef;
  /**
   * Where the agent is working. Told rather than discovered: every live stage so
   * far has opened by reading the main checkout, being refused, working out that
   * it is in a worktree, and reading the same files again — four wasted tool calls
   * in review, two in plan, on a ticket with two files in it. The guard is right to
   * refuse; the agent was never told.
   */
  worktree: string;
  /**
   * What this project is, stated once rather than rediscovered per ticket. Verify
   * hunted for CI configuration that does not exist, tried `pytest --collect-only`,
   * and grepped the tree for references — all of it learning a shape that is the
   * same for every ticket.
   */
  about?: string;
  /**
   * Where working-out goes. Told only to the stages that can write: an agent with
   * nowhere to put a probe puts it in the worktree, and it ships.
   */
  scratch?: string;
  /** Directories that are deliberately absent from that worktree. */
  absent?: readonly string[];
  /**
   * Every file in the worktree and what is in it, worked out from the source before
   * the stage starts. Plan spends a quarter of its tool calls on `Glob` and review an
   * eighth, both of them learning a shape that is the same every ticket — and a turn
   * spent learning it costs the whole context, not the few hundred bytes it returns.
   */
  map?: string;
  /**
   * The expertise this stage is holding, and the names it types to read it. Loaded
   * into every session and never mentioned: t16 was told to follow a skill, looked
   * for it as a file, was refused every path it tried, and stopped to ask — having
   * had the thing all along. A tool nobody knows about is a tool nobody uses.
   */
  skills?: readonly SkillDef[];
  /**
   * The change so far. Given to review and verify; they do not go looking for it, and
   * nor does an implement run revising a change that is already committed.
   */
  diff?: string;
  /**
   * What the last implement run said it had done, given to the implement run revising
   * it. Nothing else is shown it: review and verify are judging the change itself, and
   * an account of it from the stage they are judging is not evidence.
   */
  didBefore?: string;
  /**
   * The last round of review on this plan: what it asked for, and the change made
   * since it looked. Given to review alone and only from its second round on, so a
   * later round checks that round rather than reviewing from nothing.
   *
   * `since` is absent when nothing had been committed when it looked — and then `diff`
   * above is the whole of what has happened since, so there is nothing else to show.
   * It is present but empty when there was a commit and nothing has been added to it:
   * the run in between ended without committing. Those are different facts and the
   * brief tells them apart.
   */
  previousReview?: { changes: string; since?: string };
  /**
   * The standing checks the workbench has already run, and their output. Given to
   * review and verify, from the implement run that produced the change in front of
   * them: a failure would have sent that run back for another round, so what reaches
   * a stage here has passed. Empty means there is no observed output about the tree
   * this stage is looking at — nothing configured, or results withheld because the
   * stage's own refresh merged a base in (see `loop.ts`) — which the brief says rather
   * than leaving an agent to assume a suite it cannot see.
   */
  checks?: readonly CheckRun[];
  /**
   * A merge the workbench started before this stage and could not finish. It is in
   * the worktree, and finishing it is the first thing this stage does. `with` is the
   * branch it is against when that is not the base: the offered work this ticket
   * waited for, which a name says more about than a sha would.
   */
  conflict?: { base: string; paths: readonly string[]; with?: string };
  /** The manager's answer, when this run is resuming a blocked ticket. */
  answer?: string;
  /**
   * What an earlier ticket left here, and why it stopped. Its work is already in
   * this worktree — it is what the branch was cut from — so the danger is not that
   * the agent cannot find it but that it does not realise it is there, and writes
   * the whole thing again. Whatever stopped that ticket is the most valuable thing
   * this one can be told, because otherwise it is rediscovered at full price.
   */
  continues?: string;
  /** How much the plan judged the work to warrant. Not shown to the plan itself. */
  scale?: Scale;
};

/**
 * Assembles what one stage is told. Sections are omitted when empty rather than
 * included as "none", so an agent never reads a heading with nothing under it.
 */
export function buildBrief(input: BriefInput): string {
  const { ticket, agent } = input;

  const sections: [string, string | undefined][] = [
    ['About this project', nested(input.about)],
    ['Where you are working', whereYouAre(input)],
    ['A merge to finish first', mergeToFinish(input)],
    ['What is in the worktree', worktreeMap(input.map)],
    ['What you know how to do', skillsHeld(input.skills)],
    ['Ticket', `${ticket.title}\n\n${ticket.body}`.trim()],
    ['What you are carrying on from', input.continues],
    ['Why this came back', ticket.rejection ?? undefined],
    ['The plan they rejected', rejectedPlanFor(agent, ticket)],
    ['Changes to make', changesFor(agent, ticket)],
    ['The approved plan', planFor(agent, ticket)],
    ['Completion criteria', completionCriteriaFor(agent, ticket)],
    ['Answer to your question', input.answer],
    ['How much this warrants', declaredScale(input)],
    ['The round before this one', lastRoundFor(input)],
    ['What the last implement run did', whatYouDidBefore(input)],
    ['The change so far', fenced(input.diff, 'diff')],
    ['Checks already run', checksRun(input.checks)],
  ];

  const body = sections
    .filter((s): s is [string, string] => s[1] !== undefined && s[1] !== '')
    .map(([heading, text]) => `## ${heading}\n\n${text}`)
    .join('\n\n');

  return `${agent.instructions}\n\n---\n\n${body}\n`;
}

/**
 * What became of a ticket, for the one carrying on from it. Its commits are the
 * branch this ticket started on, so the work is already here; what is not here,
 * and is worth more than the work, is why it stopped — every objection it drew is
 * the first thing the next attempt should answer.
 *
 * This is the only way any of it travels. The objections are events in a database
 * the worktrees deliberately cannot see, so an agent that is not told cannot find
 * out, however hard it looks.
 */
export function whatHappenedTo(ticket: Ticket, events: readonly Event[]): string {
  const ended = [...events].reverse().find((e) => e.type === 'cancelled' || e.type === 'gave_up');

  const lines = [
    `**${ticket.id} — ${ticket.title}**`,
    '',
    `Its work is already in this worktree: ${ticket.commits.length} commit(s) on the branch`,
    'you started from. Read it before you write anything. You are carrying it on, not',
    'writing it again.',
  ];

  if (ticket.body.trim() !== '') lines.push('', 'What it was asked to do:', '', ticket.body.trim());
  if (ended) lines.push('', `It stopped: ${ended.reason}`);

  const objections = events.flatMap((e) =>
    e.type === 'stage_finished' && e.rejected !== undefined ? [e.rejected] : [],
  );

  if (objections.length === 1) {
    lines.push('', 'The objection to it:', '', ...objections);
  } else if (objections.length > 1) {
    // All of them, in order, not just the last. A ticket rejected three times is
    // usually rejected three times for the same thing, and that it recurred is
    // worth more than any one of them — the last one alone reads as bad luck.
    lines.push('', `Objected to ${objections.length} times, in order:`);
    lines.push(...objections.flatMap((reason, i) => ['', `${i + 1}. ${reason}`]));
  }

  return lines.join('\n');
}

function whereYouAre({ ticket, worktree, scratch, absent, agent }: BriefInput): string {
  const lines = [
    `\`${worktree}\``,
    '',
    'This is a git worktree of its own, and everything you do happens inside it.',
    'Paths outside it are refused — including the main checkout of this same',
    'repository, which is a different directory with the same files in it.',
  ];

  if (ticket.on !== null) {
    lines.push(
      '',
      `It is cut from \`${ticket.on}\`, a branch the workbench does not own — often one`,
      'with somebody else’s pull request open on it. The change is measured against that',
      'branch, not the base, and when this ticket is finished its work is pushed back to it',
      'for whoever owns it to see.',
    );
  }

  if (absent !== undefined && absent.length > 0) {
    lines.push(
      '',
      `Deliberately not here: ${absent.map((p) => `\`${p}\``).join(', ')}. Left out of`,
      'this worktree on purpose, not missing by accident. Do not go looking for it.',
    );
  }

  if (scratch !== undefined && canWrite(agent)) {
    lines.push(
      '',
      `Working-out goes in \`${scratch}\`, which is writable and is **not** part of`,
      'what gets committed. Put throwaway probes, scratch clones and anything else',
      'you only want in order to find something out there, not in the worktree —',
      'the worktree is the change, and everything left in it ships.',
      'You do not have to tidy it up afterwards. That is the point of it.',
    );
  }

  return lines.join('\n');
}

/**
 * The merge the workbench started for this stage and could not finish.
 *
 * It is given to the agent about to work on those files because that is the one
 * moment resolving it is cheap: two tickets cut from the same commit found their
 * clash only when they were offered, after implement and verify had both run to
 * completion, and a resolution that was minutes of work became a person's problem
 * a day later in another repository.
 */
function mergeToFinish({ conflict, agent }: BriefInput): string | undefined {
  if (conflict === undefined || conflict.paths.length === 0) return undefined;

  // What is being merged in, named as the thing it is: a branch says which ticket's
  // work this has to sit beside, which is the whole of what there is to know about
  // resolving it, and a sha of a base says the same for a base.
  const what =
    conflict.with === undefined
      ? [
          `The base moved on to ${conflict.base.slice(0, 8)} while this ticket was being worked`,
          'on, and taking it in did not go cleanly. The merge is in your worktree right now,',
        ]
      : [
          `\`${conflict.with}\` is work this ticket waited for and has to land on top of, and`,
          'taking it in did not go cleanly. The merge is in your worktree right now,',
        ];

  const lines = [
    ...what,
    'with `MERGE_HEAD` set, and these files hold both sides:',
    '',
    ...conflict.paths.map((p) => `- \`${p}\``),
    '',
    'Resolve them before you do anything else, by editing the files, and `git add` each',
    'one once it is right — staging it is what tells git the path is settled, and it is',
    'the only git command here that can: `git merge`, `git checkout`, `git reset` and',
    '`git commit` are all refused, so there is no way to make this go away except to read',
    'both sides and decide. Usually both are wanted and the answer is a union of the two.',
    'You are being asked because you have the change in your head, which nobody looking',
    'at this tomorrow will.',
    '',
    'This stage cannot finish until they are resolved: a run that ends with any of them',
    'still unmerged, or still holding conflict markers, is blocked and commits nothing.',
  ];

  // The checks in the brief were run against what implement left, and this merge came
  // afterwards. Nothing has been asked of the two sides sitting together — they cannot
  // be asked of a tree full of markers — so a brief that left the section to speak for
  // itself would have this stage trusting output about a tree it is not looking at.
  if (agent.stage === 'verify') {
    lines.push(
      '',
      'Whatever the `Checks already run` section reports was run before this merge, so it',
      'says nothing about the two sides sitting together. The workbench runs them again',
      'once this stage is over, and a failure then sends the ticket back whatever verdict',
      'you gave — so run them yourself, once the merge is resolved, if you want to know',
      'what they are going to say.',
    );
  }

  return lines.join('\n');
}

/**
 * Every file, and what is defined in it. Worked out from the source, so it is true
 * rather than remembered, and free to an agent — the cost was paid before the run
 * started, by a parser rather than by a turn.
 *
 * File-level on purpose. Every symbol in this repository is about 900 lines, which is
 * worth its context only to the stage about to change one of them; what every stage
 * needs is to stop asking which files exist.
 */
function worktreeMap(map: string | undefined): string | undefined {
  if (map === undefined || map.trim() === '') return undefined;

  return [
    'Worked out from the source just now, so it is what is actually there. Listing',
    'files is a turn you do not have to spend.',
    '',
    '```',
    map.trim(),
    '```',
  ].join('\n');
}

/**
 * The workbench's own expertise, named so it can be read. This is how the project
 * says what good looks like for work of a kind, and it is worth more than anything
 * a stage would work out for itself in the same number of turns.
 *
 * Every stage gets all of it. Review has to judge a report against the standard
 * implement wrote it to, so handing them different expertise would be arranging a
 * disagreement.
 */
function skillsHeld(skills: readonly SkillDef[] | undefined): string | undefined {
  if (skills === undefined || skills.length === 0) return undefined;

  return [
    'Read one with the `Skill` tool, by the name in bold, **before** doing work of',
    'that kind — not afterwards to check. They are held by the workbench, not kept',
    'in this worktree: there is no file to find, and looking for one is refused.',
    'A ticket that names "the X SKILL" means one of these.',
    '',
    ...skills.map(({ name, description }) => `- **${name}** — ${description}`),
  ].join('\n');
}

/** Whether telling this stage about scratch space would mean anything to it. */
function canWrite(agent: AgentDef): boolean {
  return agent.allowedTools.some((t) => t === 'Write' || t === 'Edit' || t === 'Bash');
}

/**
 * The scale, stated as a bare fact. What it *means* is each agent's own business:
 * review scales how much of the surrounding code it surveys, verify scales how hard
 * it probes, and the sizes do not correspond. One paragraph handed to all three said
 * something slightly wrong to each, so the guidance now lives in `agents/*.md` where
 * a specialist can say it in its own terms — and where a human edits prose as prose.
 *
 * The plan is not told: it is the stage that decides this, and would be reading its
 * own last answer back as though it were an instruction.
 */
function declaredScale({ agent, scale }: BriefInput): string | undefined {
  if (agent.stage === 'plan' || scale === undefined) return undefined;
  return `The plan judged this **${scale}**.`;
}

/**
 * What review or verify asked to be put right, given to the stage that has to put
 * it right.
 *
 * Review is told its own last list too, but as `lastRoundFor` below — the round
 * before this one, with the change made since, rather than as work to do. It used
 * to be kept from review entirely, on the argument that a reviewer reading its own
 * words back would read them as instructions. What that bought was a stage that
 * re-reviewed from nothing every round; see "A later review checks the last one's
 * list" in `docs/design.md`.
 */
function changesFor(agent: AgentDef, ticket: Ticket): string | undefined {
  if (agent.stage !== 'implement' || ticket.changes === null) return undefined;

  return [
    'The approach is right; these are wrong. Address each one, and change nothing',
    'else — this is a revision of work already done to an approved plan, not a',
    'rewrite of it.',
    '',
    ticket.changes,
  ].join('\n');
}

/**
 * The round before this one: review's own last list, the change made since it looked,
 * and what to do with each. Review alone, and only when there was a round before.
 *
 * A review told nothing about the round before it reviews from nothing, and finds new
 * things at the first round's rate however many rounds have gone: across three projects
 * since August, review asked for changes on 39–50% of third-and-later rounds, and 91 of
 * 523 items were about docs, comments or wording. Two questions and a rule, then: the
 * questions are the ones only a reviewer that has seen this before can answer, and the
 * rule is what stops the answer being a third list as long as the first.
 */
function lastRoundFor({ agent, previousReview }: BriefInput): string | undefined {
  if (agent.stage !== 'review' || previousReview === undefined) return undefined;

  const since = fenced(previousReview.since, 'diff');

  /**
   * Three things the change since that review can be, and they say different things.
   * The middle one is the most useful of the three and the easiest to get wrong: there
   * was a commit under that review and nothing has been added to it, so nothing at all
   * has been done about the list above — which is the answer to the first question.
   */
  const sinceThen =
    previousReview.since === undefined
      ? ['Nothing had been committed when you looked, so the change below is all of it.']
      : since === undefined
        ? [
            'Nothing has been committed since you looked: the change below is the one you',
            'reviewed, unchanged.',
          ]
        : ['What has been done to it since you looked:', '', since];

  return [
    'You have reviewed this before, and asked for these:',
    '',
    previousReview.changes,
    '',
    ...sinceThen,
    '',
    'Two questions about that, before anything else: was each of those items addressed,',
    'and did addressing it break anything?',
    '',
    'You have already reviewed the rest of this. A *new* objection belongs in your verdict',
    'only if it fails one of the completion criteria — name which one. Anything else,',
    'however much better it would be, goes under `LATER:`.',
  ].join('\n');
}

/**
 * The last implement run's own account of the work, for the implement run that has to
 * revise it. A round sent back for changes is a fresh conversation that holds the plan
 * and the objections and nothing about the change they are about, so it rediscovered
 * its own commits by reading the files it had written them into.
 *
 * Immediately above `The change so far` on purpose: the account says what the run meant
 * to do and the diff says what it did, and the two are read together.
 */
function whatYouDidBefore({ agent, didBefore, diff }: BriefInput): string | undefined {
  if (agent.stage !== 'implement' || didBefore === undefined || didBefore.trim() === '') {
    return undefined;
  }

  const lines = ['What the run before you said it had done:', '', nested(didBefore) ?? ''];

  // Only when there is one. An implement run can complete without committing anything,
  // and then there is no diff section below for this to be pointing at.
  if (diff !== undefined && diff.trim() !== '') {
    lines.push(
      '',
      'The change below is what that run produced. Between the two you have the work so',
      'far: you do not need to read the files to find out what is already done.',
    );
  }

  return lines.join('\n');
}

/**
 * The finish line, as the plan set it and the manager agreed it. Not shown to the
 * plan, which is writing it. Shown to everyone else because it is the difference
 * between "is this done" — a question with an answer — and "is this as good as it
 * could be", which has none, and which is what ended the first two real tickets.
 */
function completionCriteriaFor(agent: AgentDef, ticket: Ticket): string | undefined {
  if (agent.stage === 'plan' || ticket.completionCriteria.length === 0) return undefined;

  const asked =
    agent.stage === 'implement'
      ? 'Build the smallest thing that makes all of these true. Nothing beyond them.'
      : 'These, and defects. Anything else you would like is a later ticket, not a verdict.';

  return [...ticket.completionCriteria.map((d) => `- ${d}`), '', asked].join('\n');
}

/**
 * The approved plan. The plan stage is writing one, so it is never shown an approved
 * plan — only, in `rejectedPlanFor`, the one it has to replace.
 */
function planFor(agent: AgentDef, ticket: Ticket): string | undefined {
  return agent.stage === 'plan' ? undefined : nested(ticket.plan ?? undefined);
}

/**
 * The plan the objection above is about, shown to the plan stage alone and only while
 * an objection is standing.
 *
 * Rejecting a plan is the manager's main hold over the loop, and it was the part the
 * workbench handled worst: the next plan was given the objection and not the plan it
 * was against. t48's second plan was asked "why does it say no design requirement?"
 * without sight of the sentence that said it, and re-read seven files working out what
 * it had written.
 *
 * A fresh run rather than a resumed conversation, and said to be disposable. What comes
 * back is usually an objection to the approach, and a plan defended instead of rewritten
 * is how two tickets died.
 */
function rejectedPlanFor(agent: AgentDef, ticket: Ticket): string | undefined {
  if (agent.stage !== 'plan' || ticket.rejection === null || ticket.plan === null) {
    return undefined;
  }

  return [
    'What was objected to. It is here so you can see what they meant, not so you can',
    'defend it — keep none of it if none of it is right.',
    '',
    nested(ticket.plan) ?? '',
  ].join('\n');
}

/**
 * Markdown the brief is quoting rather than saying — the project's file, a plan —
 * comes with its own headings. Left as they are, they sit at the same level as this
 * brief's sections, so the project's "How to work here" reads as an instruction the
 * workbench is giving, and a plan's own headings read as more of them. Demoted two
 * levels, they nest under the heading that introduces them and it stays obvious
 * which is which.
 *
 * Headings inside code fences are left alone: there, `#` is a shell comment.
 */
function nested(markdown: string | undefined): string | undefined {
  const text = markdown?.trim();
  if (text === undefined || text === '') return undefined;

  let inFence = false;
  return text
    .split('\n')
    .map((line) => {
      if (/^\s*```/.test(line)) inFence = !inFence;
      return inFence ? line : line.replace(/^(#{1,4}) /, '##$1 ');
    })
    .join('\n');
}

function fenced(text: string | undefined, lang: string): string | undefined {
  if (text === undefined || text.trim() === '') return undefined;
  return `\`\`\`${lang}\n${text.trim()}\n\`\`\``;
}

/**
 * What the workbench already ran, and what it said. Review and verify are told this
 * so they do not spend turns re-running commands whose result is already a matter of
 * record — and so they know what *was* covered, which is what says what was not.
 */
function checksRun(checks: readonly CheckRun[] | undefined): string | undefined {
  if (checks === undefined) return undefined;

  // Said rather than left out. A stage that is given no section at all fills the gap
  // with what its instructions told it to expect — that the suite has been run and
  // passed — and goes looking for output nobody produced.
  if (checks.length === 0) {
    return [
      '**Nothing has been run against the tree in front of you.** There is no observed',
      'output about this change: do not assume a suite has passed.',
    ].join('\n');
  }

  const lines = [
    'These were run for you, in this worktree, after the implement run that produced',
    'this change. You do not need to run them again, and re-running them to confirm is',
    'a wasted turn.',
    '',
  ];

  for (const { command, ok, output } of checks) {
    lines.push(`**\`${command}\`** — ${ok ? 'passed' : 'FAILED'}`);
    if (output.trim() !== '') lines.push('', '```', output.trim(), '```');
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}
