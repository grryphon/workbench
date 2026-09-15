import type { Stage } from './events.ts';
import { ended, type Ticket } from './ticket.ts';

export type Policy = {
  /** How many tickets may have a stage running at once. */
  wipLimit: number;
  /** How many times one ticket may be planned before the workbench stops paying. */
  maxCycles: number;
  /** What one ticket may cost, across every stage and every cycle. */
  maxTicketUsd: number;
};

export const DEFAULT_POLICY: Policy = { wipLimit: 2, maxCycles: 3, maxTicketUsd: 50 };

/**
 * Every limit there is, so the store persists them and the settings page offers
 * them by walking one list rather than by naming each one three times over.
 */
export const POLICY_KEYS = Object.keys(DEFAULT_POLICY) as (keyof Policy)[];

export type Action =
  | { kind: 'run_stage'; stage: Stage }
  | { kind: 'open_pr' }
  | { kind: 'poll_verdict' }
  /**
   * Ask what became of the pull request a push to somebody else's branch went to. The
   * ticket is done; this is only noticing, afterwards, whether the work was squashed.
   */
  | { kind: 'watch_push' }
  /** The manager asked for the merge here rather than on the code host. */
  | { kind: 'merge_pr' }
  /** Stop the ticket: it has gone round too many times, or cost too much. */
  | { kind: 'give_up'; reason: string }
  /** Stop and ask the manager to decide. The work stands; the agents cannot agree. */
  | { kind: 'hand_over'; reason: string }
  /** Nothing to do: the manager's move, a run in flight, or no capacity. */
  | { kind: 'wait' };

const STAGE_FOR_STATUS = {
  planning: 'plan',
  implementing: 'implement',
  reviewing: 'review',
  verifying: 'verify',
} as const;

/**
 * Whether this ticket has let go of whatever is waiting on it.
 *
 * **A pull request is the release, not the merge.** What one ticket needs of
 * another is that it stop committing — after that its branch is final, and the
 * ticket that waited takes that branch into its own (`awaitedWork`) rather than
 * waiting for a merge that has not happened. Waiting for the merge would make
 * every dependency wait on a person, and a forgotten pull request would stop the
 * board.
 *
 * A ticket that ended — cancelled, given up on — releases too. Nothing else ever
 * will, and a queue held up by a ticket nobody is working on is the one failure
 * this must not have.
 *
 * `offered`, not `prUrl`. They meant the same thing until a ticket kept its pull
 * request through being sent back, and then they stopped: one being reworked has a
 * `prUrl` and is committing again, so reading that let everything waiting on it
 * start while it was still moving.
 */
export function released(t: Ticket): boolean {
  return t.offered || ended(t);
}

/**
 * Whether this ticket is parked on the model service's session limit, and the limit
 * has not lifted yet.
 *
 * One rule, read by the orchestrator and by the board: the one decides what may
 * start, the other says so on the card, and a ticket that says it is carrying on at
 * half past ten while the board has already started it would be worse than either.
 *
 * @param now the clock, in milliseconds. Handed in, because nothing in here has one.
 */
export function waitingOutLimit(t: Ticket, now: number): boolean {
  return t.limitedUntil !== null && Date.parse(t.limitedUntil) > now;
}

/**
 * The tickets this one is still waiting on. Empty when it waits on nothing, or
 * when everything it waits on has let go — it takes all of them, so the last one
 * to release is the one that starts the work.
 *
 * A named ticket that is not on the board is not waited for. Otherwise a typo, or
 * a board this was asked of before it had loaded, would hold a ticket for ever
 * against something that does not exist.
 */
export function heldBy(t: Ticket, tickets: readonly Ticket[]): Ticket[] {
  return t.waitsFor
    .map((id) => tickets.find((o) => o.id === id))
    .filter((o): o is Ticket => o !== undefined && !released(o));
}

/**
 * The work this ticket has to be standing on when it starts: the tickets it
 * `waitsFor` that are offered right now.
 *
 * The sibling of `heldBy`, and the other half of it. `heldBy` says *when* a ticket
 * may start; this says *what must be in its branch* by then — because being
 * released by an offer means, by definition, being released against a base that
 * does not have that work in it yet.
 *
 * Offered and still going, and nothing else. A cancelled or given-up ticket lets go
 * without leaving any work to take — and the ending has to be asked about as well
 * as the offer, because it does not take the offer back: only the manager's two
 * noes and the verdict clear `offered`, so a ticket cancelled after opening a pull
 * request is still offering, and merging that would ship work the manager stopped.
 *
 * One whose pull request has been merged has put its work in the base, where the
 * ordinary refresh brings it in with everything else. So a dependency drops off this
 * list on its own as it lands, and nothing has to remember what was once on it.
 */
