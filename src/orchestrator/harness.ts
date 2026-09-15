import { createOrchestrator, type RunResult, type StageRunner, type Verdict } from './loop.ts';
import { openStore, type Store } from '../store/store.ts';
import type { CheckRun, Event, Refreshed, Stage } from '../domain/events.ts';
import type { Credentials } from '../run/credentials.ts';

export type StageOutcome = RunResult | ((attempt: number) => RunResult);

export type Harness = {
  store: Store;
  orch: ReturnType<typeof createOrchestrator>;
  /** Every stage run that happened, in order. */
  ran: Stage[];
  prsOpened: string[];
  /** Every worktree asked for, in order, with the branch it was to be cut from when it was given one. */
  prepared: { id: string; on?: string }[];
  /** Every push to a branch the workbench does not own that landed, as `<ticket> -> <branch>`. */
  pushes: string[];
  /**
   * Every branch-bringing-in that was asked for, in order. `on` only for a ticket on a
   * branch it does not own, so a test about any other ticket reads as it always did.
   */
  refreshed: { id: string; alsoMerge: readonly string[]; keepConflict: boolean; on?: string }[];
  /** The pull requests the loop merged, in order. */
  prsMerged: string[];
  /** Tickets whose worktree was cleaned up. */
  tidied: string[];
  /** Tickets whose left-behind merge was undone, in order. */
  abandoned: string[];
  /** Every stage commit that was made, as `<ticket>: <message>`. */
  committed: string[];
  /** What the loop told whoever is watching. */
  announced: string[];
  close: () => Promise<void>;
};

export const ok = (summary: string): RunResult => ({ outcome: 'completed', summary });

/**
 * The shape of the real split, which is what makes a session limit worth scoping:
 * plan on one model, the stages that write code on another. Names of its own rather
 * than the real ones, so a test says what it is about and not what the agent files
 * happen to say today.
 */
export const MODELS: Record<Stage, string> = {
  plan: 'the thinking model',
  implement: 'the coding model',
  review: 'the coding model',
  verify: 'the coding model',
};

/**
 * A whole orchestrator with the outside world faked: no agents, no git, no GitHub.
 * Everything else is the real thing.
 *
 * The only way a test builds an orchestrator, so a field added to `Deps` is filled
 * in one place. Say what the test is about — `stages` for what an agent returns, or
 * `runStage` when the test is about the run itself — and leave the rest alone.
 */
