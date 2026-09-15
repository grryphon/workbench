import type { CheckRun, Event, Scale, Stage } from './events.ts';

export type Status =
  /** An idea, and nothing more. The workbench never touches a ticket here. */
  | 'backlog'
  | 'queued'
  | 'planning'
  | 'plan_gate'
  | 'implementing'
  | 'reviewing'
  | 'verifying'
  | 'ready_for_pr'
  | 'awaiting_verdict'
  | 'blocked'
  | 'cancelled'
  | 'gave_up'
  | 'done';

export type Ticket = {
  id: string;
  title: string;
  body: string;
  /** Where the ticket is. The board column. */
  status: Status;
  /** The stage last started. Kept while blocked so we know what to resume. */
  stage: Stage | null;
  /** True while a stage run is in flight. */
  running: boolean;
  /**
   * Whether the run in flight is the workbench settling a clash on a branch that is
   * offered, rather than a stage the board asked for. The status is
   * `implementing` either way, so this is the only thing that can say which it is —
   * and a settle takes minutes, which is a long time for a board to say nothing.
   */
  settling: boolean;
  /** wb/<id>. The worktree path is derived from this outside the domain. */
  branch: string;
  /** The ticket this one carries on from, and whose branch it started on. */
  continues: string | null;
  /**
   * The branch this ticket works on and pushes back to, when it is one the workbench
   * does not own. Its worktree is cut from that branch as the remote has it, the base
   * it is measured against moves with it, and finishing is a push there rather than a
   * pull request of its own.
   */
  on: string | null;
  /**
   * What was pushed to `on`, and what became of the pull request on that branch once
   * somebody decided. Null until the push lands; `landed` is null until then too, and
   * stays null for a branch with no pull request, where there is nothing to watch.
   */
  pushed: {
    branch: string;
    commit: string;
    url: string | null;
    landed: 'merged' | 'squashed' | 'closed' | null;
  } | null;
  /**
   * Tickets this one must not start ahead of. Nothing runs while any of them is
   * unmet — see `heldBy`, which says what meeting one takes, and `awaitedWork`,
   * which says what of theirs this branch is then built on.
   *
   * Not the same as `continues`, and they compose: that one says where the work
   * *starts from* and is fixed when the branch is cut; these say *when*, and can
   * be set and taken off at any time.
   */
  waitsFor: string[];
  /**
   * Whether a finished plan stops for the manager. True unless the ticket says
   * otherwise — when it is written, or any time before the plan is finished, which
   * is the one moment this is read: the gate is the one place a person sees the
   * work before any money is spent building it, and skipping it is a thing to
   * choose rather than a thing to forget.
   *
   * It moves the gate, and nothing else. The plan is still written, still recorded
   * and still what review and verify judge against.
   */
  requiresApproval: boolean;
  /** Summary of the last plan run. This is what the gate shows the manager. */
  plan: string | null;
  /**
   * How much the plan judged the work to warrant. Shown at the gate, so approving
   * the plan approves its self-assessment too. Every stage still runs whatever it
   * says; only the depth asked of them changes.
   */
  scale: Scale;
  /**
   * What the plan said the work breaks into, in order. Shown at the gate, so the
   * manager approves the steps along with the plan, and used afterwards as the
   * thing progress is reported against.
   */
  steps: string[];
  /**
   * What the plan said would make this ticket finished, agreed at the gate. The
   * only thing review and verify are entitled to judge against — without it they
   * are answering "is this as good as it could be", which has no end, and which
   * is what killed the first two real tickets.
   */
  completionCriteria: string[];
  /**
   * The step the running stage says it has reached, counting from 1. Null when a
   * stage has not said, which is every stage that does not announce them.
   */
  step: number | null;
  /** Why the ticket came back to planning. Fed into the next plan. */
  rejection: string | null;
  /**
   * What review or verify asked to be put right, when the approach was sound.
   * Fed into the implement stage that addresses it, and cleared when a run of that
   * stage completes — not when one starts. A run that blocks, fails or is stopped
   * has put nothing right, and whatever runs implement again from the top has to be
   * handed the list again: t19 lost review's two items to a restart this way, and
   * bought a review to be told neither had been touched.
   */
  changes: string | null;
  /**
   * How many times this plan's work has gone back to implement to be fixed. One
   * per round of comments; reset by a new plan, which is a new approach.
   */
  revisions: number;
  /** Set while an agent is waiting on the manager. */
  question: { question: string; reasoning: string } | null;
  /**
   * The conversation a stage stopped mid-way, so answering it can carry on rather
   * than pay again for thinking already done. Null unless something is parked.
   */
  session: string | null;
  /**
   * Whether what stopped this ticket was the workbench being stopped, rather than
   * anything going wrong with the work. It parks the same way a failure does and
   * is not the same thing at all: there is a run here worth carrying on.
   *
   * Its own field rather than read off `session`, because a run killed before the
   * model service had named its conversation has no session and still has to be
   * offered — restarting it from the top is what it needs, and a ticket nobody
   * can see is one nobody restarts.
   */
  interrupted: boolean;
  /**
   * When the run parked here may carry on, for one stopped by the model service's
   * session limit. Null for every other parked run, and for every ticket that is
   * not parked at all.
   *
   * A time rather than a flag, because it is what the service actually said, and
   * because everything that reads it needs the moment and not the fact: the board
   * starts nothing until it passes, and then carries this ticket on by itself.
   */
  limitedUntil: string | null;
  /**
   * The model the run parked by that limit was using. Null whenever `limitedUntil`
   * is, and for a limit recorded before this was.
   *
   * The stages no longer share a model, so the limit has to name one: a plan held on
   * one model is no reason for an implement on another to sit still. See
   * `sessionLimits` in the orchestrator, which is the only thing that reads it.
   */
  limitedModel: string | null;
  /** The manager's reply, carried into the resumed run and cleared once it starts. */
  answer: string | null;
  /**
   * The pull request this ticket's work went to. Set when it is first opened and
   * never cleared: the branch keeps its pull request, so a ticket being reworked
   * is still headed for that one, and the link is worth most exactly then — it is
   * where the objection being answered was written.
   */
  prUrl: string | null;
  /**
   * Whether an offer is standing and waiting on the manager. Not the same as
   * having a `prUrl`, which a ticket keeps for ever once it has one: this is true
   * only between offering the work and hearing back about it.
   *
   * It cannot be read off the status, which is what it otherwise would be:
   * `blocked` replaces the status, so a ticket that got stuck while an offer stood
   * has nowhere else to record that it did. Two things need to know — shipping
   * again would be offering what is already offered, and restarting a stage means
   * something different when the stages are finished.
   */
  offered: boolean;
  /**
   * A merge the manager has asked for and the workbench has not carried out yet.
   * True only in between: an attempt that failed clears it, because a merge that
   * conflicts is not something to keep retrying on its own.
   */
  mergeRequested: boolean;
  /**
   * The ticket whose merge was holding the gate the last time this one's merge was
   * due to start, or null when nothing is in its way. One merge runs at a time, so
   * a queued one is not refused and nothing else about the ticket changes: without
   * this it reads `merging…` for as long as the queue ahead of it takes.
   */
  queuedBehind: string | null;
  /**
   * The files the base and this branch disagree about, as the last attempt to
   * bring the base in found them. Empty when there is no clash — which is the
   * ordinary state, and what anything that moves the ticket on puts it back to:
   * a stage starting, a base merged in, the ticket carrying on from being stuck,
   * or a verdict ending it. They are a fact about one attempt, not a property of
   * the ticket, so nothing may go on listing them once that attempt is history.
   */
  conflicts: string[];
  /**
   * What that attempt was merging, and the base at the time: the two are the same
   * commit when the clash was with the base itself, and otherwise the ref is the
   * branch of work this ticket waits for. A fact about the same one attempt as
   * `conflicts`, so it goes whenever they do. Null for a clash recorded before
   * this was kept, where all anything knows is the prose in the event.
   */
  conflictedWith: { ref: string; base: string } | null;
  /**
   * What this ticket's change is measured against: the commit the branch was cut
   * from, and afterwards the last base it merged in. Not a record of where it
   * started — that is in the events — but the point a diff of its own work is
   * taken from.
   */
  base: string | null;
  /**
   * The branches this one has merged that the base has not got — the work it
   * waited for, which was offered rather than merged. What keeps `base` from moving
   * onto a commit that has not got it: see `carriedWork`, which decides this.
   */
  carrying: string[];
  /** Every commit this ticket has made, oldest first. */
  commits: string[];
  /** How many times this ticket has been planned. One per trip round the loop. */
  cycles: number;
  /** What the ticket has cost so far, summed over every stage run. */
  costUsd: number;
  /**
   * How long this is likely to take, last time anything guessed. Replaced by the
   * next guess and cleared by nothing: a stale estimate is still the last thing
   * anybody knew, and a ticket with none showing looks like one nothing has read.
   */
  estimate: { range: string; why: string } | null;
};

