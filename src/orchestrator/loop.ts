import { randomUUID } from 'node:crypto';

import type { CheckRun, EventBody, Refreshed, RunOutcome, Scale, Stage } from '../domain/events.ts';
import {
  lastChecks,
  lastImplementSummary,
  lastReviewChanges,
  type Ticket,
} from '../domain/ticket.ts';
import { carriedWork, heldBy, nextAction, waitingOutLimit, type Action } from '../domain/rules.ts';
import type { Store } from '../store/store.ts';
import { isCredentialRejection, refused, type Credentials } from '../run/credentials.ts';
import { readStep } from '../run/protocol.ts';
import { createBranch } from './branch.ts';
import { createMerging } from './merging.ts';
import { describe } from './describe.ts';

/** An action that has something to carry out — everything except waiting. */
type Doable = Exclude<Action, { kind: 'wait' }>;

/**
 * What a stage run reports back. The orchestrator turns this into events.
 *
 * A runner reports `interrupted` for one ending only: the model service's session
 * limit, which comes with the time it lifts and so is waited out rather than failed.
 * Otherwise it is the orchestrator that writes it, over whatever the run said, for a
 * run it stopped underneath. See `readSessionLimit` and `interrupt`.
 */
export type RunResult = {
  outcome: RunOutcome;
  summary: string;
  /** Set by review and verify when the approach itself is wrong. */
  rejected?: string;
  /** Set by review and verify when the approach is right and details are not. */
  changes?: string;
  /** Set by the plan stage: how much it judged the work to warrant. */
  scale?: Scale;
  /** Set by the plan stage: what the work breaks into, in order. */
  steps?: string[];
  /** Set by the plan stage: what would make this ticket finished. */
  completionCriteria?: string[];
  /** Improvements worth a later ticket, which are not this one's job. */
  later?: string[];
  /** Set when the agent asked the manager something. */
  question?: { question: string; reasoning: string };
  /**
   * The conversation this run was, kept only when it stopped with something left
   * to say. Answering the question resumes it rather than starting again. A run
   * that is still going says the same thing with `session_started`, which is what
   * survives the workbench being killed under it.
   */
  sessionId?: string;
  /**
   * When the model service said this run may carry on, for a run that stopped on a
   * session limit. Set only by that one ending; see `readSessionLimit`.
   */
  limitedUntil?: string;
  /** Which model that run was using, so the wait holds only the stages that share it. */
  limitedModel?: string;
  /** What the run cost, as the model service reported it. */
  costUsd?: number;
};

export type StageRunner = (args: {
  ticket: Ticket;
  stage: Stage;
  /**
   * Which run this is, as `stage_started` recorded it. Everything the run emits
   * carries it, so a ticket's history says which stage each line came from without
   * anyone having to work it out from the order.
   */
  runId: string;
  worktree: string;
  /** Where working-out goes. Writable, and not part of what gets committed. */
  scratch: string;
  /**
   * The standing checks as the workbench last ran them, which for review and verify
   * is at the end of the implement run that produced this change. Given to both so
   * they do not spend turns running them, and know what was covered without an agent.
   * Empty means nothing was run, which is a fact worth having too.
   */
  checks?: CheckRun[];
  /**
   * What review itself last asked for on this plan, and the commit the branch stood
   * at when it asked. Given to review alone and only from its second round on: it is
   * what turns a later round into a check of the round before it, rather than another
   * review from nothing that finds new things at the first round's rate.
   */
  previously?: { changes: string; at: string | null };
  /**
   * What the last implement run said it had done, for implement alone and only when
   * there was one. A round sent back for changes is revising work it was not there
   * for, and its own account of that work is cheaper than rediscovering it by reading
   * the files it wrote.
   */
  didBefore?: string;
  /**
   * A merge the workbench started and could not finish, left in the worktree for
   * this stage to resolve before it does anything else. The stage may not end with
   * any of these paths still conflicted. `with` is the branch it is against when
   * that is not the base — the offered work this ticket waited for.
   */
  conflict?: { base: string; paths: string[]; with?: string };
  /**
   * The conversation to pick back up, when there is one: a question the manager
   * has now answered, or a run the workbench was stopped in the middle of. Still
   * best-effort — a runner that cannot resume must start the stage afresh rather
   * than fail, because the session lives on one machine and can simply be gone.
   */
  resume?: string;
  /** Called as the run proceeds, for the live record. */
  emit: (body: EventBody) => void;
  /** Aborted when the manager cancels the ticket. */
  signal: AbortSignal;
}) => Promise<RunResult>;

export type Verdict =
  { kind: 'pending' } | { kind: 'accepted' } | { kind: 'rejected'; reason: string };

