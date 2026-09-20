export type Stage = 'plan' | 'implement' | 'review' | 'verify';

/**
 * How much the work warrants, as the plan judged it. Every stage runs at every
 * scale — this changes how deep each one goes, never whether it happens. Four
 * agent runs to delete two files was the right process at the wrong depth.
 */
export type Scale = 'small' | 'standard' | 'large';

/**
 * `interrupted` is written for a run that was stopped rather than answered — by
 * `reconcile`, for one nobody is left to answer for; by the orchestrator, for one the
 * manager stopped the workbench out from under; and by the run itself for the one
 * ending that stops it with a time to come back at, the model service's session limit
 * (see `readSessionLimit`). Being stopped is not failing, and the difference is what
 * lets the stage carry on rather than begin again.
 */
export type RunOutcome = 'completed' | 'blocked' | 'failed' | 'interrupted';

/**
 * One standing check, run by the workbench itself rather than by an agent. That is
 * the point of it: whether the tests pass is the most important fact about a ticket,
 * and it should be observed and recorded, not reported by something with an opinion.
 */
export type CheckRun = { command: string; ok: boolean; output: string };

/** What bringing the base, and whatever else was asked for, into a branch did. */
export type Refreshed =
  /** The branch already had all of it. Nothing happened, and nothing is recorded. */
  | { kind: 'up-to-date' }
  /** `merged` is every ref that landed, the base among them when it was one of them. */
  | { kind: 'merged'; base: string; commit: string; merged: string[] }
  /**
   * One of them would not merge, and that one was left out. Anything merged before
   * it stands, so the branch is as far along as it got — `with` is the ref that
   * stopped it, which is what a person has to be told to do anything about it.
   *
   * Said in data as well as in prose: `merged` is what landed before the failure and
   * `commit` is the HEAD they left, so a caller can record a branch that has moved
   * rather than one it wrongly believes is where it was.
   *
   * `merging` says what became of the one that would not go: either the branch is
   * exactly as that ref found it, or that merge is still going, on disk, for a stage
   * to finish. A caller that did not ask to keep one can still be told this, by a
   * merge an earlier run left behind.
   */
  | {
      kind: 'conflicted';
      base: string;
      paths: string[];
      with: string;
      merged: string[];
      commit: string;
      merging: boolean;
    };

/**
 * Something the chat agent thinks should be done to the ticket, offered for the
 * manager to accept with a click. Never one of its own powers: every proposal is
 * an action the manager already had, so accepting one appends exactly the event
 * the button would have.
 *
 * `action` is a plain string because this is read out of what a model wrote, and
 * what a model wrote can say anything. Which strings are actions is `CHAT_ACTIONS`,
 * and it is checked when the proposal is accepted rather than when it is read —
 * so a proposal nobody can act on still comes back with a reason why.
 */
export type Proposal = {
  action: string;
  /** Why it is proposing this, in its own words. Shown beside the button. */
  why: string;
  /** For `edit`: whichever of these it wants to rewrite. */
  title?: string;
  body?: string;
  /** For `changes`, what to put right; for `reject`, why the approach is wrong. */
  text?: string;
};

/**
 * Everything else in the system is derived from this list.
 * Events are appended and never updated or deleted.
 *
 * `runId` means one thing wherever it appears: the stage run this belongs to, as
 * the orchestrator made it for `stage_started`. Grouping by it gives you a stage.
 * The runners are told theirs rather than inventing one — they used to put a
 * per-message id here, which meant a run's own events all claimed to be different
 * runs. The one exception is deliberate and reads as itself: a `stage_finished`
 * written by `reconcile` says `interrupted`, because no run is answering it.
 */