const STATUS_FOR_STAGE: Record<Stage, Status> = {
  plan: 'planning',
  implement: 'implementing',
  review: 'reviewing',
  verify: 'verifying',
};

/**
 * How many rounds of comments one plan's work may go through before the
 * disagreement is treated as being about the approach rather than the execution,
 * and the ticket is re-planned.
 *
 * A rule rather than a spend limit: `maxCycles` and `maxTicketUsd` say what the
 * manager will pay for, this says what a repeated objection means. Two loops that
 * each terminate, instead of one that can run for ever.
 */
export const MAX_REVISIONS = 2;

/** The stage that follows a completed, approved one. Null means the loop is over. */
const NEXT_STAGE: Record<Stage, Stage | null> = {
  plan: null, // gated: the manager decides
  implement: 'review',
  review: 'verify',
  verify: null, // straight to a pull request
};

function blank(id: string): Ticket {
  return {
    id,
    title: '',
    body: '',
    // Writing a ticket down is not deciding to do it. Nothing starts until the
    // manager moves it to the queue.
    status: 'backlog',
    stage: null,
    running: false,
    settling: false,
    branch: `wb/${id}`,
    continues: null,
    on: null,
    pushed: null,
    waitsFor: [],
    requiresApproval: true,
    plan: null,
    scale: 'standard',
    steps: [],
    completionCriteria: [],
    step: null,
    rejection: null,
    changes: null,
    revisions: 0,
    question: null,
    session: null,
    interrupted: false,
    limitedUntil: null,
    limitedModel: null,
    answer: null,
    prUrl: null,
    offered: false,
    mergeRequested: false,
    queuedBehind: null,
    conflicts: [],
    conflictedWith: null,
    base: null,
    carrying: [],
    commits: [],
    cycles: 0,
    costUsd: 0,
    estimate: null,
  };
}

