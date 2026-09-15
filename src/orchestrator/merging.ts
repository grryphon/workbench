import { ended, type Ticket } from '../domain/ticket.ts';
import { carriedWork } from '../domain/rules.ts';
import type { Refreshed } from '../domain/events.ts';
import type { Branch } from './branch.ts';
import { describe, describeRef, RemoteMoved } from './describe.ts';
import type { Deps, RunResult, Verdict } from './loop.ts';

/**
 * What a branch being brought up to its base may do about a clash with it, which
 * is the only thing that differs between the four moments one is brought up.
 *
 * - `no`: nothing. The manager is asked, and a merge found on disk is left exactly
 *   where the run that stopped partway through left it. The offer a settle makes
 *   once it has landed — which is where "one attempt" is actually enforced.
 * - `inline`: run implement over the merge and wait for it. The first offer of the
 *   work, which has nothing else to be getting on with.
 * - `detached`: run implement over the merge beside whatever asked for it. The pass
 *   over the other offered branches after a merge, which holds the merge gate: five
 *   accepts in thirteen seconds queued behind the sum of every settle for every
 *   other branch, and said so nowhere.
 * - `merge`: run implement over the merge, and merge what it landed. A merge the
 *   manager asked for, which is one attempt like every other and then the click
 *   they made, rather than a click that says resolve them and another one after it.
 */
type Settling = 'no' | 'inline' | 'detached' | 'merge';

/** Offering a ticket's work, and everything that follows the manager's answer. */
export type Merging = {
  /** Offers the ticket's work, and says whether it got as far as offering it. */
  openPr: (ticket: Ticket) => Promise<boolean>;
  pollVerdict: (ticket: Ticket) => Promise<void>;
  /** Records what became of the pull request a push went to, and says so if it was squashed. */
  watchPush: (ticket: Ticket) => Promise<void>;
  mergePr: (ticket: Ticket) => Promise<void>;
  /** Whether a merge holds the gate, so another one may not start. */
  merging: () => boolean;
  /** Records once that this ticket is queued behind the merge that holds the gate. */
  tellQueued: (ticket: Ticket) => void;
};