export function harness(
  opts: {
    stages?: Partial<Record<Stage, StageOutcome>>;
    runStage?: StageRunner;
    /** The manager's answer. A function when it differs by ticket. */
    verdict?: Verdict | ((ticketId: string) => Verdict);
    openPr?: () => Promise<string>;
    merge?: (ticketId: string) => Promise<void>;
    /**
     * What pushing to a branch the workbench does not own does, on the nth attempt for
     * that ticket. May throw — `RemoteMoved` is what a branch that moved on throws. A
     * fresh commit and no pull request is the default.
     */
    push?: (ticketId: string, attempt: number) => { commit: string; url?: string };
    /** What became of the pull request a push went to. Nobody deciding is the default. */
    landed?: (ticketId: string) => 'pending' | 'merged' | 'squashed' | 'closed';
    /**
     * What tidying up does. Somewhere to watch an acceptance from: it is the first
     * thing that follows one, whether the merge was asked for here or found on the
     * host, and the pass over the other branches comes straight after it.
     */
    discard?: (ticketId: string) => Promise<void>;
    /** The store to drive. Its own in-memory one unless a test needs two over one. */
    store?: Store;
    credentials?: () => Credentials;
    /** What the standing checks say. None configured is the default. */
    checks?: CheckRun[] | (() => CheckRun[]);
    /**
     * What bringing the base in does. An up-to-date branch is the default.
     * `keepConflict` says the caller has a stage that can finish the merge: the
     * refresh at the start of one, or a branch being brought up to the base it must
     * land on — offering the work, and the pass over the offered branches after a
     * merge — both of which run implement to settle what they find. The rest hand a
     * clash to the manager and want the branch left as it was.
     */
    refresh?: (ticketId: string, keepConflict: boolean) => Refreshed;
    /**
     * What a stage left of a merge it was handed. Nothing — the stage resolved it
     * — is the default, because that is what a stage handed one is asked to do.
     */
    unresolved?: (paths: readonly string[]) => string[];
    /**
     * What the branch deletes of what the base added. Nothing is the default: an
     * ordinary ticket touches its own files and no others.
     */
    removedFromBase?: (ticketId: string, from?: string) => string[];
    /**
     * The clock a session limit is measured against. The real one by default; a test
     * about waiting one out moves it rather than waiting.
     */
    now?: () => number;
    /** Which model a stage runs on, for the stages a test wants to differ from `MODELS`. */
    models?: Partial<Record<Stage, string>>;
  } = {},
): Harness {
  const store = opts.store ?? openStore(':memory:');
  // A base is reported only by the call that actually cuts the branch, as the real
  // one does — otherwise every stage re-announces a branch that already exists.
  const branched = new Set<string>();
  const ran: Stage[] = [];
  const prsOpened: string[] = [];
  const prepared: Harness['prepared'] = [];
  const pushes: string[] = [];
  const pushAttempts = new Map<string, number>();
  const refreshed: Harness['refreshed'] = [];
  const prsMerged: string[] = [];
  const tidied: string[] = [];
  const abandoned: string[] = [];
  const committed: string[] = [];
  const announced: string[] = [];
  const attempts = new Map<Stage, number>();

  const orch = createOrchestrator({
    store,
    workspace: {
      prepare: async (id, _from, on) => {
        prepared.push({ id, ...(on === undefined ? {} : { on }) });
        const first = !branched.has(id);
        branched.add(id);
        return {
          path: `/tmp/wb/${id}`,
          scratch: `/tmp/wb/${id}.scratch`,
          base: first ? 'abc1234' : null,
        };
      },
      refresh: async (id, alsoMerge = [], keepConflict = false, on) => {
        refreshed.push({ id, alsoMerge, keepConflict, ...(on === undefined ? {} : { on }) });
        return opts.refresh?.(id, keepConflict) ?? { kind: 'up-to-date' };
      },
      unresolved: async (_id, paths) => opts.unresolved?.(paths) ?? [],
      abandonMerge: async (id) => {
        abandoned.push(id);
      },
      removedFromBase: async (id, from) => opts.removedFromBase?.(id, from) ?? [],
      commit: async (ticket, message) => {
        committed.push(`${ticket.id}: ${message}`);
        // A hash of its own each time, as real commits have: a test that counts what
        // is on the branch cannot be answered by one the fake repeats.
        return `c0ffee${committed.length}`;
      },
      discard: async (id) => {
        tidied.push(id);
        await opts.discard?.(id);
      },
    },
    host: {
      openPr: async (t) => {
        const url = opts.openPr ? await opts.openPr() : `https://example/pr/${t.id}`;
        prsOpened.push(url);
        return url;
      },
      verdict: async (t) => {
        const configured = opts.verdict ?? { kind: 'pending' };
        return typeof configured === 'function' ? configured(t.id) : configured;
      },
      merge: async (t) => {
        await opts.merge?.(t.id);
        prsMerged.push(t.prUrl ?? '');
      },
      push: async (t) => {
        const attempt = (pushAttempts.get(t.id) ?? 0) + 1;
        pushAttempts.set(t.id, attempt);
        const pushed = opts.push?.(t.id, attempt) ?? { commit: `feed${attempt}` };
        pushes.push(`${t.id} -> ${t.on}`);
        return pushed;
      },
      landed: async (t) => opts.landed?.(t.id) ?? 'pending',
    },
    runStage: async (args) => {
      ran.push(args.stage);
      if (opts.runStage) return opts.runStage(args);
      const attempt = (attempts.get(args.stage) ?? 0) + 1;
      attempts.set(args.stage, attempt);
      const configured = opts.stages?.[args.stage];
      if (configured === undefined) return ok(`${args.stage} done`);
      return typeof configured === 'function' ? configured(attempt) : configured;
    },
    checks: async () => (typeof opts.checks === 'function' ? opts.checks() : (opts.checks ?? [])),
    credentials: async () => opts.credentials?.() ?? { ok: true, how: 'a test' },
    modelFor: (stage) => opts.models?.[stage] ?? MODELS[stage],
    announce: (message) => announced.push(message),
    now: opts.now,
  });

  return {
    store,
    orch,
    ran,
    prsOpened,
    prepared,
    pushes,
    refreshed,
    prsMerged,
    tidied,
    abandoned,
    committed,
    announced,
    close: async () => {
      await orch.stop();
      // A store the test brought is the test's to close: the point of sharing one
      // is that a second orchestrator opens over it after this one has gone.
      if (!opts.store) store.close();
    },
  };
}

/** A ticket the manager has committed to. A backlogged one would never start. */
export function create(store: Store, id = 't1'): void {
  store.append(id, { type: 'ticket_created', title: `ticket ${id}`, body: 'do it' });
  store.append(id, { type: 'queued' });
}

/**
 * A ticket whose work is already offered and waiting on the manager. Written
 * rather than run, so it is standing before anything else starts: what happens to
 * a pull request while another one merges cannot be tested against a race to
 * reach one.
 */
export function standing(store: Store, id: string): void {
  create(store, id);
  store.append(id, { type: 'pr_opened', url: `https://example/pr/${id}` });
}

/** A ticket committed to, told what it waits for, and only then queued. */
export function waiting(store: Store, id: string, tickets: string[]): void {
  store.append(id, { type: 'ticket_created', title: `ticket ${id}`, body: 'do it' });
  store.append(id, { type: 'waits_for', tickets });
  store.append(id, { type: 'queued' });
}

/** Lets the loop settle until `want` is true, rather than guessing how many turns it takes. */
export async function waitFor(want: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (want()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** What one stage run recorded, from its `stage_started` to its `stage_finished`. */
export function during(store: Store, ticketId: string, stage: Stage): Event[] {
  const events = store.eventsFor(ticketId);
  const from = events.findIndex((e) => e.type === 'stage_started' && e.stage === stage);
  if (from === -1) return [];
  const to = events.findIndex((e, i) => i > from && e.type === 'stage_finished');
  return events.slice(from, to === -1 ? undefined : to);
}