/**
 * What a move that is not a resume drops. `session` and `interrupted` both
 * describe one parked run, and only the two moves that go back to it — answering
 * the question it asked, or carrying the stage on — may keep them.
 *
 * Every other way off a parked ticket goes somewhere that conversation has
 * nothing to do with, and both fields have to go with it. A kept `session` is
 * resumed by the next stage to run, so a manager asking for changes would have
 * them delivered into the review's conversation instead, as a note that the
 * workbench had stopped. A kept `interrupted` puts a ticket in the pick-up modal
 * that `stage_continued` then declines to move, so the box comes back every load
 * offering a button that does nothing. A kept `limitedUntil` is worse still: it is
 * what holds every stage on that model, so a stale one pauses work nothing is
 * stopping.
 */
const movedOn = { session: null, interrupted: false, limitedUntil: null, limitedModel: null };

/**
 * What the end of the road drops. Both endings are the same shape and neither is
 * resumed, so nothing that describes work in flight may outlive them: a run that
 * reports back afterwards is a late report, not a reason for the board to go on
 * saying the ticket is settling a clash or waiting behind somebody's merge.
 */
const stoppedFor = {
  running: false,
  settling: false,
  queuedBehind: null,
  question: null,
  interrupted: false,
  limitedUntil: null,
  limitedModel: null,
};

