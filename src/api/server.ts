import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Store } from '../store/store.ts';
import type { Event } from '../domain/events.ts';
import { ended, type Ticket } from '../domain/ticket.ts';
import type { Config } from '../config.ts';
import { analyse } from '../domain/analytics.ts';
import { chatTurns } from '../domain/board.ts';
import { proposalEvent } from '../domain/proposals.ts';
import type { ChatRunner } from '../run/chat.ts';
import { createDoc, deleteDoc, listDocs, writeDoc, type DocKind } from './documents.ts';
import { applySettings, settings } from './settings.ts';
import type { NameChecker } from '../run/nameCheck.ts';
import type { Orchestrator } from '../orchestrator/loop.ts';
import { isBranchName } from '../git/worktree.ts';

/** The built board. `npm run build` puts it here; `npm run ui` serves it itself instead. */
export const UI_DIST = fileURLToPath(new URL('../../ui/dist', import.meta.url));

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

/**
 * What the API needs that is not state: the things here that talk to a model
 * service. Each is optional, and a workbench without one simply does not have that
 * feature — the routes say so rather than pretending, and everything else works
 * exactly as before.
 */
export type ApiDeps = {
  /**
   * What a ticket being written might better be called. Absent when nothing should
   * be asked — a workbench running fake agents spends nothing, and this must not be
   * the exception — and then the route answers that it has no suggestion.
   */
  checkName?: NameChecker;
  /**
   * Someone has opened the ticket form, so a name check is coming. Absent for the
   * same reason `checkName` is, and getting ready costs nothing to skip.
   */
  warmNameCheck?: () => void;
  /** The conversation about a ticket. Absent means the workbench has no chat. */
  chat?: ChatRunner;
  /**
   * A ticket's pane has been opened, so a turn about it is coming. Absent for the
   * same reason `warmNameCheck` is: getting ready costs nothing to skip.
   */
  warmChat?: (ticket: Ticket) => void;
  /**
   * The loop, so stopping can reach the runs already going and starting need not
   * wait for the next poll. Absent in a test that only drives the routes, and then
   * stopping is still a stop — it just has nothing in flight to interrupt.
   */
  orchestrator?: Pick<Orchestrator, 'tick' | 'interrupt'>;
  /**
   * Turns what a ticket was written `on` — a branch, `#123`, a pull request's URL —
   * into the branch it means, or says why it cannot be worked on: a fork's branch, a
   * pull request that is no longer open, a branch the remote has not got. Absent in a
   * test that only drives the routes, and then what was given is taken as the branch.
   */
  resolveOn?: (ref: string) => Promise<{ branch: string } | { error: string }>;
};

/**
 * What every write is refused with while the workbench is stopped. One string,
 * because `createClient` throws the server's reason verbatim: whatever the board
 * or the command line was asked to do, this is what it says instead.
 */
export const STOPPED_MESSAGE = 'the workbench is stopped — "wb start" to start it again';

export type Api = {
  /** Returns the port it really got, which is not the one asked for when that is 0. */
  listen: (port: number) => Promise<number>;
  close: () => Promise<void>;
};

/**
 * The single way in. The CLI and the board are both clients of this, so nothing
 * is reachable from one and not the other. It decides nothing: every endpoint
 * either reads derived state or appends one event and lets the rules react.
 */