export type EventBody =
  | {
      type: 'ticket_created';
      title: string;
      body: string;
      /**
       * The ticket this one carries on from, when it does. Its branch is where
       * this one starts, so whatever it left behind is here to be worked on —
       * the only way work survives a ticket that was not accepted.
       */
      continues?: string;
      /**
       * Whether the plan waits for the manager. Absent means it does, so every
       * ticket written before this existed keeps the gate it was created under.
       * Written only when it is `false`, because that is the half worth saying.
       */
      requiresApproval?: boolean;
    }
  /**
   * The manager rewrote the ticket. Whichever field is here replaces what was
   * there; the rest are left alone. Title and body are what the ticket *is*, so a
   * stage that has not started yet is briefed from the new words — and one already
   * running keeps the brief it was given, because it has already read it.
   *
   * `requiresApproval` is how it is to be worked: whether the next plan to finish
   * stops for the manager. It is read at that moment and no other, so it can be
   * said right up to it — a plan stage already running stops, or does not, as the
   * ticket says when it finishes.
   */
  | { type: 'ticket_edited'; title?: string; body?: string; requiresApproval?: boolean }
  /** The manager committed to the work. Until this, the workbench leaves it alone. */
  | { type: 'queued' }
  /** Taken back out of the queue, before anything started on it. */
  | { type: 'backlogged' }
  /**
   * The manager put this ticket somewhere else in the board's order — `before` is
   * the ticket it now sits in front of, or null for the end.
   *
   * Order is not decoration: the workbench takes work from the top, so this is how
   * the manager says which of several committed tickets goes first. Written as a
   * neighbour rather than as a position, because a position means something
   * different the moment anything else moves.
   */
  | { type: 'moved'; before: string | null }
  /**
   * This ticket must not start a stage until every one of `tickets` has offered
   * its work or ended — and whatever of it is offered is merged into this ticket's
   * branch before that stage runs, because an offer is not a merge and the base
   * does not have it. The whole set each time, not a difference: the manager picks
   * what it waits for and this is what they picked. Empty is no condition.
   */
  | { type: 'waits_for'; tickets: string[] }
  /**
   * Start the stage again, from the top. For a stage that failed rather than one
   * that asked something: there is nothing to answer and nothing worth resuming.
   */
  | { type: 'stage_restarted' }
  /**
   * Put the stage back into the stage it stopped in, keeping its conversation.
   *
   * The counterpart of `stage_restarted`, and the difference between them is the
   * only thing worth saying about either: that one throws the conversation away
   * and buys the stage a second time, this one picks it back up where it got to.
   * Both stay available, because carrying on is sometimes the wrong answer.
   */
  | { type: 'stage_continued' }
  /**
   * The manager says this will do: offer it as a pull request from wherever it
   * has got to. Not a bypass of review — the pull request is still a review, and
   * merging is still a deliberate act — but it means two agents disagreeing can
   * no longer be the end of a ticket. Somebody has to be able to say when the
   * work is good enough, and it is not the reviewer.
   */
  | { type: 'shipped' }
  | {
      type: 'stage_started';
      stage: Stage;
      runId: string;
      /**
       * This run is the workbench settling a clash on a branch that is already
       * offered, rather than a stage the board asked for. The
       * counterpart of the flag `stage_finished` carries, written here as well so
       * the ticket says what the run *is* while it is going: its status reads
       * `implementing` either way, and a run that takes minutes should not have to
       * finish before the board can say what it is doing.
       */
      settling?: true;
    }
  /**
   * The conversation this run is, written down the moment the model service names
   * it rather than when the run ends. That is the whole point of it: a run only
   * reports a session when it stops with something left to say, so a workbench
   * killed mid-stage never reported one at all — and everything the run had spent
   * was spent again from the top. This is what survives the kill.
   */
  | { type: 'session_started'; runId: string; sessionId: string }
  /**
   * The stage says it has started step `index` of the approved plan. Announced by
   * the agent as it works, so a long run says where it has got to rather than only
   * that it is running.
   */
  | { type: 'step_reached'; runId: string; index: number }
  | { type: 'agent_said'; runId: string; text: string }
  | {
      type: 'tool_requested';
      runId: string;
      tool: string;
      input: unknown;
      allowed: boolean;
      reason?: string;
    }
  /**
   * The standing checks, as the workbench ran them itself: at the end of a completed
   * implement run, and again after a clash on an offered branch has been settled.
   */
  | { type: 'checks_run'; runId: string; results: CheckRun[] }
  /**
   * The checks the code host ran on the pushed head, waited for before the merge:
   * `command` is the check's name, and a failed one carries its job's log. The wait
   * itself is worth recording — minutes pass between the Accept and the merge, and
   * without this the ticket says nothing about where they went.
   *
   * A failure sends the ticket back to implement carrying the log, and counts as a
   * revision: it is the same news as a standing check failing, arriving later.
   */
  | { type: 'pr_checks_run'; results: CheckRun[]; waitedMs: number }
  | { type: 'question_asked'; runId: string; question: string; reasoning: string }
  | { type: 'question_answered'; answer: string }
  | {
      type: 'stage_finished';
      runId: string;
      outcome: RunOutcome;
      summary: string;
      /**
       * Set by review and verify when the approach itself is wrong. The reason
       * goes to the next plan.
       */
      rejected?: string;
      /**
       * Set by review and verify when the approach is right and specific things
       * are not. The ticket goes back to implement carrying these, rather than
       * throwing the work away and planning it again.
       */
      changes?: string;
      /** What this run cost, as the model service reported it. */
      costUsd?: number;
      /** The commit this stage left behind, when it changed anything. */
      commit?: string;
      /** Set by the plan stage: how much it judged the work to warrant. */
      scale?: Scale;
      /** Set by the plan stage: the steps the work breaks into, in order. */
      steps?: string[];
      /**
       * Set by the plan stage: what would make this ticket finished. Agreed at
       * the gate, and the only thing review is entitled to judge against.
       */
      completionCriteria?: string[];
      /**
       * Improvements this stage noticed that are not this ticket's job. Kept so
       * the manager can make tickets of them, rather than lost or, worse, made
       * into reasons to reject work that was asked for.
       */
      later?: string[];
      /**
       * The conversation this run was, set only when it stopped with something left
       * to say — a question it asked, or a workbench that stopped underneath it.
       * Picking the ticket back up continues that instead of starting again.
       */
      sessionId?: string;
      /**
       * The instant the model service says work can resume, set only by a run that
       * stopped on a session limit. What makes that ending an interruption with a
       * time on it rather than a failure: the ticket parks with its conversation and
       * carries on by itself when this passes.
       */
      limitedUntil?: string;
      /**
       * The model that run was using, set alongside `limitedUntil`. The message names
       * no model, so this is who the limit is attributed to — and it is what decides
       * which other stages have to wait and which carry on regardless.
       */
      limitedModel?: string;
      /**
       * This run was the workbench settling a clash on a branch that was offered,
       * rather than a stage the board asked for. What routes the report: there is no
       * next stage to send it to, so it goes back to the wait it interrupted.
       *
       * A fact about the run, and it has to be — the ticket was read for it once and
       * a settling run takes minutes. In those minutes a verdict or an objection can
       * land and end the offer, so a ticket that was offered when this started can be
       * `done` or `implementing` by the time it reports.
       */
      settling?: true;
    }
  /** The ticket's branch exists, cut from this commit of the base. */
  | { type: 'branched'; branch: string; base: string }
  /**
   * The base had moved on, and the branch merged the new one in. Recorded because
   * it puts a commit on the branch that no stage made, and because it moves what
   * the ticket's change is measured against: from here the diff a reviewer reads
   * is the ticket's own work, not everything the base gained while it was busy.
   *
   * Only written when something actually merged. A branch that already had the
   * base is the ordinary case and says nothing. A merge handed to a stage is
   * written here too, but not until the stage's commit concludes it: before that
   * there is nothing on the branch for the base to be moved to.
   *
   * `took` is the work this ticket waited for that this refresh merged, the base
   * aside. Recorded because that work is in no commit of the base, so measuring from
   * one would show the dependency's whole change as this ticket's.
   *
   * `carrying` is the whole of that work as of this refresh — what the branch took
   * now, and what it took before and the base still has not got. Written because
   * `took` alone lasts one refresh: a dependency that is sent back for changes is
   * no longer offered, so the next refresh takes nothing from it and the base would
   * move onto a commit without its work in it, though the merge is still in the
   * branch. Optional, so events written before this replay as they always did.
   */
  | { type: 'refreshed'; base: string; commit: string; took?: string[]; carrying?: string[] }
  /**
   * The base had moved on and the branch could not take it cleanly, so the merge
   * was left in the worktree and given to the stage that was about to run. Not a
   * `refreshed`: nothing is committed yet, and until this stage resolves it the
   * ticket's branch is mid-merge.
   */
  | { type: 'conflicted'; runId: string; base: string; paths: string[] }
  | { type: 'plan_approved' }
  /**
   * The manager says the approach is wrong: back to planning, and the reason is
   * what the next plan is written against. The expensive "no" — it buys a whole
   * new plan — and the counterpart of `changes_requested`, which does not.
   *
   * Named for the gate it was written for, and kept that way because renaming an
   * event rewrites history that is already in the database. It has never been
   * limited to the gate: a ticket is sent back the same way wherever it has got to.
   */
  | { type: 'plan_rejected'; reason: string }
  /**
   * The manager says the approach is right and specific things are not: back to
   * implement, keeping the work. The same thing review and verify say with
   * `changes`, said by the one person nothing overrules — so, unlike theirs, it is
   * not capped and does not count a revision. `MAX_REVISIONS` exists because two
   * agents repeating an objection is evidence about the approach; a manager
   * repeating one is just the manager, and cutting them off after twice would turn
   * a third request into a re-plan nobody asked for.
   */
  | { type: 'changes_requested'; changes: string }
  | { type: 'pr_opened'; url: string }
  /** The workbench itself could not carry on — a worktree or a pull request failed. */
  | {
      type: 'blocked';
      reason: string;
      /**
       * The files the base and the branch disagree about, when that is what
       * stopped it. Kept as data rather than only as prose in the reason, so the
       * panel can list them and offer the way out.
       */
      conflicts?: string[];
      /**
       * What the merge that found them was with, and the base at the time. The
       * reason says which in prose, and prose is not something the panel can read:
       * without this it can only call every clash one with the base, and half of
       * them are with a branch this ticket waits for. Absent on logs written
       * before it was recorded.
       */
      conflictedWith?: { ref: string; base: string };
    }
  /** The manager stopped it. */
  | { type: 'cancelled'; reason: string }
  /**
   * The workbench stopped it on policy — too many cycles, or too much money.
   * Distinct from `blocked`: nothing is stuck and no answer would help.
   */
  | { type: 'gave_up'; reason: string }
  /**
   * The manager says merge it. Written rather than merged on the spot because the
   * API server does no work of its own: the orchestrator picks this up, brings the
   * base in, merges the branch onto it and records the verdict itself. So a
   * merge asked for survives a restart, and every one of them is in the log.
   *
   * Logs written while there was a choice of merge method carry a `method` here.
   * Nothing reads it: there is one way to land work, and replaying an older log
   * means the same thing it means now.
   */
  | { type: 'merge_requested' }
  /**
   * This ticket's merge did not start, because `behind`'s merge holds the gate.
   *
   * A fact about the tick that declined, not a promise about the order: nothing is
   * refused and `merge_requested` still stands, so the tick after the gate frees is
   * the one that merges it. Recorded rather than said out loud because the wait is
   * the ticket's news — five accepts in thirteen seconds left four tickets reading
   * `merging…` with the only explanation on `wb serve`'s stdout.
   */
  | { type: 'merge_queued'; behind: string }
  | { type: 'verdict'; verdict: 'accepted' | 'rejected'; reason?: string }
  /**
   * One turn of the conversation about this ticket, by the manager or by the chat
   * agent. Kept as events like everything else, so the pane is redrawn off the same
   * stream the board is and a reload reads the conversation back rather than losing it.
   *
   * `costUsd` is recorded and deliberately not added to `ticket.costUsd`: talking
   * about a ticket must not be able to push it past `maxTicketUsd` and stop the work.
   */
  | {
      type: 'chat_said';
      role: 'manager' | 'agent';
      text: string;
      proposals?: Proposal[];
      costUsd?: number;
      /** The agent's conversation, so the next turn resumes rather than re-reads. */
      sessionId?: string;
    }
  /**
   * The manager took a proposal up. Written beside the event the proposal actually
   * is, which is appended first — this one only records that the chat is where it
   * came from, so the pane can say which of its offers have been taken.
   */
  | { type: 'chat_accepted'; proposal: Proposal }
  /**
   * How long this ticket is likely to take, as a model guessed it from the tickets
   * already finished. Written when the ticket is queued and again after each stage,
   * because it is worked out at moments nobody is watching and read later.
   *
   * `range` is whatever the model said — "2–4 hours" — and stays text on purpose: a
   * guess off a handful of rows should not be given a shape it cannot support.
   */
  | { type: 'estimated'; range: string; why: string };

export type Event = EventBody & {
  id: number;
  ticketId: string;
  at: string;
};