/** Pure. No I/O, no clock. */
export function applyEvent(t: Ticket, e: Event): Ticket {
  switch (e.type) {
    case 'ticket_created':
      return {
        ...blank(e.ticketId),
        title: e.title,
        body: e.body,
        continues: e.continues ?? null,
        on: e.on ?? null,
        requiresApproval: e.requiresApproval ?? true,
      };

    case 'ticket_edited':
      return {
        ...t,
        title: e.title ?? t.title,
        body: e.body ?? t.body,
        requiresApproval: e.requiresApproval ?? t.requiresApproval,
      };

    // The two moves the manager makes by hand, and the only two. Each is ignored
    // unless the ticket is in the state the other one leaves it in, so neither can
    // reach in and pull a ticket out of work that has already started.
    case 'queued':
      return t.status === 'backlog' ? { ...t, status: 'queued' } : t;

    case 'backlogged':
      return t.status === 'queued' ? { ...t, status: 'backlog' } : t;

    case 'waits_for':
      return { ...t, waitsFor: e.tickets };

    // Where a ticket sits is a fact about the board, not about the ticket: it is
    // read back across every ticket's events at once, in `ordered`.
    case 'moved':
      return t;

    /**
     * Nothing to offer without commits, and nothing to do for work already
     * accepted or already offered. Not while a stage is running either: that run
     * still reports back, and `afterStage` would route the ticket straight out of
     * `ready_for_pr` again. Anywhere else — blocked, given up on, waiting after a
     * rejection — it goes.
     *
     * Read from `offered` rather than from `prUrl`: a ticket sent back to be
     * reworked keeps the pull request it is headed for, and shipping is exactly
     * what you want to be able to do to it.
     */
    case 'shipped':
      return t.running || t.commits.length === 0 || t.status === 'done' || t.offered
        ? t
        : // Offered as it stands, so nothing is still asked of implement: a settle over
          // this branch runs that stage, and must not be handed a list to act on.
          { ...t, status: 'ready_for_pr', question: null, changes: null, ...movedOn };

    // Put a stuck ticket back into the stage it stopped in, with nothing carried
    // over: a run that died has no conversation worth resuming and no answer to
    // read. Guarded like the two above, so it cannot reach in and restart work
    // that is already going.
    case 'stage_restarted': {
      if (t.status !== 'blocked') return t;
      const resumed = {
        ...t,
        question: null,
        answer: null,
        session: null,
        interrupted: false,
        limitedUntil: null,
        limitedModel: null,
        conflicts: [],
        conflictedWith: null,
      };

      // Unless an offer is standing, in which case there is no stage to put it back
      // into: the last one finished before the pull request was opened, and what
      // stalled is the wait for a verdict. Going round the stages again would
      // arrive at `ready_for_pr` for a branch that already has a pull request — how
      // t32 blocked itself twice on `gh pr create` with the work complete all along.
      //
      // `offered`, not `prUrl`: a ticket sent back to be reworked still has its
      // pull request, and a stage that fails during that rework must restart as a
      // stage rather than dropping it back into a wait that is already over.
      if (t.offered) return { ...resumed, status: 'awaiting_verdict' };

      return t.stage === null ? t : { ...resumed, status: STATUS_FOR_STAGE[t.stage] };
    }

    // The same move, keeping the conversation: the stage picks up where it got to
    // rather than paying for the whole thing again. Guarded like the restart above
    // and reading `offered` for the same reason, but on `interrupted` as well:
    // `blocked` is two states, and only this one has a run to carry on. The other
    // is holding a question, and carrying that on would clear it and resume the
    // agent into its own unanswered question — the loss `movedOn` exists to
    // prevent, reached through the other door.
    //
    // `interrupted` rather than a `session`, because there may be none — a run
    // killed before the model service named its conversation leaves nothing to
    // resume. That is not a reason to refuse: the stage simply starts from the
    // top, which is what a restart would have done anyway.
    case 'stage_continued': {
      if (t.status !== 'blocked' || !t.interrupted) return t;
      const carrying = {
        ...t,
        question: null,
        answer: null,
        interrupted: false,
        limitedUntil: null,
        limitedModel: null,
      };
      if (t.offered) return { ...carrying, status: 'awaiting_verdict' };
      return t.stage === null ? t : { ...carrying, status: STATUS_FOR_STAGE[t.stage] };
    }

    case 'stage_started':
      return {
        ...t,
        stage: e.stage,
        status: STATUS_FOR_STAGE[e.stage],
        running: true,
        // What this run is, said while it is going: a settle reads as itself rather
        // than as an implement stage the board asked for.
        settling: e.settling ?? false,
        // Whatever it was waiting behind, it is doing something now.
        queuedBehind: null,
        question: null,
        answer: null,
        // Whatever stopped the last run, this one is going.
        interrupted: false,
        limitedUntil: null,
        limitedModel: null,
        // A plan is what starts a trip round the loop, so it is what counts one.
        cycles: e.stage === 'plan' ? t.cycles + 1 : t.cycles,
        // A new plan re-judges the size of the work from nothing. Carrying the last
        // one's verdict forward would let a stale "small" quietly outlive the plan
        // that justified it. Its steps go the same way, for the same reason.
        scale: e.stage === 'plan' ? 'standard' : t.scale,
        steps: e.stage === 'plan' ? [] : t.steps,
        completionCriteria: e.stage === 'plan' ? [] : t.completionCriteria,
        // A new plan is a new approach, so the rounds of comments start again.
        revisions: e.stage === 'plan' ? 0 : t.revisions,
        // Read into the brief by an implement run, and kept while one is going: it
        // is spent when a run completes, in `stage_finished`. Any other stage starting
        // means nothing is asked of implement — a plan above all, which is a new
        // approach and makes the last one's list about code that no longer exists.
        changes: e.stage === 'implement' ? t.changes : null,
        // Progress belongs to a run, not to the ticket. A stage starting has made none.
        step: null,
        // A clash with the base is a fact about the branch as it was. Work is being
        // done to it again, so the paths stand until something looks afresh.
        conflicts: [],
        conflictedWith: null,
      };

    // Written while the run is still going, so it is here even when nothing ever
    // reports the run finishing. `stage_finished` still has the last word.
    case 'session_started':
      return { ...t, session: e.sessionId };

    case 'step_reached':
      return { ...t, step: e.index };

    case 'estimated':
      return { ...t, estimate: { range: e.range, why: e.why } };

    case 'agent_said':
    case 'tool_requested':
    case 'checks_run':
    // Chat changes nothing about the ticket. What it proposes changes the ticket by
    // being accepted, and that appends the ordinary event for whatever was proposed.
    case 'chat_said':
    case 'chat_accepted':
      return t; // record only; the board reads these

    case 'question_asked':
      return { ...t, question: { question: e.question, reasoning: e.reasoning } };

    case 'question_answered': {
      // `interrupted` goes and `session` stays: this is one of the two moves that
      // does come back to the parked run, and it is no longer one waiting to be
      // picked up either way — the offered branch below does not go back to it,
      // but it does not leave the ticket where a stage will run, either.
      const answered = {
        ...t,
        question: null,
        running: false,
        settling: false,
        queuedBehind: null,
        interrupted: false,
        limitedUntil: null,
        limitedModel: null,
        conflicts: [],
        conflictedWith: null,
      };

      // An offer standing means the stages are over: what stopped was the wait for
      // a verdict, and there is no stage to put the ticket back into. t61 paid for
      // verify twice this way — the poll failed, answering it re-ran the stage that
      // had already passed, and only then did it come back to the wait it never
      // left. `stage_restarted` reads `offered` for the same reason.
      //
      // The answer goes nowhere, because there is nothing to say it to. Keeping it
      // would be worse than dropping it: the next stage to run is the one after a
      // rejection, and it would open with a reply to a question about something
      // else entirely.
      if (t.offered) return { ...answered, status: 'awaiting_verdict' };

      // Resume the stage that stopped. Nothing is redone from scratch.
      return {
        ...answered,
        answer: e.answer,
        status: t.stage ? STATUS_FOR_STAGE[t.stage] : 'queued',
      };
    }

    // A branch just cut carries nothing: it is the base and nothing else until the
    // work this ticket waited for is merged onto it.
    case 'branched':
      return { ...t, branch: e.branch, base: e.base, carrying: [] };

    // The merge commit is the ticket's, and the new base is what its change is now
    // measured against — `diff` reads `base...HEAD`, so leaving the old one there
    // would show a reviewer everything the base gained as though the ticket had
    // written it.
    //
    // Except for a ticket carrying on from another: its base is that ticket's
    // branch, and moving it to the base proper is the same mistake the other way
    // round — the earlier ticket's work would read as this one's.
    //
    // And except while the branch is standing on work it waited for, which is
    // offered and so is in no commit of the base: moving there would hand every
    // stage the dependency's change as this ticket's.
    //
    // A base held that way is not on its own a description of what the branch stood
    // on — the base has moved since, and everything it gained would read as this
    // ticket's work. That is `diff`'s to fix, not this reducer's: it merges the base
    // recorded here with the base as it now is and with every branch `carrying`
    // names, so what a stage is shown is measured from all of them at once. What is
    // held here is only the one thing no later commit can recover, which is where
    // this branch was before it took anything in.
    //
    // What the branch is standing on is asked of the branch, not of the refresh that
    // last touched it: `carrying` is every merge in it the base has not got, and it
    // stops naming one when that work lands rather than when its ticket stops
    // offering it. Read from `took` when a refresh recorded before this existed says
    // nothing else — those events then mean exactly what they always did.
    case 'refreshed': {
      const carrying = e.carrying ?? e.took ?? [];
      const held = t.continues !== null || (carrying.length > 0 && t.commits.length > 0);
      return {
        ...t,
        base: held ? t.base : e.base,
        carrying,
        commits: [...t.commits, e.commit],
        // Whatever was in the way of its merge, this branch has moved since.
        queuedBehind: null,
        // The base went in, and it went in cleanly. Whatever the branch last
        // clashed with is settled by that.
        conflicts: [],
        conflictedWith: null,
      };
    }

    // Record only, unlike `refreshed`: there is no commit and the base has not
    // moved. The merge is on disk, and the stage now running is what finishes it.
    case 'conflicted':
      return t;

    case 'stage_finished': {
      // The spend counts whatever the outcome: a failed run still cost money, and
      // a commit it left behind is part of the ticket's record either way.
      const recorded = {
        ...t,
        costUsd: t.costUsd + (e.costUsd ?? 0),
        // Named twice for one commit when the stage finished a merge it was handed:
        // by the `refreshed` that moves the base, and here by the stage that made it.
        commits:
          e.commit !== undefined && !t.commits.includes(e.commit)
            ? [...t.commits, e.commit]
            : t.commits,
        scale: e.scale ?? t.scale,
        steps: e.steps ?? t.steps,
        // Events are stored and replayed, so a ticket planned before the rename
        // still carries the criteria under the key it was written with.
        completionCriteria:
          e.completionCriteria ?? (e as { doneWhen?: string[] }).doneWhen ?? t.completionCriteria,
        // Set only by a run that stopped with something left to say; anything else
        // clears it, so nothing ever resumes a conversation that has finished.
        session: e.sessionId ?? null,
        // An implement run that completed has answered the list, and a new one, if
        // this run earned one, is set by `afterStage` below. One that blocked, failed
        // or was stopped has answered nothing, so the list stands for whatever runs
        // implement next — a resume, an answer, a restart from the top. Nor has a
        // settle, which runs on offered work and was handed no list: one here arrived
        // while it ran, from an answer to the pull request, and is the next run's.
        changes:
          t.stage === 'implement' && e.outcome === 'completed' && !e.settling ? null : t.changes,
      };
      return afterStage(recorded, e);
    }

    case 'plan_approved':
      return { ...t, status: 'implementing', running: false, rejection: null, ...movedOn };

    // The manager's two ways of saying no, and the only difference between them is
    // what they cost: this one buys a new plan, the next one keeps the work.
    // Either ends the offer without touching `prUrl` — the branch keeps its pull
    // request, and the rework is pushed to that same one.
    case 'plan_rejected':
      return {
        ...t,
        status: 'planning',
        running: false,
        offered: false,
        mergeRequested: false,
        rejection: e.reason,
        // The approach is what is being objected to now, so a list of details to
        // put right in it is not still asked for.
        changes: null,
        ...movedOn,
      };

    // Not capped, and no revision counted: see `changes_requested` in events.ts.
    case 'changes_requested':
      return {
        ...t,
        status: 'implementing',
        running: false,
        // The answer ends the offer, so it ends everything the offer was waiting on
        // with it: a settle over that branch, and a merge that was queued behind
        // somebody else's. Without these the card goes on saying "queued behind t1"
        // over a ticket the manager has already sent back, until some later stage
        // starts and clears it — which at capacity is a long wait.
        settling: false,
        queuedBehind: null,
        offered: false,
        mergeRequested: false,
        changes: e.changes,
        ...movedOn,
      };

    case 'pr_opened':
      return { ...t, status: 'awaiting_verdict', prUrl: e.url, offered: true };

    // The end of a ticket on somebody else's branch. Nothing is offered and nothing
    // waits on the manager: the push is what finishing is, and how that branch reaches
    // the base is decided by whoever owns it.
    case 'pushed':
      return {
        ...t,
        status: 'done',
        offered: false,
        mergeRequested: false,
        queuedBehind: null,
        conflicts: [],
        conflictedWith: null,
        pushed: { branch: e.branch, commit: e.commit, url: e.url ?? null, landed: null },
        ...movedOn,
      };

    case 'landed':
      return t.pushed === null ? t : { ...t, pushed: { ...t.pushed, landed: e.how } };

    case 'blocked':
      // An ended ticket stays ended. Nothing should be parking one in the first
      // place, but a late report is the shape of the mistake — the same one
      // `afterStage` guards against — and a stopped ticket coming back onto the
      // board as a question for the manager is the worst way to find out.
      if (ended(t)) return t;
      return {
        ...t,
        status: 'blocked',
        running: false,
        // Whatever the manager asked for did not happen. Asking again is theirs to
        // decide, once they know what stopped it — and it is not waiting for
        // anything now that there is nothing left of it to wait for.
        mergeRequested: false,
        queuedBehind: null,
        conflicts: e.conflicts ?? [],
        conflictedWith: e.conflictedWith ?? null,
        question: {
          question: e.reason,
          reasoning: 'the workbench could not carry on by itself',
        },
      };

    // Both are the end of the road. Nothing resumes them, so nothing is kept for a
    // resumed run; the reason is in the event log, which is where the board reads it.
    case 'cancelled':
      return { ...t, status: 'cancelled', ...stoppedFor };

    case 'gave_up':
      return { ...t, status: 'gave_up', ...stoppedFor };

    case 'merge_requested':
      return { ...t, mergeRequested: true };

    // Nothing about the ticket changes but what it is able to say: the merge was
    // not refused, so `mergeRequested` stands and the tick after the gate frees is
    // the one that carries it out.
    case 'merge_queued':
      return { ...t, queuedBehind: e.behind };

    // A rejection ends the offer as well as the round: the reworked ticket is
    // offered again, on the same branch and so on the same pull request — which is
    // why `prUrl` stays. It is `offered` that ends, so the ticket can be shipped
    // and its stages restarted while it is being put right.
    //
    // Either way the wait is over, so a clash found during it stops being news: a
    // merged ticket that still listed conflicting paths would be offering to send
    // finished work back to resolve them.
    case 'verdict':
      return e.verdict === 'accepted'
        ? {
            ...t,
            status: 'done',
            offered: false,
            mergeRequested: false,
            queuedBehind: null,
            conflicts: [],
            conflictedWith: null,
            ...movedOn,
          }
        : {
            ...t,
            status: 'planning',
            offered: false,
            mergeRequested: false,
            queuedBehind: null,
            conflicts: [],
            conflictedWith: null,
            rejection: e.reason ?? null,
            ...movedOn,
          };
  }
}

