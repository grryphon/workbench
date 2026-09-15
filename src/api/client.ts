import type { Event } from '../domain/events.ts';
import type { Analytics } from '../domain/analytics.ts';
import type { Chat } from '../domain/board.ts';
import type { Ticket } from '../domain/ticket.ts';
import type { Policy } from '../domain/rules.ts';
import type { Doc, DocKind } from './documents.ts';
import type { Setting } from './settings.ts';

/**
 * The reply as an object, or null if it was not one. Null is the honest answer for
 * a body that did not parse *and* for one that parsed to something else — `null`
 * and `"ok"` are both valid JSON and neither is a reply this API ever sends.
 */
function asObject(text: string): Record<string, unknown> | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

/** The CLI and the board both reach the workbench through this. Nothing else does. */
export function createClient(baseUrl: string) {
  async function call<T>(path: string, init?: RequestInit): Promise<T> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { 'content-type': 'application/json', ...init?.headers },
      });
    } catch {
      throw new Error(`no workbench at ${baseUrl} — start one with: wb serve`);
    }

    const body = asObject(await response.text());

    // A reply that failed is allowed to carry no JSON. The workbench always sends
    // a reason, but a proxy in front of it or a crash underneath it writes
    // whatever it likes, and the status is still worth reporting.
    if (!response.ok) throw new Error(String(body?.['error'] ?? `HTTP ${response.status}`));

    // A reply that succeeded is not. Every route answers with a JSON object, so
    // anything else means whatever is on that port is not the workbench — which
    // has to be said rather than read as an answer with every field missing.
    if (body === null) {
      const kind = response.headers.get('content-type')?.split(';')[0] ?? 'nothing';
      throw new Error(`${baseUrl}${path} answered with ${kind}, not JSON — is that a workbench?`);
    }

    return body as T;
  }

  const post = <T>(path: string, body?: unknown): Promise<T> =>
    call<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });

  return {
    tickets: () => call<{ tickets: Ticket[] }>('/tickets').then((r) => r.tickets),

    ticket: (id: string) => call<{ ticket: Ticket; events: Event[] }>(`/tickets/${id}`),

    /**
     * `from` starts the ticket on another ticket's branch, carrying on its work.
     * `on` works on a branch the workbench does not own — a name, `#123` or a pull
     * request's URL — and pushes the result back to it.
     * `requiresApproval: false` lets the plan go straight on to being built.
     * `waitsFor` holds it until those tickets have offered their work or ended.
     */
    create: (
      title: string,
      body: string,
      how: { from?: string; on?: string; requiresApproval?: boolean; waitsFor?: string[] } = {},
    ) => post<{ ticket: Ticket }>('/tickets', { title, body, ...how }).then((r) => r.ticket),

    /**
     * Whichever field is given replaces what was there; the rest are left alone.
     * `requiresApproval` is read when the next plan finishes, so it says something
     * only while one is still ahead.
     */
    edit: (id: string, changes: { title?: string; body?: string; requiresApproval?: boolean }) =>
      post<{ ticket: Ticket }>(`/tickets/${id}/edit`, changes).then((r) => r.ticket),

    queue: (id: string) => post<unknown>(`/tickets/${id}/queue`),
    backlog: (id: string) => post<unknown>(`/tickets/${id}/backlog`),

    /** Put it in front of `before` in the board's order, or last when null. */
    move: (id: string, before: string | null) =>
      post<{ tickets: Ticket[] }>(`/tickets/${id}/move`, { before }).then((r) => r.tickets),
    /**
     * Hold it until every one of `tickets` offers its work or ends. The whole set,
     * not a difference — an empty list is what lets it go.
     */
    wait: (id: string, tickets: string[]) =>
      post<{ ticket: Ticket }>(`/tickets/${id}/wait`, { tickets }).then((r) => r.ticket),

    approve: (id: string) => post<unknown>(`/tickets/${id}/approve`),
    /** Send it back to be planned again. The expensive no; the reason goes to the plan. */
    reject: (id: string, reason: string) => post<unknown>(`/tickets/${id}/reject`, { reason }),
    /** Keep the work and put these right. The cheap no; it goes back to implement. */
    changes: (id: string, changes: string) =>
      post<{ ticket: Ticket }>(`/tickets/${id}/changes`, { changes }).then((r) => r.ticket),
    answer: (id: string, answer: string) => post<unknown>(`/tickets/${id}/answer`, { answer }),
    /** Run the stage again from the top. For one that failed, not one that asked. */
    restart: (id: string) => post<unknown>(`/tickets/${id}/restart`),
    /**
     * Run the stage again from where it got to, keeping its conversation. For one
     * the workbench was stopped in the middle of — which is not the same as one
     * that broke, and is not worth paying for twice.
     */
    carryOn: (id: string) => post<unknown>(`/tickets/${id}/continue`),
    /** Offer what it has as a pull request, whatever the agents made of it. */
    ship: (id: string) => post<unknown>(`/tickets/${id}/ship`),
    /**
     * Merge the offered work onto the base, as a merge commit. The orchestrator
     * does it, and accepts it.
     */
    merge: (id: string) => post<{ ticket: Ticket }>(`/tickets/${id}/merge`).then((r) => r.ticket),
    cancel: (id: string, reason: string) => post<unknown>(`/tickets/${id}/cancel`, { reason }),

    /**
     * Say something to the ticket's chat, and wait for the answer. The whole
     * conversation comes back, because a turn is only worth reading in one.
     */
    chat: (id: string, message: string) =>
      post<{ chat: Chat }>(`/tickets/${id}/chat`, { message }).then((r) => r.chat),
    /**
     * This ticket's pane is open, so whatever will answer the first turn can get
     * ready now. Nothing comes back but the acknowledgement: this is the wait,
     * moved to where the manager is not yet waiting.
     */
    warmChat: (id: string) => post<{ ok: true }>(`/tickets/${id}/chat-warm`),
    /** Take a proposal up. `at` is its place in the conversation, as the chat gives it. */
    acceptProposal: (id: string, at: number) =>
      post<{ ticket: Ticket }>(`/tickets/${id}/chat-accept`, { at }).then((r) => r.ticket),

    /** Whether the whole workbench is stopped, and what is still running. */
    stopped: () => call<{ stopped: boolean; running: string[] }>('/stop'),
    /**
     * Stop everything. Nothing new starts, and what is in flight is left to finish
     * — unless it is already stopped, in which case this is the second press and
     * those runs are stopped too, and named in `interrupted`.
     */
    stop: () => post<{ stopped: true; running: string[]; interrupted: string[] }>('/stop'),
    /** Start it again. The only write the workbench accepts while stopped. */
    start: () => post<{ stopped: false }>('/start'),

    /** Every number the Analytics tab draws, worked out from the whole event log. */
    analytics: () => call<Analytics>('/analytics'),

    policy: () => call<Policy>('/policy'),
    /** Change some of the limits, leaving the rest. Takes effect at once. */
    setPolicy: (patch: Partial<Policy>) =>
      call<Policy>('/policy', { method: 'PUT', body: JSON.stringify(patch) }),

    /** Every agent file, or every skill file, with its text. */
    docs: (kind: DocKind) => call<{ docs: Doc[] }>(`/${kind}s`).then((r) => r.docs),
    /** Save one, having checked it still loads. Refused, with the reason, if it does not. */
    saveDoc: (kind: DocKind, name: string, text: string) =>
      call<{ doc: Doc }>(`/${kind}s/${name}`, {
        method: 'PUT',
        body: JSON.stringify({ text }),
      }).then((r) => r.doc),

    /**
     * Make one, starting from a file that loads if no text is given. Skills only —
     * the four stages are fixed, so an agent is refused with that as the reason.
     */
    createDoc: (kind: DocKind, name: string, text?: string) =>
      post<{ doc: Doc }>(`/${kind}s`, { name, ...(text === undefined ? {} : { text }) }).then(
        (r) => r.doc,
      ),
    /** Remove it, directory and all. Skills only, and there is no undoing it. */
    deleteDoc: (kind: DocKind, name: string) =>
      call<{ deleted: string }>(`/${kind}s/${name}`, { method: 'DELETE' }).then((r) => r.deleted),

    /**
     * What this ticket might better be called, while it is being written. `name`
     * is null when the name given is fine, or when there was nobody to ask.
     */
    checkName: (title: string, body: string) =>
      post<{ name: string | null; why?: string }>('/name-check', { title, body }),

    /**
     * A name is about to be asked about, so whatever answers it can get ready now.
     * Nothing comes back but the acknowledgement: this is the wait, moved earlier.
     */
    warmNameCheck: () => post<{ ok: true }>('/name-check/warm'),

    /** Everything the workbench is set to, editable and not. */
    settings: () => call<{ settings: Setting[] }>('/settings').then((r) => r.settings),
    setSettings: (patch: Record<string, unknown>) =>
      call<{ settings: Setting[] }>('/settings', {
        method: 'PUT',
        body: JSON.stringify(patch),
      }).then((r) => r.settings),
  };
}

export type Client = ReturnType<typeof createClient>;