/** Somewhere for a ticket to do its work, without treading on any other ticket. */
export type Workspace = {
  /**
   * Makes the ticket's workspace if it does not have one. `base` is the commit the
   * work was cut from, and is set only on the call that created it. `scratch` is
   * writable but is not part of what `commit` records.
   */
  prepare: (
    ticketId: string,
    /** The branch to start from, when this ticket carries on from another. */
    from?: string,
  ) => Promise<{ path: string; scratch: string; base: string | null }>;
  /**
   * Brings the base as the code host now has it into the ticket's branch, so the
   * work is offered against the code that exists rather than the code that did
   * when it started. `up-to-date` is the ordinary answer and means nothing
   * happened at all.
   */
  refresh: (
    ticketId: string,
    /**
     * Branches to bring in besides the base: the work this ticket waited for,
     * which is offered and so is not in the base yet.
     */
    alsoMerge?: readonly string[],
    /**
     * Leave a conflict in the worktree rather than undoing it, because the caller
     * is about to run a stage that can resolve it. At ship time there is nobody
     * left to, so the default is to put the branch back as it was.
     */
    keepConflict?: boolean,
  ) => Promise<Refreshed>;
  /**
   * Of the paths a stage was handed a merge for, which ones it has not finished:
   * still unmerged, or still holding the markers. Asked at the end of that stage,
   * because committing an unresolved merge would put the markers on the branch.
   */
  unresolved: (ticketId: string, paths: readonly string[]) => Promise<string[]>;
  /**
   * Undoes a merge left in the worktree, putting the branch back where it stood.
   * The way out when the run that was handed one did not finish it: nothing is
   * committed, and the branch is offered as it was.
   */
  abandonMerge: (ticketId: string) => Promise<void>;
  /**
   * The paths the base has that the branch's tip has not, of those the base added
   * since `from` — what this ticket's change is measured against. Asked when work
   * is about to be offered or merged, because a branch that deletes what the base
   * just added is reverting somebody else's work rather than doing its own.
   */
  removedFromBase: (ticketId: string, from?: string) => Promise<string[]>;
  /**
   * Records whatever a stage left behind, returning the commit or null when there
   * was nothing to record — normal for the stages that only read. The sha is kept:
   * a ticket's record is its branch, its base, its commits and its pull request.
   */
  commit: (ticket: Ticket, message: string) => Promise<string | null>;
  /** Called once a ticket is accepted. The branch is left alone: it is in the PR. */
  discard: (ticketId: string) => Promise<void>;
};

/**
 * What asking the host to merge came to. Merging waits for the checks the host runs
 * on the pushed head, so the two ways it can end without merging are answers rather
 * than failures: a check that failed is work to do, and one still running when the
 * wait ran out is a question for the manager.
 */
export type MergeOutcome =
  /** `results` is what the host's checks said, when there were any to wait for. */
  | { kind: 'merged'; results?: CheckRun[] }
  /** Every check on the pull request; the failed ones carry their job's log. */
  | { kind: 'checks_failed'; results: CheckRun[] }
  /** The names of the checks that had still not concluded. */
  | { kind: 'checks_pending'; pending: string[] };

/** Where finished work is offered, and where the manager's answer comes back from. */
export type CodeHost = {
  openPr: (ticket: Ticket) => Promise<string>;
  verdict: (ticket: Ticket) => Promise<Verdict>;
  /** Merges the offer, because the manager said so here rather than on the host. */
  merge: (ticket: Ticket) => Promise<MergeOutcome>;
};

export type Deps = {
  store: Store;
  workspace: Workspace;
  host: CodeHost;
  runStage: StageRunner;
  /**
   * Runs the standing checks in a ticket's worktree. The workbench's own job, not an
   * agent's: an agent reporting that the tests passed is a claim, and the verify
   * agent's instructions concede as much. Run here, it is a fact.
   *
   * Never throws — a command that fails, times out or does not exist comes back as
   * a failed check, because to the rules those are all the same thing.
   */
  checks: (worktree: string) => Promise<CheckRun[]>;
  /**
   * Whether the workbench can talk to the model service at all. Asked before any
   * stage starts, because being logged out is a kind of having no capacity.
   */
  credentials: () => Promise<Credentials>;
  /**
   * Which model a stage runs on. Asked per tick rather than held, for the reason
   * `runStage` asks for its agents per run: the board edits those files, and a model
   * read once at startup would hold a stage against a limit it no longer shares.
   */
  modelFor: (stage: Stage) => string;
  /** Says something to whoever is watching. The CLI prints it; tests collect it. */
  announce: (message: string) => void;
  /**
   * The clock a session limit is measured against, in milliseconds. The real one
   * unless a test wants to stand on the far side of a reset without waiting for it.
   */
  now?: () => number;
};

export type Orchestrator = {
  /** Do whatever the rules currently permit. Safe to call at any time. */
  tick: () => Promise<unknown>;
  /** Resolves once nothing is in flight and no further action is permitted. */
  idle: () => Promise<void>;
  /**
   * Stop the stages still running, and say which they were. The second press of
   * the board's STOP: the first left them to finish.
   */
  interrupt: () => string[];
  start: () => void;
  stop: () => Promise<void>;
};