function afterStage(t: Ticket, e: Extract<Event, { type: 'stage_finished' }>): Ticket {
  const stopped = { ...t, running: false, settling: false };

  // A stopped ticket still hears back from the run it had in flight. It has already
  // ended; the late report must not resurrect it as blocked.
  if (t.status === 'cancelled' || t.status === 'gave_up') return stopped;

  // Not a stage the board asked for: the workbench settling a clash on a branch
  // that was offered. What it goes back to is the wait it interrupted, and nothing
  // else — review and verify have passed on this work already, and going round
  // again would arrive at `ready_for_pr` for a branch that has had a pull request
  // all along.
  //
  // Ahead of the outcome branches, because the outcomes are not this run's to
  // decide either. A settling run takes minutes, and an answer arriving in them
  // ends the offer and puts the ticket somewhere of its own: a settle that then
  // failed would mark a merged ticket `blocked`, or a ticket carrying the
  // manager's requested changes `blocked` and lose them at the next stage. So a
  // settling run sets no status at all where the offer has ended. Nothing goes
  // unparked by that: `refresh` in merging.ts appends the `blocked` event, with
  // the conflicting paths, on every outcome but a resolution that landed.
  if (e.settling) return t.offered ? { ...stopped, status: 'awaiting_verdict' } : stopped;

  // A crash is not a rejection. It parks and waits for the manager, same as a question.
  if (e.outcome === 'blocked' || e.outcome === 'failed') {
    return { ...stopped, status: 'blocked' };
  }

  // Nor is being stopped a crash. It parks in the same place — the manager decides
  // what happens to it and nothing happens on its own — but it says which of the
  // two it was, because one of them has a run underneath it worth carrying on.
  // A session limit is one of these: the service said come back later, and said
  // when. Nothing else about the parking differs — what the time changes is that
  // nobody has to do the coming back.
  if (e.outcome === 'interrupted') {
    return {
      ...stopped,
      status: 'blocked',
      interrupted: true,
      limitedUntil: e.limitedUntil ?? null,
      limitedModel: e.limitedModel ?? null,
    };
  }

  // An offer standing means the stages are over, so there is no next one to route
  // to, and the wait is what a run reporting into one goes back to. The belt: the
  // settling run, which is the one that gets here on purpose, is routed above.
  // Without this the ticket walks on into a review and a verify of work that has
  // passed both, and arrives at `ready_for_pr` holding a pull request.
  // `stage_restarted` and `question_answered` read `offered` for the same reason.
  if (t.offered) return { ...stopped, status: 'awaiting_verdict' };

  if (e.rejected !== undefined) {
    return { ...stopped, status: 'planning', rejection: e.rejected };
  }

  // Comments on work whose approach is sound: back to the stage that made it,
  // carrying what to put right. Only so many times — an objection that survives
  // being addressed twice is evidence about the approach, not the execution, and
  // that is a matter for a new plan.
  if (e.changes !== undefined) {
    return t.revisions + 1 > MAX_REVISIONS
      ? {
          ...stopped,
          status: 'planning',
          rejection: `after ${t.revisions} attempts to address it: ${e.changes}`,
        }
      : {
          ...stopped,
          status: 'implementing',
          changes: e.changes,
          revisions: t.revisions + 1,
        };
  }

  const stage = t.stage;
  if (stage === null) return stopped;

  // The one place the gate is a gate. A ticket written without one goes straight
  // on to build what it just planned — the plan is still written and still what
  // the later stages are held to; nobody is asked to agree it first.
  if (stage === 'plan') {
    const planned = { ...stopped, plan: e.summary };
    return t.requiresApproval
      ? { ...planned, status: 'plan_gate' }
      : { ...planned, status: 'implementing' };
  }
  if (stage === 'verify') {
    return { ...stopped, status: 'ready_for_pr' };
  }

  const next = NEXT_STAGE[stage];
  return next ? { ...stopped, status: STATUS_FOR_STAGE[next] } : stopped;
}

