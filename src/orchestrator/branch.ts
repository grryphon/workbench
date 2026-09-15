import type { Stage } from '../domain/events.ts';
import type { Ticket } from '../domain/ticket.ts';
import { awaitedWork, carriedWork } from '../domain/rules.ts';
import { describeRef } from './describe.ts';
import type { Deps } from './loop.ts';

/** A ticket's branch, before its work is offered: cutting it and keeping it current. */
export type Branch = {
  /** Makes the workspace, recording where the branch was cut from the first time. */
  prepare: (ticket: Ticket) => Promise<{ path: string; scratch: string }>;
  /** Brings the base in before a stage runs. Says what it did; see `refreshForStage`. */
  refreshForStage: (
    ticket: Ticket,
    stage: Stage,
    runId: string,
  ) => Promise<{ merged: boolean; conflict?: { base: string; paths: string[] } }>;
  /** The branches of the offered work this ticket waited for. See `awaitedWork`. */
  awaitedBranches: (ticket: Ticket) => string[];
};

export function createBranch(deps: Deps): Branch {
  const { store } = deps;

  /** Makes the workspace, recording where the branch was cut from the first time. */
  async function prepare(ticket: Ticket): Promise<{ path: string; scratch: string }> {
    const { path, scratch, base } = await deps.workspace.prepare(
      ticket.id,
      // A ticket that continues another starts from that one's branch, so its
      // work is on disk here rather than stranded where nothing can read it.
      ticket.continues === null ? undefined : `wb/${ticket.continues}`,
      // A ticket on somebody else's branch is cut from that branch instead of the base.
      ticket.on ?? undefined,
    );
    if (base !== null) {
      store.append(ticket.id, { type: 'branched', branch: ticket.branch, base });
      await takeAwaitedWork(ticket);
    }
    return { path, scratch };
  }

  /**
   * Puts the work this ticket waited for into the branch just cut for it.
   *
   * A ticket is released the moment what it waits for is *offered*, which is the
   * right moment — but the base does not have that work in it yet, and by
   * definition will not until a person merges it. So the branch is cut from the
   * base, as every branch is, and then the offered work is merged in: the commit
   * this ticket needs is the base with all of its dependencies on it, and nowhere
   * else in the world is there one. Without this the wait is honoured in name and
   * defeated in fact — the ticket starts at the right time, on the wrong code.
   *
   * Only where the branch is cut, so a ticket pays for this once. The standing
   * checks are not run: they judge a ticket's own work against a base that moved,
   * and there is no work here yet.
   *
   * A conflict blocks the ticket — `perform` turns the throw into `blocked`, and
   * this is reached before `stage_started`, so two dependencies that will not sit in
   * one tree stop it at the cheapest moment there is. Whatever merged before the
   * conflict is recorded first: it is on the branch, and the branch's record has to
   * say what the branch is.
   */
  async function takeAwaitedWork(ticket: Ticket): Promise<void> {
    const branches = awaitedBranches(ticket);
    if (branches.length === 0) return;

    const result = await deps.workspace.refresh(ticket.id, branches, false, ticket.on ?? undefined);
    if (result.kind === 'up-to-date') return;

    // Recorded against the merge rather than the commit the branch was cut from,
    // because that is what this ticket's own work is now measured from: `diff` reads
    // `base...HEAD`, so leaving the base behind the dependencies hands every stage —
    // and then the reviewer — their work as though this ticket had written it. The
    // failure `refreshed` moves the base to prevent, arriving by the other door.
    //
    // What merged, not what was asked for: a conflict leaves the merges before it
    // standing, and a blocked ticket whose base is still the commit it was cut from
    // hands the stage that follows the manager's answer exactly that whole change.
    const took = result.merged.filter((ref) => ref !== result.base);
    if (result.merged.length > 0) {
      store.append(ticket.id, {
        type: 'refreshed',
        base: result.commit,
        commit: result.commit,
        took,
        carrying: carriedWork(ticket, store.tickets(), took),
      });
    }

    if (result.kind === 'conflicted') {
      throw new Error(
        `this branch cannot take ${describeRef(result.with, result.base)}:\n` +
          result.paths.map((p) => `  ${p}`).join('\n'),
      );
    }
  }

  /**
   * Brings the base in before a stage runs, rather than only when the work is
   * offered. A branch that goes stale for a whole implement and a whole verify
   * discovers it at the end, when the agent that could have resolved the clash in
   * minutes has finished and the ticket parks for a person to pick up a day later.
   *
   * Nothing blocks here, and the standing checks are not run: this is the start of
   * a stage, and the stage is what puts things right. A clean merge is the ordinary
   * answer and only records the commit it made. A conflict is left on disk and
   * handed to the run, which cannot finish until it is resolved.
   *
   * Both are said out loud rather than only the conflict, because a clean merge is
   * still code nothing has run the suite against: the caller checks what the stage
   * leaves once it is over, and it can only know to when it is told a merge landed.
   *
   * @returns whether a merge landed, and the merge the stage is being asked to
   *   finish, if there is one.
   */
  async function refreshForStage(
    ticket: Ticket,
    stage: Stage,
    runId: string,
  ): Promise<{ merged: boolean; conflict?: { base: string; paths: string[] } }> {
    // Only the stages that can write. Plan and review are granted no editing tools
    // at all, so a conflict handed to one of them could only sit there unresolved.
    if (stage !== 'implement' && stage !== 'verify') return { merged: false };

    // The base and nothing else: the work this ticket waited for came in at
    // `takeAwaitedWork`, when the branch was cut, so at the start of a stage there is
    // nothing of it left to take. A dependency offered since is brought in when the
    // work is — see the conflicted branch of `refresh` in merging.ts, which is where a
    // clash with one is handed to a run.
    const result = await deps.workspace.refresh(ticket.id, [], true, ticket.on ?? undefined);
    if (result.kind === 'up-to-date') return { merged: false };

    if (result.kind === 'merged') {
      store.append(ticket.id, {
        type: 'refreshed',
        base: result.base,
        commit: result.commit,
        // Nothing was taken here — only the base came in — but what the branch was
        // already standing on is still in it, and a `refreshed` that says otherwise
        // is what lets the base move onto a commit that has not got it.
        carrying: carriedWork(ticket, store.tickets(), []),
      });
      return { merged: true };
    }

    // Nothing left on disk to finish: the merge failed rather than conflicted — an
    // index that was busy, a checkout that could not be written — and `refresh` has
    // already undone it. The stage runs against the base it had, and the offer will
    // find it again. Asked of the merge rather than of the paths, because a run that
    // stopped after staging its resolution leaves one with no unmerged paths at all,
    // and that merge still has to be finished and recorded by whoever takes it on.
    if (!result.merging) return { merged: false };

    store.append(ticket.id, { type: 'conflicted', runId, base: result.base, paths: result.paths });
    // Not `merged`: the only ref asked for was the base, and it is the one that would
    // not go in. What is on the branch is what was already on it.
    return { merged: false, conflict: { base: result.base, paths: result.paths } };
  }

  /** The branches of the offered work this ticket waited for. See `awaitedWork`. */
  function awaitedBranches(ticket: Ticket): string[] {
    return awaitedWork(ticket, store.tickets()).map((t) => t.branch);
  }

  return { prepare, refreshForStage, awaitedBranches };
}