export function createMerging({
  deps,
  branch,
  busy,
  settleOffered,
  holding,
}: {
  deps: Deps;
  branch: Branch;
  /** Whether this ticket's work is already in flight in this process. */
  busy: (ticketId: string) => boolean;
  /**
   * Runs implement over a merge left in the worktree of a ticket being offered, and
   * says how it went. One run: what it does not settle, the manager is asked about.
   * `clashedWith` names the branch the merge is against when it is not the base —
   * the run is told what it is resolving, and what it commits is recorded as work
   * this ticket took in rather than as the base moving.
   */
  settleOffered: (ticket: Ticket, clashedWith?: string) => Promise<RunResult>;
  /**
   * Runs `work` beside whatever asked for it, with the ticket held in flight for
   * the whole of it so no tick starts a stage of its own in the worktree it is
   * using. Not awaited: the point of it is that the merge gate frees while the
   * work goes on.
   */
  holding: (ticketId: string, work: () => Promise<void>) => void;
}): Merging {
  const { store } = deps;

  /**
   * The merge gate: the ticket merging, and any that arrived while it was. One
   * merge at a time, the pass over every other open pull request included.
   *
   * A merge lands on the base and then brings that base into every other offered
   * branch, one at a time. Two at once put two passes in the same worktrees, and no
   * click is needed for that — a poll that finds three pull requests merged on
   * github.com starts three. A set rather than a flag because insertion order names
   * the holder, which is what a ticket waiting is told it is waiting for.
   */
  const mergeGate = new Set<string>();
  let mergeChain: Promise<unknown> = Promise.resolve();
  /**
   * `<ticket>:<holder>` for every wait already recorded, so it is said once rather
   * than once a tick — and said again when the holder changes, which is the only
   * part of it that is news. The record is what stops the append re-entering `tick`
   * through the store subscription for ever, and it lasts exactly as long as the
   * merge it is about: see `runMerge`, which drops a holder's keys as it leaves the
   * gate. Kept for the life of the process instead, a ticket queued behind the same
   * one twice — both blocked by a host that refused the merge, both accepted again —
   * said nothing the second time and read as a bare "merging…" throughout.
   */
  const toldTheyWait = new Set<string>();
  /** So a code host outage is said once, not once per poll. */
  let hostAnswering = true;

  /**
   * Queues `fn` behind whatever else is merging, and runs it with nothing else.
   *
   * The gate is taken here rather than when the chain reaches `fn`, so a tick that
   * runs in between sees the queue and leaves the ticket alone. What fails is the
   * caller's to answer — the chain swallows it, because the next merge in the queue
   * is not the one that failed and must still be let through.
   */
  function runMerge<T>(id: string, fn: () => Promise<T>): Promise<T> {
    mergeGate.add(id);
    const next = mergeChain.then(fn);
    const done = () => {
      mergeGate.delete(id);
      // The waits this merge caused go with it. The re-entry the record guards
      // against is a tick appending the same wait again, and by here this merge is
      // out of the gate: whoever holds it now is somebody else, so the next wait
      // behind *this* ticket is a new one, and a new one is worth saying.
      for (const key of toldTheyWait) if (key.endsWith(`:${id}`)) toldTheyWait.delete(key);
    };
    mergeChain = next.then(done, done);
    return next;
  }

  /**
   * The manager's answer, or null when the code host could not be asked.
   *
   * Asking is a read, and the timer asks again thirty seconds later, so a failure
   * is a blip rather than a decision: it is said out loud and nothing is recorded.
   * Recording it would block the ticket, which spends a person on the network —
   * one outage parked two tickets a tenth of a second apart, and answering a
   * blocked ticket bought a verify stage that had already passed.
   *
   * Everything else that can fail here is a decision and still blocks: a stage
   * that died, a push that was refused, a base that will not merge.
   */
  async function verdictOf(ticket: Ticket): Promise<Verdict | null> {
    try {
      const verdict = await deps.host.verdict(ticket);
      if (!hostAnswering) {
        hostAnswering = true;
        deps.announce('the code host is answering again — reading verdicts');
      }
      return verdict;
    } catch (error) {
      if (hostAnswering) {
        hostAnswering = false;
        deps.announce(
          `⚠️  cannot read verdicts: ${describe(error)}\n` +
            'Still asking. Nothing is lost, and no ticket is stopped by this.',
        );
      }
      return null;
    }
  }

  /**
   * Offering the ticket's work. Safe to reach twice, and not by skipping the host
   * when the ticket already has a URL: what the host does first is push, and a
   * ticket back here has commits the pull request has never seen. It is the host
   * that reuses the pull request the branch already has.
   *
   * @param settling what a clash found here may do. `inline` for the offer the
   *   board asks for: it is the same clash the pass over the offered branches
   *   settles a moment later, and blocking for it spent a click that only ever said
   *   resolve them. `no` for the offer a settle makes again once it has landed —
   *   that is what makes it one attempt.
   */
  async function doOpenPr(ticket: Ticket, settling: Settling = 'inline'): Promise<boolean> {
    // The workspace has to exist to be offered, even though the host finds it itself.
    const { path: worktree } = await branch.prepare(ticket);
    // Offered against the code that exists, not the code that did when the branch
    // was cut. A ticket that cannot be brought up to date is not offered at all.
    if (!(await refresh(ticket, worktree, settling))) return false;
    if (ticket.on !== null) return await pushBack(ticket, ticket.on, worktree);
    const url = await deps.host.openPr(ticket);
    store.append(ticket.id, { type: 'pr_opened', url });
    return true;
  }

  /**
   * Offering, for a ticket on a branch the workbench does not own: the work is pushed
   * back to that branch rather than to a pull request of its own, and the push landing
   * is the end of the ticket. See "The workbench owns how work lands" in docs/design.md.
   *
   * A branch that moved on while this was being offered is taken in and pushed again,
   * once. What that refresh cannot settle blocks the ticket like any other clash, and a
   * second refusal throws — `perform` parks the ticket with it. Never a force: the work
   * stands on `wb/<id>` for a person to take from there.
   */
  async function pushBack(ticket: Ticket, on: string, worktree: string): Promise<boolean> {
    let pushed: { commit: string; url?: string };
    try {
      pushed = await deps.host.push(ticket);
    } catch (error) {
      if (!(error instanceof RemoteMoved)) throw error;
      if (!(await refresh(store.ticket(ticket.id), worktree, 'no'))) return false;
      pushed = await deps.host.push(store.ticket(ticket.id));
    }
    store.append(ticket.id, {
      type: 'pushed',
      branch: on,
      commit: pushed.commit,
      ...(pushed.url === undefined ? {} : { url: pushed.url }),
    });
    return true;
  }

  /**
   * Brings the base — and the work this ticket waited for, which is offered and so
   * is not in the base yet — into a ticket's branch, and says whether the ticket
   * may carry on. A clean branch is the ordinary answer: nothing merged, nothing
   * recorded, nothing re-run, nothing spent.
   *
   * When something did merge, the standing checks decide. They are the whole point
   * of refreshing — a merge git can do silently is exactly the change that breaks
   * a ticket against work that landed while it was busy, and running them here is
   * how that is found on the ticket rather than by a person at merge time.
   *
   * A failure parks the ticket rather than starting anything: the work stands, and
   * what to do about a base that breaks it is a decision — ship it, put it right, or
   * stop it — rather than a stage. A clash is the one exception, and only where
   * `settling` says a run may be given the merge: see the conflicted branch below.
   * What a conflict does leave behind is whatever merged before it, so that is
   * recorded first: the branch has moved, and a record that says otherwise is what
   * measures a dependency's change as this ticket's.
   *
   * @param settling what a clash may do here: nothing, a run waited for, a run
   *   beside this one, or a run and then the merge. See `Settling`.
   * @returns whether the caller may carry on — offer the work, or merge it.
   */
  async function refresh(
    ticket: Ticket,
    worktree: string,
    settling: Settling = 'no',
  ): Promise<boolean> {
    const result = await deps.workspace.refresh(
      ticket.id,
      branch.awaitedBranches(ticket),
      // Left on disk only where there is something that will finish it.
      settling !== 'no',
      // For a ticket on a branch it does not own, that branch is what it is kept current with.
      ticket.on ?? undefined,
    );

    if (result.kind !== 'up-to-date') {
      // What came in with the base is recorded along with it, because a branch
      // standing on work the base has not got cannot be measured from the base: see
      // `refreshed` in events.ts. Written whichever way the merge went — a conflict
      // leaves everything that merged before it standing, and the branch's record has
      // to say where the branch is rather than where it was.
      const took = result.merged.filter((ref) => ref !== result.base);
      if (result.merged.length > 0) {
        store.append(ticket.id, {
          type: 'refreshed',
          base: result.base,
          commit: result.commit,
          took,
          // Everything the base still has not got, not only what came in now: a
          // dependency sent back for changes stops being offered without its work
          // reaching the base, and the reducer is what decides whether the base may
          // move onto this one.
          carrying: carriedWork(ticket, store.tickets(), took),
        });
      }

      if (result.kind === 'conflicted') {
        // A clash on a branch being offered is the agents' to settle: the merge is
        // left where it is and an implement run is asked to finish it, exactly as the
        // start of a stage already does. The manager's click did not say anything a
        // run could not work out for itself.
        //
        // Whatever it clashed with, the base or the work this ticket waited for. That
        // used to stop at the base, on the grounds that a dependency's clash belongs to
        // whoever chose the dependency — but the resolution is the same mechanical work
        // either way, and the manager learns whether the decomposition was bad from
        // what the attempt says about it rather than from a button that always says
        // resolve them. Only where the merge is still on disk, though: one that failed
        // rather than conflicted has nothing to resolve. And where no settle may run at
        // all, a merge found on disk is left exactly where its run left it — there is
        // no attempt here to undo half of.
        if (settling === 'no' || !result.merging) {
          block(ticket, result);
          return false;
        }

        // Beside the caller rather than inside it, and the caller is done: this is
        // the pass over the other offered branches, which holds the merge gate. An
        // agent run in there is every queued Accept waiting on it — and waiting
        // without a word, since a queued merge records nothing of its own.
        if (settling === 'detached') {
          holding(ticket.id, async () => {
            try {
              await settle(ticket, result, 'detached');
            } catch (error) {
              store.append(ticket.id, { type: 'blocked', reason: describe(error) });
            }
          });
          return false;
        }

        // Waited for, because the caller has nothing to be getting on with. Only a
        // merge carries on afterwards, and only when the resolution landed — so the
        // click buys the resolution and the merge, rather than the resolution and
        // another click. Offering says no whatever happened: a settle that landed
        // has pushed the offer already, and the manager has been asked about one
        // that did not.
        const landed = await settle(ticket, result, settling);
        return settling === 'merge' && landed;
      }
    }

    // What the branch deletes of what the base added while it was being built.
    // Asked after the merge and never before it: before it, every file the base has
    // just gained is missing from the branch and every ticket would park. An
    // up-to-date branch is asked too — a resolution reverts just as well as a merge
    // does, and it leaves the base exactly where it was.
    const removed = await deps.workspace.removedFromBase(
      ticket.id,
      ticket.base ?? undefined,
      ticket.on ?? undefined,
    );
    if (removed.length > 0) {
      store.append(ticket.id, {
        type: 'blocked',
        reason:
          'this branch deletes files the base added while it was being built:\n' +
          removed.map((p) => `  ${p}`).join('\n') +
          '\n\nThey are the base’s work, not this ticket’s, and the answer is ' +
          'almost always to put them back as the base has them.',
      });
      return false;
    }

    if (result.kind === 'up-to-date') return true;

    const failed = (await deps.checks(worktree)).filter((r) => !r.ok);
    if (failed.length === 0) return true;

    store.append(ticket.id, {
      type: 'blocked',
      reason:
        `the base has moved on to ${result.base.slice(0, 8)}, and against it ` +
        `${failed.length} standing check(s) fail:\n\n` +
        failed.map((f) => `\`${f.command}\` failed:\n${f.output}`).join('\n\n'),
    });
    return false;
  }

  /** The manager is asked about the clash, in prose and in paths. */
  function block(
    ticket: Ticket,
    result: Extract<Refreshed, { kind: 'conflicted' }>,
    attempt?: RunResult,
  ): void {
    store.append(ticket.id, {
      type: 'blocked',
      reason:
        `this branch conflicts with ${describeRef(result.with, result.base)}:\n` +
        result.paths.map((p) => `  ${p}`).join('\n') +
        (attempt === undefined
          ? ''
          : `\n\nA resolution was tried and did not land: ${attempt.summary}`),
      // The same paths as data, so the panel can list them and offer the way out
      // rather than leaving them buried in a paragraph.
      conflicts: result.paths,
      // And what they are a clash with, from the same pair the reason above is
      // written from, so the panel's heading cannot say the base where the
      // reason says a dependency's branch.
      conflictedWith: { ref: result.with, base: result.base },
    });
  }

  /**
   * The one attempt at a clash, with the base or with work this ticket waited for:
   * an implement run over the merge left on disk, and what follows it whichever way
   * it goes. Its own function because
   * *where* it runs differs — inside the offer that found the clash, or beside the
   * pass that did, which must not wait for it — and what it does does not.
   *
   * @param settling which of the four moments asked for it, which decides only
   *   whether the manager still has to be asked about the offer afterwards.
   * @returns whether the resolution landed and was pushed.
   */
  async function settle(
    ticket: Ticket,
    result: Extract<Refreshed, { kind: 'conflicted' }>,
    settling: Settling,
  ): Promise<boolean> {
    // Told what it is resolving when that is not the base — a branch this ticket
    // waited for, which is offered and so in no commit of the base yet.
    const attempt = await settleOffered(
      ticket,
      result.with === result.base ? undefined : result.with,
    );

    if (attempt.outcome === 'completed') {
      // Offered again, which runs the refresh and the checks against a branch that is
      // now up to date. From the store: the settling run moved the base and made a
      // commit, and the ticket in hand still says otherwise. Never with a settle of
      // its own, whichever way this goes: one attempt is the rule, and refusing it
      // there is what stops a settle being able to ask for another.
      const settled = store.ticket(ticket.id);

      if (!ticket.offered) {
        // The first offer of the work, straight after verify. There is no pull
        // request yet, so there is no verdict to read and nothing the manager can
        // have answered — asking the host would be a question about an offer that
        // does not exist. What the minutes of a settle can still bring is the ticket
        // being stopped, or offered by something else; the resolution then stays on
        // the branch, for whatever runs next.
        //
        // The ticket reads `implementing` in here: a settling run sets no status, so
        // the `stage_started` it made stands until the next event. That event is the
        // `pr_opened` or the `blocked`, appended with the ticket held in flight
        // throughout — see `holding` in loop.ts.
        if (ended(settled) || settled.offered) return false;
        return await doOpenPr(settled, 'no');
      }

      // An offer that was already standing, so the resolution is pushed to the pull
      // request the manager is reading — but only while it is still standing, which
      // the manager can end from the board at any point in the minutes this takes.
      if (ended(settled) || !settled.offered) return false;

      // A merge the manager asked for is not asked about again: the Accept is the
      // answer, and the ticket has been in flight for the whole of the settle, so no
      // poll can have brought a different one back. What asking would add is
      // `verdictOf`'s null — the blip it exists to tolerate, over a window that is
      // now a whole agent run — and a null here would leave the resolution committed
      // and never pushed, with `mergeRequested` still standing: the next tick finds
      // the branch up to date, skips the settle, and merges a pull request whose head
      // has none of the resolution.
      if (settling === 'merge') return await doOpenPr(settled, 'no');

      // Everywhere else the offer is still unanswered too, the same thing
      // `refreshOffered` asks before it starts any of this. The window used to be a
      // git merge and is now a whole agent run, and in that time the manager can ask
      // for changes and a poll can find the pull request merged. Pushing then would
      // append `pr_opened` over their answer: the objection silently undone, or a
      // pull request reopened on work already merged. The resolution stays on the
      // branch either way.
      const still = await verdictOf(settled);
      return still?.kind === 'pending' ? await doOpenPr(settled, 'no') : false;
    }

    // Nothing landed, so nothing is kept: whatever the attempt left goes, and the
    // manager is asked about the work as it was offered.
    //
    // A merge this pass did not start goes with it, and that is taken rather than
    // guarded against: `refresh` in worktree.ts hands back one an earlier run stopped
    // partway through, and wherever a settle may run that merge is given to it, so an
    // attempt that does not land undoes both runs' half of the resolution. What the
    // alternative keeps is a branch carrying two unfinished merges, for the manager to
    // answer about and the next commit to pick up, which is the loss `abandonMerge`
    // exists to prevent.
    await deps.workspace.abandonMerge(ticket.id);
    block(ticket, result, attempt);
    return false;
  }

  /**
   * A merge moves the base under every other pull request that is standing, and
   * they find out one at a time as somebody tries to merge them. So they are told:
   * each takes the new base and re-runs its checks, and a clash is given to an
   * implement run — the ticket is the thing being worked on, and resolving one is
   * work rather than a decision.
   *
   * The ones still being built are told too, but not here: they take the base at
   * the start of their next stage, and the same run resolves it as part of what it
   * was going to do anyway. Nothing is pushed for them, so there is nothing to do
   * between stages.
   *
   * This pass holds the merge gate, so what it does here is git and nothing else: a
   * clash goes to a run beside it and the gate frees as soon as the last refresh
   * returns. Five accepts thirteen seconds apart once queued behind the sum of every
   * settle for every other offered branch — seven and a half minutes of "merging…",
   * with the runs that were causing it invisible from the board.
   */
  async function refreshOffered(merged: Ticket): Promise<void> {
    // Ended tickets are told nothing. Cancelling does not take the offer back — see
    // `awaitedWork` for why it must not — so a cancelled ticket still reads as
    // offered, and without this every later merge brought it back up to the base,
    // found the conflicts nobody is going to resolve, and blocked it: a ticket the
    // manager stopped, back on the board hours after they stopped it.
    //
    // A ticket whose own merge is queued is left out as well. The base will very
    // likely move again before its turn comes, so settling it now buys a run against
    // a base that is already history — and its own merge refreshes and settles when
    // it reaches the front, which is one run per accept rather than one per landing.
    const standing = store
      .tickets()
      .filter(
        (t) =>
          t.id !== merged.id &&
          t.offered &&
          !ended(t) &&
          !t.running &&
          !t.mergeRequested &&
          !busy(t.id),
      );

    for (const { id } of standing) {
      try {
        // Read again for each one, because settling the one before it was a whole
        // agent run rather than a git merge: in those minutes this ticket can have
        // been sent back and started an implement run of its own. Refreshing it then
        // puts a `git merge` in a worktree an agent is writing in, and the settle's
        // claim on `inFlight` lands on top of the one that run already holds — whose
        // `finally` then deletes it, so the tick stops seeing either as busy.
        const ticket = store.ticket(id);
        if (!ticket.offered || ended(ticket) || ticket.running || busy(id)) continue;
        // Or asked to be merged in between, which is the same skip as above: the
        // Accept it is queued behind is the one refreshing it, when its turn comes.
        if (ticket.mergeRequested) continue;

        // A pull request the manager has already answered is waiting on nobody: it
        // is not refreshed, because pushing a merge to it would be a commit made
        // for reasons that have nothing to do with the answer, and `readVerdict`
        // reads a branch that has moved past a change request as having addressed
        // it. The next poll picks the answer up.
        const answered = await verdictOf(ticket);
        if (answered === null || answered.kind !== 'pending') continue;
        const { path: worktree } = await branch.prepare(ticket);
        await refresh(ticket, worktree, 'detached');
      } catch (error) {
        store.append(id, { type: 'blocked', reason: describe(error) });
      }
    }
  }

  async function doPollVerdict(ticket: Ticket): Promise<void> {
    const verdict = await verdictOf(ticket);
    if (verdict === null || verdict.kind === 'pending') return;

    store.append(ticket.id, {
      type: 'verdict',
      verdict: verdict.kind,
      reason: verdict.kind === 'rejected' ? verdict.reason : undefined,
    });

    // Behind the same gate as a merge asked for here: one poll can find three pull
    // requests merged on github.com, and three passes over the same worktrees at
    // once is what blocked t9 four times in 320ms.
    if (verdict.kind === 'accepted') await runMerge(ticket.id, () => accepted(ticket));
  }

  /**
   * What became of the pull request a push to somebody else's branch went to.
   *
   * The workbench cannot stop a squash in a repository it does not run, so it notices
   * one: said plainly, naming the commit that now has no ancestry in the base, rather
   * than left to surface as add/add conflicts in whichever ticket builds on it next.
   * A host that cannot be asked is asked again on the next poll, like a verdict.
   */
  async function doWatchPush(ticket: Ticket): Promise<void> {
    const pushed = ticket.pushed;
    if (pushed === null) return;
    let how: Awaited<ReturnType<typeof deps.host.landed>>;
    try {
      how = await deps.host.landed(ticket);
    } catch {
      return;
    }
    if (how === 'pending') return;

    store.append(ticket.id, { type: 'landed', how });
    if (how === 'squashed') {
      deps.announce(
        `⚠️  ${ticket.id}: the pull request on ${pushed.branch} was squashed. ` +
          `${pushed.commit.slice(0, 8)}, which ${ticket.id} pushed there, is not in the base's ` +
          'history, so that work has no ancestry: anything built on those commits will ' +
          'conflict with the base on every file they share.',
      );
    }
  }

  /**
   * The manager said merge it, here rather than on the code host.
   *
   * The base goes in first, and a clash gets the one resolution attempt every other
   * branch meeting its base gets: the same run, with the same brief, and the same
   * abort-and-block when it does not land. What that costs is one run per Accept,
   * held in the gate and said out loud on the ticket — against the runs it replaces,
   * which were one per *landing* for every other offered branch, said nowhere.
   *
   * When nothing lands, nothing is merged, the branch is put back and the ticket
   * parks with the files named. That is the one moment the answer matters most —
   * the alternative is finding out from the host that the merge was refused, which
   * says less and leaves it half-done.
   *
   * The verdict is recorded here rather than left for the next poll to read off
   * the host: the ticket leaves `awaiting_verdict` at once, so a second tick
   * cannot arrive and merge what has already been merged.
   *
   * All of it behind the merge gate, the pass over the other branches included: see
   * `runMerge` for what two of those at once does.
   */
  async function doMergePr(ticket: Ticket): Promise<void> {
    await runMerge(ticket.id, async () => {
      const { path: worktree } = await branch.prepare(ticket);
      // One call and one attempt, rather than parking and being asked again by the
      // next tick: the resolution it landed is pushed and then merged here, so there
      // is no re-entry and so nothing that could settle twice.
      if (!(await refresh(ticket, worktree, 'merge'))) return;

      await deps.host.merge(ticket);
      store.append(ticket.id, { type: 'verdict', verdict: 'accepted' });
      await accepted(ticket);
    });
  }

  /** What follows work being accepted, however the acceptance was arrived at. */
  async function accepted(ticket: Ticket): Promise<void> {
    // Tidying up is not the ticket's business: a directory left behind is untidy,
    // not broken, and must not turn an accepted ticket into a blocked one.
    await deps.workspace.discard(ticket.id).catch(() => {});
    // The base has moved. Everything else standing is now offered against a base
    // that no longer exists, which is the whole reason conflicts turn up at all.
    await refreshOffered(ticket);
  }

  return {
    openPr: doOpenPr,
    pollVerdict: doPollVerdict,
    watchPush: doWatchPush,
    mergePr: doMergePr,
    merging: () => mergeGate.size > 0,

    // Recorded on the ticket rather than said to stdout: the wait is the ticket's
    // news, and a manager reading `merging…` for seven minutes is not watching
    // `wb serve`'s output. An event, so it survives a restart the way the request
    // already does and the panel reads it the way it reads everything else.
    tellQueued(ticket) {
      const holder = [...mergeGate][0];
      if (holder === undefined || toldTheyWait.has(`${ticket.id}:${holder}`)) return;
      toldTheyWait.add(`${ticket.id}:${holder}`);
      store.append(ticket.id, { type: 'merge_queued', behind: holder });
    },
  };
}