/**
 * A ticket that is over. Nothing further happens to one of these, and everything
 * else can still be stopped — including one sitting in the backlog, which the
 * panel used to offer no way out of at all: an idea you decided against stayed on
 * the board for ever, though `wb cancel` would have taken it off all along.
 *
 * Stated as the three endings rather than as the ten statuses that are not, so a
 * status added later is stoppable by default. That is the safe way round: the
 * cost of forgetting is a button that should not be there, not a ticket nothing
 * can stop.
 */
export function ended(t: Ticket): boolean {
  return t.status === 'done' || t.status === 'cancelled' || t.status === 'gave_up';
}

/**
 * What the standing checks last said. Read by the stages that are told about them
 * rather than running them — review and verify both get the results of the implement
 * run that produced the change in front of them.
 *
 * Not a field on `Ticket`: every ticket is shipped on every poll of the board, and a
 * check's output is up to 4 kB of it. This is asked for once, by the run that needs
 * it, from events that are being read anyway.
 *
 * Nothing survives the start of a plan or an implement run. Those two are what
 * change the tree the checks were run against, so results from before one say
 * nothing about the code a later stage is looking at — and a run that is still going
 * has not produced any of its own yet.
 */
export function lastChecks(events: Event[]): CheckRun[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e === undefined) continue;
    if (e.type === 'checks_run') return e.results;
    if (e.type === 'stage_started' && (e.stage === 'plan' || e.stage === 'implement')) return [];
  }
  return [];
}