/**
 * A ticket is running because a `stage_started` was never answered by a
 * `stage_finished`. If the workbench died in between, nothing will ever answer it:
 * the ticket stays running for ever, and holds a work-in-progress slot for ever.
 * Closing those runs off at startup parks them as blocked — visible and answerable
 * — instead of wedged.
 *
 * Closed as `interrupted` rather than `failed`, carrying whatever conversation the
 * run had got as far as naming. That is the difference between a stage that can
 * carry on and one that has to be bought again, and restarting is routine now: it
 * is how an update is picked up.
 *
 * @returns the tickets that were picked up mid-stage.
 */
export function reconcile(store: Store): string[] {
  const interrupted = store.tickets().filter((t) => t.running);

  for (const ticket of interrupted) {
    store.append(ticket.id, {
      type: 'stage_finished',
      runId: 'interrupted',
      outcome: 'interrupted',
      summary: 'the workbench stopped while this stage was running',
      sessionId: ticket.session ?? undefined,
    });
  }

  return interrupted.map((t) => t.id);
}

export function createOrchestrator(deps: Deps, opts: { pollMs?: number } = {}): Orchestrator {
  const { store } = deps;
  const pollMs = opts.pollMs ?? 30_000;

  /** Tickets whose work is in flight in this process, so a tick never starts one twice. */
  const inFlight = new Map<string, Promise<void>>();
  /** How a cancellation reaches a run that has already started. */
  const aborts = new Map<string, AbortController>();
  /**
   * Tickets whose run was stopped by `interrupt` rather than by the manager
   * cancelling the ticket. Both arrive at the run as the same aborted signal, and
   * this is what tells them apart when it comes back.
   */
  const broken = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  let listening = false;
  /** So the credential state is announced when it changes, not on every tick. */
  let wasOk = true;
  /** The same, for a session limit: the models last said to be waiting one out. */
  let wasLimited = new Set<string>();
  /**
   * Set when the model service refuses the credential we have. Sticky on purpose:
   * checking that a credential is *present* cannot tell you it is *accepted*, and
   * the only authority on that is a real call. Once one comes back rejected, no
   * amount of re-checking locally will change the answer — the credential itself
   * has to change, and for an environment variable that means a restart.
   */
  let rejection: string | undefined;

  /** A ticket's branch, and the offer made of what is on it. */
  const branch = createBranch(deps);
  const merging = createMerging({
    deps,
    branch,
    busy: (id) => inFlight.has(id),
    settleOffered,
    holding: (id, work) => void holding(id, work),
  });

  // Subscribed from the moment the orchestrator exists, not from start(), because a
  // cancellation has to reach a running stage whether or not the timer is going.
  const unsubscribe = store.subscribe((event) => {
    if (event.type === 'cancelled') aborts.get(event.ticketId)?.abort();
    if (listening) void tick();
  });

  /**
   * Whether agents may run at all. Being logged out is not a broken workbench and
   * not a broken ticket: it is having no capacity. Nothing starts, so nothing is
   * spent, no cycle is used and no worktree is made — and the manager can still
   * write, approve and cancel.
   *
   * Said once when the answer changes, rather than on every tick.
   */
  async function canRunAgents(): Promise<boolean> {
    const credentials = rejection === undefined ? await deps.credentials() : refused(rejection);
    if (credentials.ok === wasOk) return credentials.ok;
    wasOk = credentials.ok;

    deps.announce(
      credentials.ok
        ? `authenticated with ${credentials.how} — carrying on`
        : `⚠️  agent work is paused: ${credentials.why}.\n\n${credentials.fix}\n\n` +
            'The rest of the workbench still works — write tickets, approve, cancel.' +
            // Only true when the credential could still turn up. A refused one has
            // to be replaced, and this process cannot see that happen.
            (rejection === undefined ? '\nThey will start on their own once this is sorted.' : ''),
    );
    return credentials.ok;
  }

  /**
   * Which models are out of service on a session limit, and until when. Empty when
   * none is. Whatever has come out the far side of one is carried on here, which is
   * all the resuming there is: `stage_continued` is the very event the board's own
   * button appends, and the stage picks up its conversation. Each parked ticket is
   * carried on at its own recorded time — several can be waiting at once, on
   * different models and different resets, and none of them is a reason to hold
   * the others.
   *
   * Worked out from the tickets rather than remembered, because the reset time is on
   * the ticket that hit it — so a workbench restarted inside a limit waits out the
   * rest of it instead of buying a stage to be told the same thing again.
   *
   * Said once when a model takes a limit and once when it lifts, like `canRunAgents`.
   */
  function sessionLimits(tickets: readonly Ticket[]): Map<string, number> {
    const now = deps.now?.() ?? Date.now();
    /** Model to the latest instant anything parked on it is waiting for. */
    const until = new Map<string, number>();

    for (const ticket of tickets) {
      if (ticket.limitedUntil === null) continue;
      if (!waitingOutLimit(ticket, now)) {
        if (ticket.status === 'blocked' && ticket.interrupted) {
          store.append(ticket.id, { type: 'stage_continued' });
        }
        // Anything else with a passed time has already been moved on by hand —
        // answered, restarted, cancelled — and the reducer would refuse
        // `stage_continued` for it. Refused, the append still wakes this loop through
        // the store and still leaves `limitedUntil` set, so it would be tried again on
        // every tick for ever. A limit nobody is waiting out is simply over.
        continue;
      }
      // A limit recorded before the model was. It still carries its own ticket on at
      // its own time; what it cannot do is say whose capacity ran out, and holding
      // everything on a guess is the thing this stopped doing.
      if (ticket.limitedModel === null) continue;
      const at = Date.parse(ticket.limitedUntil);
      until.set(ticket.limitedModel, Math.max(until.get(ticket.limitedModel) ?? 0, at));
    }

    for (const [model, at] of until) {
      if (wasLimited.has(model)) continue;
      deps.announce(
        `⚠️  work on ${model} is paused: the model service's session limit is in force. ` +
          `The stage that hit it carries on at ${new Date(at).toLocaleTimeString()}, ` +
          'and nothing else on that model starts until then.\n\n' +
          'Stages on another model carry on, and so does the rest of the workbench — ' +
          'write tickets, approve, cancel.',
      );
    }
    for (const model of wasLimited) {
      if (!until.has(model))
        deps.announce(`the session limit on ${model} has lifted — carrying on`);
    }
    wasLimited = new Set(until.keys());

    return until;
  }

  /**
   * @param poll whether to ask the code host for verdicts. Only the timer does:
   *   a pull request has no event to wait for, and polling on every appended
   *   event would mean asking GitHub continuously and never settling.
   */
  async function tick({ poll = false }: { poll?: boolean } = {}): Promise<boolean> {
    if (stopped) return false;
    // The manager stopped the whole workbench. Nothing starts at all — not a stage,
    // not a pull request, not a verdict poll — until `wb start`. Asked before the
    // tickets are read, because being stopped is not a fact about any of them.
    if (store.stopped()) return false;

    /**
     * Whether this pass found anything happening: work it started, or a ticket it
     * had to skip because a run was already going. Polling a pull request counts as
     * neither — it stays available for as long as a human has not answered, so
     * counting it would mean never settling.
     */
    let active = false;

    const tickets = store.tickets();
    const policy = store.policy();
    const mayRunAgents = await canRunAgents();
    // A limit holds the stages that would meet it — those on the same model — and
    // nothing else. The stages do not share a model, so a plan waiting out a limit is
    // no reason for an implement on another model to sit still.
    const limited = sessionLimits(tickets);

    // A ticket occupies one slot whether the store already shows it running or it
    // is only just starting. Counting both would charge it twice and jam the limit.
    const busy = new Set(tickets.filter((t) => t.running).map((t) => t.id));
    for (const id of inFlight.keys()) busy.add(id);

    for (const ticket of tickets) {
      // Busy is not idle. A run started by the tick that follows a finished one is
      // not in the set `idle` is waiting on, so a pass that skips it here and
      // settles would return with work still going.
      if (inFlight.has(ticket.id)) {
        active = true;
        continue;
      }

      const action = nextAction(ticket, busy.size, policy, heldBy(ticket, tickets).length > 0);
      if (action.kind === 'wait') continue;
      if (action.kind === 'poll_verdict' && !poll) continue;
      // Only running a stage needs the model service. Opening a pull request, reading
      // a verdict and giving up are the workbench's own work and carry on regardless
      // — of being logged out, and of a session limit, which is the same kind of thing:
      // no capacity rather than anything wrong. A limit is per model, so it is this
      // stage's agent that decides whether this stage waits.
      if (action.kind === 'run_stage' && !mayRunAgents) continue;
      if (action.kind === 'run_stage' && limited.has(deps.modelFor(action.stage))) continue;
      // Queued, not refused: the wait is recorded and `mergeRequested` still stands,
      // so the tick after the gate frees is the one that merges it — in this process
      // or in the one that replaces it, since the request is a durable event and the
      // queue is only ever this tick declining to act on it.
      if (action.kind === 'merge_pr' && merging.merging()) {
        merging.tellQueued(ticket);
        active = true;
        continue;
      }
      if (action.kind === 'run_stage') busy.add(ticket.id);

      if (action.kind !== 'poll_verdict') active = true;

      const work = perform(ticket, action).finally(() => {
        // Free the slot first, then look for work: a tick that ran before this
        // would still see the finished ticket as busy and leave the slot idle.
        inFlight.delete(ticket.id);
        void tick();
      });
      inFlight.set(ticket.id, work);
    }

    return active;
  }

  async function perform(ticket: Ticket, action: Doable): Promise<void> {
    try {
      switch (action.kind) {
        case 'run_stage':
          await doStage(ticket, action.stage);
          break;
        case 'open_pr':
          await merging.openPr(ticket);
          break;
        case 'poll_verdict':
          await merging.pollVerdict(ticket);
          break;
        case 'merge_pr':
          await merging.mergePr(ticket);
          break;
        case 'give_up':
          store.append(ticket.id, { type: 'gave_up', reason: action.reason });
          break;
        case 'hand_over':
          store.append(ticket.id, { type: 'blocked', reason: action.reason });
          break;
      }
    } catch (error) {
      store.append(ticket.id, { type: 'blocked', reason: describe(error) });
    }
  }

  /**
   * The standing checks, run against what a run left in the worktree and recorded
   * against that run.
   *
   * Running them here rather than asking an agent to changes what a pass *is*: an
   * observed fact in the ticket's record instead of a report from something with an
   * opinion. What the caller does with a failure differs — that is the caller's
   * business — but the output itself is the reason every time, because a summary of a
   * test failure is worse than the failure.
   *
   * @returns what failed, or undefined when nothing did, including when the project
   *   has no checks configured at all.
   */
  async function checksAfterRun(
    ticketId: string,
    runId: string,
    worktree: string,
  ): Promise<string | undefined> {
    const results = await deps.checks(worktree);
    if (results.length === 0) return undefined;

    store.append(ticketId, { type: 'checks_run', runId, results });

    const failed = results.filter((r) => !r.ok);
    if (failed.length === 0) return undefined;
    return failed.map((f) => `\`${f.command}\` failed:\n${f.output}`).join('\n\n');
  }

  /**
   * Runs `work` with the ticket claimed in flight for the whole of it, as a tick's
   * own work is. A tick that arrived in the middle would see a ticket with no run
   * recorded yet — the `stage_started` is inside `doStage` — and start one of its
   * own on the same worktree, and `idle` would return with an agent still going.
   *
   * Whatever held the ticket before goes back afterwards rather than the claim being
   * dropped. At offer time this runs inside the `perform` that is opening the pull
   * request, which claimed the ticket for the whole of it: deleting here would free
   * it while the push is still going, and the next tick would find a ticket reading
   * `implementing` with nothing running and start a real stage in the worktree being
   * pushed from. Where nothing held it — a settle handed off by the pass over the
   * offered branches, which belongs to no `perform` — the claim is dropped and a
   * tick is asked for, because otherwise nothing looks for work when it ends.
   */
  async function holding<T>(ticketId: string, work: () => Promise<T>): Promise<T> {
    const held = inFlight.get(ticketId);
    // Claimed before the work starts, and with a promise of its own rather than the
    // work's, because one of these nests inside another: the settle a detached one
    // runs is itself held. A claim made after the work had begun would not be there
    // for the inner call to read, so what the inner call gave back at the end was a
    // promise that had already resolved — and the ticket stayed in flight for ever.
    let done = () => {};
    inFlight.set(
      ticketId,
      new Promise<void>((resolve) => {
        done = resolve;
      }),
    );
    try {
      return await work();
    } finally {
      done();
      if (held === undefined) inFlight.delete(ticketId);
      else inFlight.set(ticketId, held);
      void tick();
    }
  }

  /**
   * The implement run that settles a clash found on a branch being offered — the
   * offer itself, or the pass over the offered branches after a merge. Everything a
   * stage run is, and one thing besides: the standing checks are run against what it
   * leaves, before anything is committed.
   */
  async function settleOffered(ticket: Ticket, clashedWith?: string): Promise<RunResult> {
    return holding(ticket.id, () => doStage(ticket, 'implement', { settling: true, clashedWith }));
  }

  /**
   * @param settling whether this run is settling a clash on an offered branch,
   *   rather than a stage the board asked for. See `settleOffered`.
   * @param clashedWith the branch the merge waiting in the worktree is against, when
   *   the caller knows it is not the base. Only a settle does.
   * @returns what the run reported, for the caller that has something to do with it.
   */
  async function doStage(
    ticket: Ticket,
    stage: Stage,
    { settling = false, clashedWith }: { settling?: boolean; clashedWith?: string } = {},
  ): Promise<RunResult> {
    const { path: worktree, scratch } = await branch.prepare(ticket);
    const runId = randomUUID();

    // Interruptible from the moment it is running, not from the moment the agent
    // starts. The refresh that comes between the two is this run happening, and a STOP
    // pressed during it used to find nothing to abort, report that nothing was
    // abandoned, and then let the stage go on and buy the whole agent run it was
    // pressed to prevent.
    const abort = new AbortController();
    aborts.set(ticket.id, abort);

    try {
      // Said as the run starts rather than only when it reports: the ticket reads
      // `implementing` for the whole of a settle either way, and the board has no
      // other way to tell one from a stage it asked for.
      store.append(ticket.id, {
        type: 'stage_started',
        stage,
        runId,
        settling: settling || undefined,
      });

      const refreshed = await branch.refreshForStage(ticket, stage, runId);
      // What the merge on disk is against, which the refresh cannot say: all it finds
      // is a `MERGE_HEAD`, and for a settle that is a branch this ticket waited for
      // rather than a base commit. Carried down from the caller that does know, because
      // both the brief and what is recorded afterwards turn on it.
      const conflict: { base: string; paths: string[]; with?: string } | undefined =
        refreshed.conflict !== undefined && clashedWith !== undefined
          ? { ...refreshed.conflict, with: clashedWith }
          : refreshed.conflict;
      // A merge that landed moved the base on the stored ticket, and everything
      // downstream — the brief's diff above all — is taken from the object rather than
      // the store. Without this the stage sees the base it was cut from, and the whole
      // of the merged-in work reads as its own. The base alone, not the whole ticket:
      // the one held here is deliberately the one from before `stage_started`, which
      // clears the answer and the session this run is about to carry in.
      ticket = { ...ticket, base: store.ticket(ticket.id).base };

      // Stopped before the agent was ever asked. Recorded as `interrupted` — the same
      // as a run stopped mid-flight — rather than started and immediately abandoned,
      // which is the difference between a STOP that costs nothing and one that costs a
      // stage. The session is the one this run was about to resume, because it never
      // got as far as naming one of its own.
      if (broken.delete(ticket.id)) {
        aborts.delete(ticket.id);
        store.append(ticket.id, {
          type: 'stage_finished',
          runId,
          outcome: 'interrupted',
          summary: 'stopped by the manager',
          sessionId: ticket.session ?? undefined,
          settling: settling || undefined,
        });
        return { outcome: 'interrupted', summary: 'stopped by the manager' };
      }

      // What the checks said, read back from the record rather than run again: the
      // implement run that made this change observed it, and the two stages that judge
      // the change are told rather than asked to find out. Only those two — plan and
      // implement have nothing yet to have been checked.
      //
      // Nothing at all, though, where this run's own refresh merged a base in: those
      // results are about a tree that has moved since, and the brief offers them as
      // output observed of what the stage is looking at. Verify would quote a suite that
      // passed against the old tree as its evidence the change is safe, and the block
      // after the commit would then find that same suite failing. A conflicted merge
      // says as much in the brief's own words; a clean one is silent, so what it
      // invalidated is withheld and the stage is told nothing was run.
      const checks =
        stage !== 'review' && stage !== 'verify'
          ? undefined
          : refreshed.merged
            ? []
            : lastChecks(store.eventsFor(ticket.id));

      // What review last said, for review alone. Implement is already given the list
      // as work to do; verify never wrote it. Absent on the first round of a plan,
      // which is the round that has nothing before it to check.
      const previously =
        stage === 'review'
          ? (lastReviewChanges(store.eventsFor(ticket.id)) ?? undefined)
          : undefined;

      // What the last implement run said it did, for implement alone. It is the stage
      // that has to revise that work; review and verify are reading the change itself
      // and have the diff for that. Absent on a first round, which had none before it.
      const didBefore =
        stage === 'implement'
          ? (lastImplementSummary(store.eventsFor(ticket.id)) ?? undefined)
          : undefined;

      let commit: string | null = null;
      let result: RunResult;
      try {
        result = await deps.runStage({
          ticket,
          stage,
          runId,
          worktree,
          scratch,
          checks,
          previously,
          didBefore,
          conflict,
          // Whatever conversation the ticket is holding. It is holding one only if it
          // stopped with something to come back to — a question it asked, or a
          // workbench that stopped underneath it — and only if what moved it here was
          // one of the two moves that goes back to that run: `movedOn` in ticket.ts
          // drops the session on every other one. So the rule can be that single
          // fact, rather than a list of the reasons it might be true.
          //
          // Never while a merge is waiting, though: a resumed run is not given a
          // brief, and the merge is in the brief.
          resume: conflict === undefined ? (ticket.session ?? undefined) : undefined,
          // A stage announcing which step it has reached is recorded as a fact of its
          // own, so the board shows progress without anyone reading prose. Done here
          // rather than in a runner: it is what a stage *said* that counts, so every
          // runner gets it, and the fake one exercises the same path.
          emit: (body) => {
            store.append(ticket.id, body);
            if (body.type !== 'agent_said') return;
            const index = readStep(body.text);
            if (index !== undefined)
              store.append(ticket.id, { type: 'step_reached', runId, index });
          },
          signal: abort.signal,
        });
      } catch (error) {
        // A crash is not a rejection: the ticket parks rather than looping back to plan.
        // Nothing is charged for it, because a runner that gets here died rather than
        // answered and there is no figure to charge: the real one reports its failures,
        // with what they spent, rather than throwing them.
        result = { outcome: 'failed', summary: describe(error) };
      } finally {
        aborts.delete(ticket.id);
      }

      // The run did not end, it was ended: `interrupt` aborted it, and whatever the
      // runner said on the way out is a description of being stopped rather than of
      // anything that went wrong. Recorded as `interrupted` — not `failed` — because
      // that is what keeps the conversation and offers to carry the stage on instead
      // of buying it again, the same distinction `reconcile` draws for a workbench
      // that died mid-stage. Nothing is committed: the tree is half-written.
      if (broken.delete(ticket.id)) {
        result = {
          outcome: 'interrupted',
          summary: 'stopped by the manager',
          costUsd: result.costUsd,
          // Whatever conversation the run got as far as naming. Read back from the
          // store, because `session_started` is emitted by the run rather than
          // returned by it, and a run stopped mid-flight returns very little.
          sessionId: result.sessionId ?? store.ticket(ticket.id).session ?? undefined,
        };
      }

      // The far end of the merge handed over at the start. A run that finished with
      // any of it still conflicted parks the ticket, and nothing is committed:
      // `commit` stages everything it finds, so an unresolved merge would put
      // conflict markers on the branch as though they were the stage's work.
      if (conflict !== undefined && result.outcome === 'completed') {
        const left = await deps.workspace.unresolved(ticket.id, conflict.paths);
        if (left.length > 0) {
          result = {
            outcome: 'blocked',
            // The run's own summary is kept: what it did is still what it did, and
            // whoever answers this needs it as much as they need the unfinished merge.
            summary: `${left.join(', ')} are still conflicted: ${result.summary}`,
            costUsd: result.costUsd,
          };
        }
      }

      // A settling run is the last thing that happens to work that is already
      // offered: what it leaves is pushed to the pull request the manager is
      // reading, and no stage follows it to find out that the suite is broken. So
      // the checks are run here — before the commit, so a failure leaves the merge
      // uncommitted and the branch can be put back exactly as it stood.
      if (settling && result.outcome === 'completed') {
        const why = await checksAfterRun(ticket.id, runId, worktree);
        if (why !== undefined) {
          result = {
            outcome: 'blocked',
            summary: `the standing checks fail against the resolution:\n\n${why}`,
            costUsd: result.costUsd,
          };
        }
      }

      // Commit before announcing the stage finished: the next stage's diff is
      // taken against the base branch, so uncommitted work is invisible to it.
      if (result.outcome === 'completed') {
        try {
          commit = await deps.workspace.commit(ticket, `${stage}: ${ticket.title} (${ticket.id})`);
          // The merge handed over at the start is on the branch now, so this is where
          // the base it brought in is recorded — `conflicted` deliberately moves
          // nothing, because until this commit there was nothing to move. Without it
          // the ticket keeps the base it was cut from, and every later diff is taken
          // from there: the whole of the merged-in work read as this ticket's own.
          if (conflict !== undefined && commit !== null) {
            // A dependency's merge is recorded the way `takeAwaitedWork` records one:
            // its branch is named as work taken in, and the base is not moved to what
            // the merge was against — that is another ticket's branch tip, and a base
            // moved onto it hands every later diff their change as this one's.
            const took = conflict.with === undefined ? [] : [conflict.with];
            // The ticket as the store has it, not the one in hand: an offer-time settle
            // is handed the object `merging.refresh` was holding, from before the
            // `refreshed` it appended for whatever merged cleanly ahead of the clash.
            // `carrying` read off that object forgets those branches, and the next
            // refresh then moves the base onto a commit that has not got them.
            const current = store.ticket(ticket.id);
            store.append(ticket.id, {
              type: 'refreshed',
              // Where the branch already stood, not this run's own commit: that commit
              // has the whole of this ticket's work in it, so a base there measures the
              // change as empty. The reducer holds the base while `carrying` names
              // anything, but only once the branch has a commit — and a dependency that
              // lands mid-run empties `carrying` — so what is written here has to be
              // right on its own rather than right because it is discarded.
              base: took.length > 0 ? (current.base ?? commit) : conflict.base,
              commit,
              took,
              carrying: carriedWork(current, store.tickets(), took),
            });
          }
        } catch (error) {
          // The run still cost what it cost, whatever happened afterwards.
          result = {
            outcome: 'failed',
            summary: `could not commit: ${describe(error)}`,
            costUsd: result.costUsd,
          };
        }
      }

      // What implement left, checked before anybody is asked to read it. A failure is
      // an objection this round has earned rather than a fault in the plan, so it goes
      // back the way review's objections go back: `changes` on this run's own report,
      // which `afterStage` routes to another implement round and counts as a revision.
      // The alternative is what this used to do — discover the same failure at the
      // start of verify, after a review has been bought, and buy a whole new plan for
      // it. A run that settled a merge is checked here too: two sides that only break
      // the suite once they sit together is exactly what a suite is for.
      //
      // After the commit, so the round that answers it starts from the work that
      // failed and can see it in its own diff.
      if (!settling && stage === 'implement' && result.outcome === 'completed') {
        const why = await checksAfterRun(ticket.id, runId, worktree);
        if (why !== undefined) result = { ...result, changes: why };
      }

      // A base that came in at the start of verify, asked about now that the stage is
      // over and it is committed — whether it arrived as a conflict this run resolved
      // or as a merge that went in silently. Either way the results in the brief are
      // from the implement run, taken before this code was on the branch. Nothing else
      // will ask: the next action is `open_pr`, whose refresh finds a branch already
      // up to date — up to date because of this very merge — and runs the checks only
      // when something merges there. So the change most likely to break the suite
      // would be the one offered without it ever being run.
      if (
        stage === 'verify' &&
        (conflict !== undefined || refreshed.merged) &&
        result.outcome === 'completed'
      ) {
        const why = await checksAfterRun(ticket.id, runId, worktree);
        // Back to planning: the work has been through implement, review and verify
        // already, and a suite the merge broke is not a detail for one more round of
        // implement to touch up. What the run itself objected to is kept alongside —
        // both are reasons it is going back, and the next plan has to answer both.
        if (why !== undefined) {
          result = { ...result, rejected: result.rejected ? `${result.rejected}\n\n${why}` : why };
        }
      }

      // One rejected credential means every other ticket would be refused too. Stop,
      // rather than working through the queue burning a stage on each of them. The
      // failure can arrive thrown or returned, so it is recognised here, where both
      // have already become the same thing.
      // Recording it is enough: the next tick sees it and announces the pause once,
      // with the same wording as every other reason the board is not working.
      if (result.outcome === 'failed' && isCredentialRejection(result.summary) && !rejection) {
        rejection = result.summary;
      }

      if (result.question) {
        store.append(ticket.id, {
          type: 'question_asked',
          runId,
          question: result.question.question,
          reasoning: result.question.reasoning,
        });
      }

      store.append(ticket.id, {
        type: 'stage_finished',
        runId,
        outcome: result.outcome,
        summary: result.summary,
        rejected: result.rejected,
        changes: result.changes,
        costUsd: result.costUsd,
        commit: commit ?? undefined,
        scale: result.scale,
        steps: result.steps,
        completionCriteria: result.completionCriteria,
        later: result.later,
        sessionId: result.sessionId,
        limitedUntil: result.limitedUntil,
        limitedModel: result.limitedModel,
        // Which the report is routed on, rather than on the ticket still being
        // offered: it may well not be by now. See `settling` in events.ts.
        settling: settling || undefined,
      });

      return result;
    } finally {
      // Whatever ends this run — returning, or a refresh, a check or an append
      // throwing on the way — ends its claim on being stoppable. A name left behind
      // in either of these belongs to a run that is over: `interrupt` would report
      // abandoning it, and the next stage under the same id would find itself
      // already broken and be recorded `interrupted` before it began.
      if (aborts.get(ticket.id) === abort) aborts.delete(ticket.id);
      broken.delete(ticket.id);
    }
  }

  /** Guards against a rule that keeps finding work forever. */
  const SETTLE_LIMIT = 500;

  return {
    tick,

    interrupt() {
      // Named before they are aborted, so `doStage` finds the name however fast the
      // abort comes back. The same wire a cancellation travels; what differs is what
      // the stopped run is recorded as.
      const ids = [...aborts.keys()];
      for (const id of ids) {
        broken.add(id);
        aborts.get(id)?.abort();
      }
      return ids;
    },

    async idle() {
      for (let i = 0; i < SETTLE_LIMIT; i++) {
        const before = store.eventCount();
        const active = await tick({ poll: true });
        await Promise.allSettled([...inFlight.values()]);

        // Settled when a pass found nothing happening, recorded nothing, and left
        // nothing running. Asking `tick` what it saw is the only reliable test:
        // whether an action may start depends on capacity and on credentials, and
        // re-deriving that here means keeping two copies of the same rule in step.
        if (!active && inFlight.size === 0 && store.eventCount() === before) return;
      }
      throw new Error(`orchestrator still busy after ${SETTLE_LIMIT} passes`);
    },

    start() {
      stopped = false;
      // Every flow is driven by an appended event. The timer exists only for the
      // one thing that has no event to wait for: a pull request awaiting a human.
      listening = true;
      timer = setInterval(() => void tick({ poll: true }), pollMs);
      timer.unref?.();
      void tick();
    },

    async stop() {
      stopped = true;
      listening = false;
      unsubscribe();
      if (timer) clearInterval(timer);
      await Promise.allSettled([...inFlight.values()]);
    },
  };
}