export function createApi(store: Store, config: Config, deps: ApiDeps = {}): Api {
  const server = http.createServer((req, res) => {
    handle(store, config, deps, req, res).catch((error: unknown) => {
      send(res, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });

  return {
    listen: (port) =>
      new Promise((resolve, reject) => {
        // Starting a second workbench is an ordinary mistake, not a crash. Without
        // this the port being taken reaches Node as an unhandled 'error' event and
        // prints a stack trace from net.js, which says nothing about what to do.
        server.once('error', (error: NodeJS.ErrnoException) => {
          reject(
            error.code === 'EADDRINUSE'
              ? new Error(
                  `a workbench is already running on port ${port}.\n` +
                    'Use it, or stop it first — every other command talks to it over HTTP.',
                )
              : error,
          );
        });

        server.listen(port, '127.0.0.1', () => {
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : port);
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

async function handle(
  store: Store,
  config: Config,
  deps: ApiDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const route = url.pathname.replace(/\/+$/, '') || '/';
  const method = req.method ?? 'GET';
  const ticketPath = /^\/tickets\/([^/]+)(\/[a-z-]+)?$/.exec(route);
  const docPath = /^\/(agents|skills)\/([\w.-]+)$/.exec(route);

  // Who is answering, not merely that something is. `wb serve` asks this of a port
  // it finds taken, to tell a workbench for another repository — ordinary — from a
  // second one for this repository, which would share a database with the first.
  if (method === 'GET' && route === '/health') {
    return send(res, 200, { ok: true, home: config.home });
  }

  if (method === 'GET' && route === '/events') {
    return stream(store, req, res);
  }

  // The whole workbench, stopped and started. Above the refusal below, because the
  // second press of stop is the one that interrupts what is still going, and the
  // refusal would otherwise turn it away along with every other write.
  if (route === '/stop') {
    const running = () =>
      store
        .tickets()
        .filter((t) => t.running)
        .map((t) => t.id);

    if (method === 'GET') return send(res, 200, { stopped: store.stopped(), running: running() });
    if (method === 'POST') {
      // The polite press: nothing new starts, and what is in flight is left to
      // finish. Pressed again while already stopped it is not polite any more —
      // the manager is not waiting for those stages after all.
      if (!store.stopped()) {
        store.setStopped(true);
        return send(res, 200, { stopped: true, running: running(), interrupted: [] });
      }
      const interrupted = deps.orchestrator?.interrupt() ?? [];
      return send(res, 200, { stopped: true, running: running(), interrupted });
    }
  }

  if (method === 'POST' && route === '/start') {
    store.setStopped(false);
    // At once, rather than whenever the next poll comes round.
    void deps.orchestrator?.tick();
    return send(res, 200, { stopped: false });
  }

  // Stopped means stopped: nothing about the board changes until it is started
  // again, whether the change is asked for here or from the command line. Reads are
  // left open, because the board still has to render and offer the way back.
  if (store.stopped() && method !== 'GET') {
    return send(res, 409, { error: STOPPED_MESSAGE });
  }

  if (route === '/policy') {
    if (method === 'GET') return send(res, 200, store.policy());
    if (method === 'PUT') {
      const patch = await readJson(req);
      return refusable(res, () => store.setPolicy(patch));
    }
  }

  // Everything the Analytics tab shows. Read out of the whole log every time it is
  // asked for, and no store method and no table for it: the durations and the
  // per-stage costs are only in the events, and a board is thousands of rows. If
  // that ever gets slow, cache it here — not before, and the same way tickets would.
  if (method === 'GET' && route === '/analytics') {
    const events = store.ticketIds().flatMap((id) => store.eventsFor(id));
    return send(res, 200, analyse(store.tickets(), events));
  }

  // How the workbench works, rather than what it is working on: the settings, and
  // the two kinds of writing every stage is briefed from. All of it is on disk or
  // in the database already — these routes only put it behind the same door.
  if (route === '/settings') {
    if (method === 'GET') return send(res, 200, { settings: settings(store, config) });
    if (method === 'PUT') {
      const patch = await readJson(req);
      return refusable(res, () => ({ settings: applySettings(store, config, patch) }));
    }
  }

  // What this ticket might better be called, asked while it is being typed. It
  // creates nothing and refuses nothing: `{name: null}` is the ordinary answer,
  // and the one given when there is nobody to ask.
  if (method === 'POST' && route === '/name-check') {
    const { title, body } = await readJson(req);
    const name = typeof title === 'string' ? title.trim() : '';
    const suggestion =
      name === '' || deps.checkName === undefined
        ? null
        : await deps.checkName(name, String(body ?? ''));
    return send(res, 200, suggestion ?? { name: null });
  }

  // The ticket form saying it is open. Almost all of what a name check costs is
  // starting something to ask, and that can be started now rather than when the
  // question arrives — so the answer lands while the form is still there to show it.
  if (method === 'POST' && route === '/name-check/warm') {
    deps.warmNameCheck?.();
    return send(res, 200, { ok: true });
  }

  if (method === 'GET' && (route === '/agents' || route === '/skills')) {
    return send(res, 200, { docs: listDocs(config, kindOf(route)) });
  }

  if (method === 'PUT' && docPath) {
    const { text } = await readJson(req);
    if (typeof text !== 'string') return send(res, 400, { error: 'nothing to save' });
    const kind = kindOf(docPath[1] as string);
    const name = docPath[2] as string;
    return refusable(res, () => ({ doc: writeDoc(config, kind, name, text) }));
  }

  // Adding and removing is skills only, and `createDoc` is what says so — the route
  // exists for both kinds so that asking for an agent is answered with the reason
  // rather than with a 404 that reads like a missing feature.
  if (method === 'POST' && (route === '/agents' || route === '/skills')) {
    const { name, text } = await readJson(req);
    const kind = kindOf(route);
    return refusable(res, () => ({
      doc: createDoc(config, kind, String(name ?? ''), typeof text === 'string' ? text : undefined),
    }));
  }

  if (method === 'DELETE' && docPath) {
    const kind = kindOf(docPath[1] as string);
    const name = docPath[2] as string;
    return refusable(res, () => {
      deleteDoc(config, kind, name);
      return { deleted: name };
    });
  }

  if (route === '/tickets') {
    if (method === 'GET') return send(res, 200, { tickets: store.tickets() });
    if (method === 'POST') {
      const {
        title,
        body,
        from,
        on: onRef,
        requiresApproval,
        waitsFor: after,
      } = await readJson(req);
      if (typeof title !== 'string' || title.trim() === '') {
        return send(res, 400, { error: 'a ticket needs a title' });
      }

      // Carrying on from another ticket means starting on its branch, so there
      // has to be one, with something on it. Refused here rather than failing
      // later in git, where the reason would be someone else's error message.
      const continues = from === undefined || from === null ? undefined : String(from);
      if (continues !== undefined) {
        if (!store.ticketIds().includes(continues)) {
          return send(res, 400, { error: `no ticket ${continues} to continue` });
        }
        if (store.ticket(continues).commits.length === 0) {
          return send(res, 400, { error: `${continues} left no work to continue` });
        }
      }

      // What it starts after, said when the ticket is written — which is the
      // moment you know it. Checked before anything is created, so a typo does
      // not leave a ticket behind that says nothing about what it waits for.
      const waitsFor = (Array.isArray(after) ? after : [])
        .map((one) => String(one).trim())
        .filter((one) => one !== '');
      for (const other of waitsFor) {
        if (!store.ticketIds().includes(other)) {
          return send(res, 400, { error: `no ticket ${other} to wait for` });
        }
      }

      // Working on somebody else's branch, and pushing back to it. Resolved and
      // checked here, like `continues`, rather than failing later in git — and last,
      // because it is the one check that asks the network.
      let on: string | undefined;
      const onSaid = onRef === undefined || onRef === null ? '' : String(onRef).trim();
      if (onSaid !== '') {
        if (continues !== undefined) {
          return send(res, 400, {
            error: 'a ticket starts from another ticket’s work or on a branch, not both',
          });
        }
        const resolved =
          deps.resolveOn === undefined ? { branch: onSaid } : await deps.resolveOn(onSaid);
        if ('error' in resolved) return send(res, 400, { error: resolved.error });
        // Whatever resolved it, what is recorded is fetched, cut from and pushed to by
        // name for the rest of the ticket's life, so it has to be a branch's name and
        // not something git would read as an option. `resolveOn` asks the same before
        // its own git runs; this is the gate for everything after.
        if (!(await isBranchName(resolved.branch))) {
          return send(res, 400, { error: `${resolved.branch} is not a branch name` });
        }
        on = resolved.branch;
      }

      const id = nextId(store);
      store.append(id, {
        type: 'ticket_created',
        title,
        body: String(body ?? ''),
        continues,
        ...(on === undefined ? {} : { on }),
        // Recorded only when the gate is being skipped. Anything else — true, or
        // nothing said — is the default, and writing it down would say nothing.
        ...(requiresApproval === false ? { requiresApproval: false } : {}),
      });
      // Its own event rather than a field of the creation, so there is one way a
      // ticket comes to wait for something whenever it is said. A new ticket
      // cannot close a ring, so there is nothing here for `cannotWaitFor` to do.
      if (waitsFor.length > 0) {
        store.append(id, { type: 'waits_for', tickets: [...new Set(waitsFor)] });
      }
      return send(res, 201, { ticket: store.ticket(id) });
    }
  }

  if (ticketPath) {
    const id = ticketPath[1] as string;
    const action = ticketPath[2]?.slice(1);

    if (!store.ticketIds().includes(id)) {
      return send(res, 404, { error: `no ticket ${id}` });
    }

    if (method === 'GET' && action === undefined) {
      return send(res, 200, { ticket: store.ticket(id), events: store.eventsFor(id) });
    }

    if (method === 'POST') {
      const payload = await readJson(req);
      switch (action) {
        case 'edit': {
          const title = 'title' in payload ? String(payload['title']).trim() : undefined;
          const body = 'body' in payload ? String(payload['body']) : undefined;
          // A plain yes or no, or nothing: anything else is left alone rather
          // than read as one of them.
          const gate = payload['requiresApproval'];
          const requiresApproval = typeof gate === 'boolean' ? gate : undefined;
          if (title === '') return send(res, 400, { error: 'a ticket needs a title' });
          if (title === undefined && body === undefined && requiresApproval === undefined) {
            return send(res, 400, { error: 'nothing to change' });
          }
          store.append(id, { type: 'ticket_edited', title, body, requiresApproval });
          return send(res, 200, { ticket: store.ticket(id) });
        }
        case 'queue':
          store.append(id, { type: 'queued' });
          return send(res, 200, { ticket: store.ticket(id) });
        case 'backlog':
          store.append(id, { type: 'backlogged' });
          return send(res, 200, { ticket: store.ticket(id) });
        case 'move': {
          // Absent and null both mean the end of the board, so "move it last" is
          // an empty body rather than a special word.
          const raw = payload['before'];
          const before = raw === undefined || raw === null ? null : String(raw);
          if (before === id) return send(res, 400, { error: 'a ticket cannot go before itself' });
          if (before !== null && !store.ticketIds().includes(before)) {
            return send(res, 400, { error: `no ticket ${before} to go before` });
          }
          store.append(id, { type: 'moved', before });
          return send(res, 200, { tickets: store.tickets() });
        }
        case 'wait': {
          // The whole set each time, so taking the last one off is an empty list
          // rather than a special word.
          const raw = payload['tickets'];
          const tickets = (Array.isArray(raw) ? raw : [])
            .map((one) => String(one).trim())
            .filter((one) => one !== '');

          for (const other of tickets) {
            const problem = cannotWaitFor(store, id, other);
            if (problem !== undefined) return send(res, 400, { error: problem });
          }

          store.append(id, { type: 'waits_for', tickets: [...new Set(tickets)] });
          return send(res, 200, { ticket: store.ticket(id) });
        }
        case 'ship':
          store.append(id, { type: 'shipped' });
          return send(res, 200, { ticket: store.ticket(id) });
        case 'merge': {
          // Nothing to merge unless an offer is actually standing. A ticket being
          // reworked keeps its `prUrl`, so that alone would let the work in flight
          // be merged halfway through.
          const ticket = store.ticket(id);
          if (!ticket.offered || ticket.prUrl === null) {
            return send(res, 400, { error: 'there is no pull request to merge' });
          }
          // Any `method` a client sends is ignored rather than refused: there is one
          // way to land work now, and an older client asking for the one that is gone
          // means the merge it can have.
          store.append(id, { type: 'merge_requested' });
          return send(res, 200, { ticket: store.ticket(id) });
        }
        case 'restart':
          store.append(id, { type: 'stage_restarted' });
          return send(res, 200, { ticket: store.ticket(id) });
        // The other half of restarting: same stage, keeping its conversation.
        // Only for a ticket that was stopped mid-run, though — a ticket blocked on
        // a question is parked in the same place with no run to carry on, and
        // appending this to it would throw the question away for nothing.
        case 'continue': {
          const t = store.ticket(id);
          if (!t.interrupted) {
            return send(res, 400, {
              error: t.question
                ? `${id} is waiting on an answer, not on being picked up — answer it instead`
                : `${id} was not stopped mid-stage — there is no run to carry on, so restart it`,
            });
          }
          store.append(id, { type: 'stage_continued' });
          return send(res, 200, { ticket: store.ticket(id) });
        }
        case 'approve':
          store.append(id, { type: 'plan_approved' });
          return send(res, 200, { ticket: store.ticket(id) });
        case 'reject': {
          const reason = String(payload['reason'] ?? '').trim();
          if (reason === '') return send(res, 400, { error: 'say why, so the next plan knows' });
          store.append(id, { type: 'plan_rejected', reason });
          return send(res, 200, { ticket: store.ticket(id) });
        }
        case 'changes': {
          const changes = String(payload['changes'] ?? '').trim();
          if (changes === '') return send(res, 400, { error: 'say what to put right' });
          const ticket = store.ticket(id);
          // A ticket that has ended is not being worked on any more, and this is
          // the one route that would start it again — pressed on a merged ticket,
          // it would drop finished work back into implement.
          if (ended(ticket)) {
            return send(res, 400, { error: 'this ticket is over — there is nothing to put right' });
          }
          // Nothing to put right before there is a plan, and no plan means the
          // stage this sends the ticket to has nothing to work from.
          if (ticket.plan === null) {
            return send(res, 400, { error: 'nothing has been planned yet — send it back instead' });
          }
          store.append(id, { type: 'changes_requested', changes });
          return send(res, 200, { ticket: store.ticket(id) });
        }
        case 'answer': {
          const answer = String(payload['answer'] ?? '').trim();
          if (answer === '') return send(res, 400, { error: 'an answer is needed' });
          store.append(id, { type: 'question_answered', answer });
          return send(res, 200, { ticket: store.ticket(id) });
        }
        case 'cancel': {
          const reason = String(payload['reason'] ?? '').trim() || 'no reason given';
          store.append(id, { type: 'cancelled', reason });
          return send(res, 200, { ticket: store.ticket(id) });
        }

        /**
         * One turn of the conversation about this ticket: what the manager said,
         * then what the agent answered, both appended as events. The manager's turn
         * is written before the agent runs, so a run that fails still leaves what was
         * said — losing it would mean retyping the thought as well as the request.
         */
        case 'chat': {
          if (deps.chat === undefined) {
            return send(res, 503, { error: 'this workbench has no chat agent wired into it' });
          }
          const message = String(payload['message'] ?? '').trim();
          if (message === '') return send(res, 400, { error: 'say something first' });

          const { session } = chatTurns(store.eventsFor(id));
          store.append(id, { type: 'chat_said', role: 'manager', text: message });

          // The manager closing the panel mid-turn stops the run rather than paying
          // for an answer nobody is waiting for. Harmless once the reply has been sent.
          const stop = new AbortController();
          res.on('close', () => stop.abort());

          let reply;
          try {
            reply = await deps.chat({
              ticket: store.ticket(id),
              events: store.eventsFor(id),
              message,
              ...(session === null ? {} : { resumeFrom: session }),
              signal: stop.signal,
            });
          } catch (error: unknown) {
            return send(res, 502, {
              error: error instanceof Error ? error.message : String(error),
            });
          }

          store.append(id, {
            type: 'chat_said',
            role: 'agent',
            text: reply.text,
            // Written only when there is something to say. A turn that proposed
            // nothing and cost nothing should read as one, not as empty fields.
            ...(reply.proposals.length > 0 ? { proposals: reply.proposals } : {}),
            ...(reply.costUsd > 0 ? { costUsd: reply.costUsd } : {}),
            ...(reply.sessionId === undefined ? {} : { sessionId: reply.sessionId }),
          });
          return send(res, 200, { chat: chatTurns(store.eventsFor(id)) });
        }

        /**
         * The pane on this ticket is open, so a turn about it is coming. Almost all
         * of what a turn used to cost was starting something to answer it, and that
         * can be started now instead — so the first thing the manager says is
         * answered as quickly as the second.
         */
        case 'chat-warm': {
          deps.warmChat?.(store.ticket(id));
          return send(res, 200, { ok: true });
        }

        /**
         * The manager took a proposal up. It appends exactly the event the equivalent
         * button appends and is refused by exactly the same rules — the chat is a way
         * of reaching those actions, never a way around them.
         */
        case 'chat-accept': {
          // A number, and nothing that merely looks like one: `Number(null)`,
          // `Number('')` and `Number([])` are all 0, so a request naming no
          // proposal at all used to take up the first one.
          const at = payload['at'];
          // The list the pane offered from, so the position it sends back and the
          // fate of what is at that position are read the same way at both ends.
          const offered =
            typeof at === 'number' && Number.isInteger(at)
              ? chatTurns(store.eventsFor(id)).turns.flatMap((t) => t.proposals)[at]
              : undefined;
          if (offered === undefined) {
            return send(res, 400, { error: `${id} has no proposal ${String(at)}` });
          }
          if (offered.accepted) {
            return send(res, 400, { error: 'that proposal has already been accepted' });
          }

          const { at: _at, accepted: _accepted, ...proposal } = offered;
          const taken = proposalEvent(store.ticket(id), proposal);
          if ('refused' in taken) return send(res, 400, { error: taken.refused });

          // Nothing is awaited between reading `accepted` above and these appends,
          // so two accepts arriving together run one after the other rather than
          // interleaving — the second reads the first's `chat_accepted` and stops.
          store.append(id, taken.event);
          store.append(id, { type: 'chat_accepted', proposal });
          return send(res, 200, { ticket: store.ticket(id) });
        }
      }
    }
  }

  // Anything left that could be a page is the board itself. The API's routes are
  // all above, so nothing here can shadow one.
  if (method === 'GET') return serveBoard(res, route);

  send(res, 404, { error: `no route for ${method} ${route}` });
}

/**
 * The built board, straight off disk. It is a single page with everything in the
 * fragment, so there is no routing to do — a request either names a built file or
 * it names nothing.
 */
async function serveBoard(res: http.ServerResponse, route: string): Promise<void> {
  const file = path.resolve(UI_DIST, route === '/' ? 'index.html' : route.slice(1));
  if (file !== UI_DIST && !file.startsWith(UI_DIST + path.sep)) {
    return send(res, 403, { error: 'outside the board' });
  }

  let body: Buffer;
  try {
    body = await fs.readFile(file);
  } catch {
    if (route !== '/') return send(res, 404, { error: `nothing at ${route}` });
    // Not built is the ordinary state of a fresh clone, and a 404 here reads as a
    // broken workbench rather than as one missing step.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      '<!doctype html><meta charset="utf-8"><title>Workbench</title>' +
        '<body style="font:15px/1.6 system-ui;padding:3rem;max-width:34rem">' +
        '<h1>The board is not built yet</h1>' +
        '<p>Build it once, from <code>workbench/</code>:</p>' +
        '<pre><code>npm run build</code></pre>' +
        '<p>Then reload. To work on the board itself, <code>npm run ui</code> serves it ' +
        'with reloading, and talks to this workbench.</p>',
    );
    return;
  }

  res.writeHead(200, {
    'content-type': CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream',
    // The page names its assets by content hash, so they can be cached for ever
    // and the page itself never can: cache it and a rebuilt board keeps serving
    // the old one, which looks exactly like a change that did not work.
    'cache-control': route === '/' ? 'no-store' : 'public, max-age=31536000, immutable',
  });
  res.end(body);
}

/** Server-sent events, so the board reflects state without polling. */
function stream(store: Store, req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });
  res.write(': connected\n\n');

  const unsubscribe = store.subscribe((event: Event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  });

  req.on('close', unsubscribe);
}

/**
 * Something the caller can be wrong about. What the settings and the two kinds of
 * document refuse — a limit below one, an agent file missing a field — is a thing
 * the person typing it can put right, so it comes back as a complaint about their
 * value rather than as a 500 about the workbench.
 */
function refusable(res: http.ServerResponse, work: () => unknown): void {
  try {
    send(res, 200, work());
  } catch (error: unknown) {
    send(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}

/** `/agents` and `/skills` are the routes; `agent` and `skill` are the things. */
function kindOf(route: string): DocKind {
  return route.includes('agent') ? 'agent' : 'skill';
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(json);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new Error('the request body was not valid JSON');
  }
}

/**
 * Why `id` may not wait for `other`, if it may not. A ring of tickets waiting on
 * each other would never start and nothing downstream would say why, so it is
 * refused here — the one place that can see the whole chain before it exists.
 */
function cannotWaitFor(store: Store, id: string, other: string): string | undefined {
  if (other === id) return 'a ticket cannot wait for itself';
  if (!store.ticketIds().includes(other)) return `no ticket ${other} to wait for`;

  // Everything `other` is already waiting on, however far back. Reaching `id`
  // means the new condition would close a ring.
  const seen = new Set<string>();
  const toVisit = [other];
  while (toVisit.length > 0) {
    const at = toVisit.pop() as string;
    if (seen.has(at)) continue;
    seen.add(at);
    if (at === id) return `${other} already waits for ${id}, and they would hold each other up`;
    toVisit.push(...store.ticket(at).waitsFor);
  }
  return undefined;
}

/** Short, human ids: t1, t2, ... */
function nextId(store: Store): string {
  const used = store.ticketIds().map((id) => Number(id.replace(/^t/, '')));
  return `t${Math.max(0, ...used.filter(Number.isFinite)) + 1}`;
}