/**
 * What review last asked for, and the commit the branch stood at when it asked.
 * Read by the next review of the same plan, so a later round checks the round
 * before it rather than starting again — see `lastRoundFor` in `agents/brief.ts`.
 *
 * Not `ticket.changes`: that is cleared the moment implement completes, and is long
 * gone by the time review runs again. Not a field of its own either, for the same
 * reason as `lastChecks` — it is asked for once, by the run that needs it.
 *
 * Only review's own list. A verify objection and a manager's `changes_requested`
 * are somebody else's words, and a reviewer asked whether they were addressed
 * would be checking work against a standard it never set.
 *
 * A review that finishes with nothing to ask for has settled its own list, and that
 * is the end of it. Otherwise a ticket sent back round by verify arrives at review
 * again carrying a list an earlier review already accepted as done, measured from a
 * commit that same review had read: both halves of "you asked for these, and this is
 * what has happened since you looked" would be false. Only a review that reached a
 * verdict has settled its list, though: `blocked` is a question to the manager,
 * `failed` is a crash or a budget ceiling or the manager stopping the run, and
 * `interrupted` is the finish `reconcile` writes for a run nobody is left to answer.
 * None of those said anything about the list, so a live list has to survive them all.
 *
 * Nothing survives the start of a plan: a new plan is a new approach, and the last
 * one's objections are about code that no longer exists. `revisions` resets there
 * too, so this is the same round the cap counts.
 */