export function awaitedWork(t: Ticket, tickets: readonly Ticket[]): Ticket[] {
  return t.waitsFor
    .map((id) => tickets.find((o) => o.id === id))
    .filter((o): o is Ticket => o !== undefined && o.offered && !ended(o));
}

/**
 * The work in this branch that the base has not got: what it was already carrying,
 * plus whatever this refresh has just taken.
 *
 * A fact about the branch rather than about the dependency, and so a sticky one —
 * once a merge is in the branch it is in it, whatever the board says afterwards.
 * `awaitedWork` cannot answer this: it is the offered work, and only the merged
 * `refreshed` that follows an offer being withdrawn would then record nothing and
 * let the base move onto a commit that has not got the merge this branch is
 * standing on.
 *
 * A ref drops off when its ticket is `done` — the pull request merged, so the work
 * is in the base and the ordinary refresh brings it in with everything else. That,
 * and nothing else: a dependency sent back for changes, rejected, cancelled or
 * belonging to no ticket on the board is still work no commit of the base has.
 */
export function carriedWork(
  t: Ticket,
  tickets: readonly Ticket[],
  taking: readonly string[],
): string[] {
  const landed = (ref: string) => tickets.some((o) => o.branch === ref && o.status === 'done');
  return [...new Set([...t.carrying, ...taking])].filter((ref) => !landed(ref));
}

/**
 * The only policy in the system. Pure: no I/O, no clock, no agent.
 *
 * @param running how many tickets have a stage in flight right now
 * @param held whether the ticket it waits for has not let go yet — `heldBy`, asked
 *   by the caller, which is the one that has the other tickets to hand
 */
export function nextAction(t: Ticket, running: number, p: Policy, held = false): Action {
  if (t.running) return { kind: 'wait' };

  switch (t.status) {
    case 'backlog': // an idea; the manager has not committed to it
    case 'blocked': // waiting on an answer
    case 'plan_gate': // waiting on approval
    case 'cancelled':
    case 'gave_up':
      return { kind: 'wait' };

    // Finished either way. A push to a pull request nobody has decided yet is watched,
    // because a squash there is found out now or as unexplained conflicts much later.
    case 'done':
      return t.pushed !== null && t.pushed.url !== null && t.pushed.landed === null
        ? { kind: 'watch_push' }
        : { kind: 'wait' };

    case 'awaiting_verdict':
      // A merge asked for is an answer already given, so there is nothing to poll for.
      return t.mergeRequested ? { kind: 'merge_pr' } : { kind: 'poll_verdict' };

    case 'ready_for_pr':
      return { kind: 'open_pr' };

    case 'queued':
      return start(t, 'plan', running, p, held);

    case 'planning':
    case 'implementing':
    case 'reviewing':
    case 'verifying':
      return start(t, STAGE_FOR_STATUS[t.status], running, p, held);
  }
}

/**
 * The limits are checked here rather than at the point of spending, so nothing
 * starts that the policy would not pay for. Both apply to every stage, not just
 * the first.
 */
function start(t: Ticket, stage: Stage, running: number, p: Policy, held: boolean): Action {
  // Giving up needs no capacity, so it is decided before the work-in-progress limit.
  if (t.costUsd >= p.maxTicketUsd) {
    return {
      kind: 'give_up',
      reason: `spent $${t.costUsd.toFixed(2)}, which is the $${p.maxTicketUsd} a ticket may cost`,
    };
  }

  // Only a new plan is capped. A ticket on its last allowed cycle must be free to
  // finish that cycle — implement, review and verify are how it gets there.
  //
  // Reaching it is not the workbench being finished with the ticket; it is the
  // agents failing to agree, which is a thing for the manager to settle rather
  // than a reason to bin work. So it hands over instead of giving up: ship what is
  // there, guide it, or stop it. Every real ticket so far has died here.
  if (stage === 'plan' && t.cycles >= p.maxCycles) {
    return {
      kind: 'hand_over',
      reason:
        `planned ${t.cycles} times without review approving the result. ` +
        (t.rejection === null ? '' : `The last objection: ${t.rejection}\n\n`) +
        'Yours to settle: ship what is there, say what to do differently, or stop it.',
    };
  }

  // Checked after the limits and before the slot: a ticket that is out of money is
  // out of money whoever it is waiting for, and one that is waiting should not be
  // holding a slot open in the meantime.
  if (held) return { kind: 'wait' };

  return running < p.wipLimit ? { kind: 'run_stage', stage } : { kind: 'wait' };
}