export function lastReviewChanges(events: Event[]): { changes: string; at: string | null } | null {
  let found: { changes: string; at: string | null } | null = null;
  /** The stage now running: a ticket runs one at a time, so this says whose a verdict is. */
  let stage: Stage | null = null;
  /** HEAD as of here, which for the review below is what its diff was measured from. */
  let head: string | null = null;

  for (const e of events) {
    if (e.type === 'stage_started') {
      stage = e.stage;
      if (e.stage === 'plan') found = null;
    } else if (e.type === 'stage_finished') {
      if (stage === 'review' && e.outcome === 'completed') {
        found = e.changes === undefined ? null : { changes: e.changes, at: head };
      }
      if (e.commit !== undefined) head = e.commit;
    } else if (e.type === 'refreshed') {
      head = e.commit;
    }
  }

  return found;
}

/**
 * What the last implement run said it had done. Read by the next implement run on the
 * same plan — a round sent back for changes — which starts a fresh conversation holding
 * the plan and the objections and nothing about the work it is being asked to revise,
 * and rediscovers its own commits by reading files.
 *
 * Only implement's own account. Review and verify describe the same code from outside,
 * as a list of what is wrong with it, and the stage already has that as work to do.
 *
 * Only a run that completed, too: `blocked` is a question to the manager, `failed` is a
 * crash or a budget ceiling or the manager stopping the run, and `interrupted` is the
 * finish `reconcile` writes for a run nobody is left to answer. None of them said
 * anything about the work, so the last real account has to survive them all.
 *
 * Nothing survives the start of a plan: a new plan is a new approach, and the last
 * one's account is of code that no longer exists.
 *
 * Not a field of the ticket, for the same reason as `lastChecks` and
 * `lastReviewChanges` — it is asked for once, by the run that needs it.
 */
export function lastImplementSummary(events: Event[]): string | null {
  let found: string | null = null;
  /** The stage now running: a ticket runs one at a time, so this says whose an account is. */
  let stage: Stage | null = null;

  for (const e of events) {
    if (e.type === 'stage_started') {
      stage = e.stage;
      if (e.stage === 'plan') found = null;
    } else if (e.type === 'stage_finished' && stage === 'implement' && e.outcome === 'completed') {
      found = e.summary;
    }
  }

  return found;
}

export function deriveTicket(events: Event[]): Ticket {
  const first = events[0];
  if (first === undefined || first.type !== 'ticket_created') {
    throw new Error('event list must start with ticket_created');
  }
  return events.reduce(applyEvent, blank(first.ticketId));
}
