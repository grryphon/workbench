import { useCallback, useEffect, useState, type ReactNode } from 'react';

import type { Doc, DocKind } from '../../src/api/documents.ts';
import {
  COLUMNS,
  columnFor,
  DONE,
  inColumn,
  keepsBoardOrder,
  kindsInDone,
  needsYou,
  sortedDone,
  waitingForSlot,
  type DoneView,
} from '../../src/domain/board.ts';
import { heldBy, waitingOutLimit, type Policy } from '../../src/domain/rules.ts';
import { ended, type Ticket } from '../../src/domain/ticket.ts';
import { Analytics } from './Analytics.tsx';
import { applyBrand, isColour } from './brand.ts';
import { Card } from './Card.tsx';
import { Detail } from './Detail.tsx';
import { Docs } from './Docs.tsx';
import { Interrupted } from './Interrupted.tsx';
import { SORTS, useDoneView } from './order.ts';
import { Settings } from './Settings.tsx';
import { Theme } from './Theme.tsx';
import { TicketForm } from './TicketForm.tsx';
import { describe, wb } from './wb.ts';

/** The two columns you move a card between by hand. Everywhere else it moves itself. */
const BACKLOG = 'Backlog';
const COMMITTED = 'Committed';

/**
 * What the address says while a ticket is being written rather than read. On its
 * own for a fresh one; `new:t13` for one carrying on from t13, which is the only
 * way `continues` gets set — a ticket's branch is cut when it is created, so there
 * is no later moment to say it in.
 */
const NEW = 'new';

/** The ticket a new one carries on from, when the address says so. */
function continuing(selected: string | null): string | null {
  return selected !== null && selected.startsWith(`${NEW}:`)
    ? selected.slice(NEW.length + 1)
    : null;
}

/**
 * The five pages. The board is the workbench working and Analytics is what that
 * working has come to; the other three are the workbench itself — what each stage
 * is told, what expertise it is handed, and what it all runs under. They were only
 * ever files on disk and a database, so changing any of them meant leaving the board.
 *
 * The address holds the page, so one can be linked to and survives a reload —
 * the same way a ticket does. Anything else in it is a ticket, which is why the
 * board is what an unrecognised address falls back to.
 */
const TABS = ['Board', 'Agents', 'Skills', 'Analytics', 'Settings'] as const;

type Tab = (typeof TABS)[number];

function tabInHash(hash: string): Tab {
  return TABS.find((tab) => tab.toLowerCase() === hash) ?? 'Board';
}

/** The sorts Done offers, as the control names them. Newest is where it starts. */
const SORT_LABELS: Record<DoneView['sort'], string> = {
  newest: 'Newest',
  oldest: 'Oldest',
  cost: 'Dearest',
  title: 'Title',
  outcome: 'Outcome',
};

/**
 * The fates a finished ticket can have, as the filter names them. Not every
 * `Outcome`: a ticket that has not ended is not in this column to be filtered for.
 */
const OUTCOMES: readonly [DoneView['outcome'], string][] = [
  ['all', 'Any outcome'],
  ['accepted', 'Merged'],
  ['cancelled', 'Cancelled'],
  ['gave_up', 'Given up on'],
];

/** Which column a ticket may be dragged into, if any. */
function dropTarget(t: Ticket): string | null {
  if (t.status === 'backlog') return COMMITTED;
  if (t.status === 'queued') return BACKLOG;
  return null;
}

export function App() {
  const [tickets, setTickets] = useState<Ticket[]>([]);
  // The whole policy, not only the limit it prints: the same limits decide which
  // cards are waiting on a slot, and asking the rule needs all of them.
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [version, setVersion] = useState(0);
  const [at, setAt] = useState(idInHash);
  const [dragging, setDragging] = useState<Ticket | null>(null);
  // The agent and skill files, held here rather than in the page that shows them:
  // the tabs count them, so they are wanted whichever page you are on.
  const [docs, setDocs] = useState<Record<DocKind, Doc[]> | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The repository this board is working in. A fact of the running process, so it
  // never changes — but it comes from the settings, which is also where the colour
  // of this instance is, and that does.
  const [repo, setRepo] = useState<string | null>(null);
  // Whether the modal listing what was stopped mid-stage has been answered. Held
  // for this page load and nowhere else: the tickets stay parked until somebody
  // says what to do with them, so it asks again next time.
  const [decided, setDecided] = useState(false);
  // What the ticket form offers in front of a title. From the settings, so it is
  // read where they are and handed to both forms that write a title.
  const [prefixes, setPrefixes] = useState<string[]>([]);
  // Bumped when the settings page saves, so what was read out of the settings is
  // read again — and only then, rather than on every event.
  const [settingsVersion, setSettingsVersion] = useState(0);
  // How Done is read: sorted, and cut down to a subset. The browser's choice, not
  // the workbench's.
  const [doneView, chooseDone] = useDoneView();
  // Whether the whole board is stopped, and what is still running in spite of it.
  const [stopped, setStopped] = useState<{ stopped: boolean; running: string[] } | null>(null);

  /** Anything appended redraws the board. No polling, and no refresh button. */
  useEffect(() => {
    const events = new EventSource('/events');
    events.onmessage = () => setVersion((v) => v + 1);
    return () => events.close();
  }, []);

  useEffect(() => {
    let live = true;
    Promise.all([wb.tickets(), wb.policy(), wb.stopped()])
      .then(([ts, p, s]) => {
        if (!live) return;
        setTickets(ts);
        setPolicy(p);
        setStopped(s);
        setError(null);
      })
      .catch((e: unknown) => live && setError(describe(e)));
    return () => {
      live = false;
    };
  }, [version]);

  // Read once. Nothing appends an event when one is saved, so there is nothing for
  // the event stream to redraw off — the page that saves one says what it became.
  useEffect(() => {
    let live = true;
    Promise.all([wb.docs('agent'), wb.docs('skill')])
      .then(([agent, skill]) => live && setDocs({ agent, skill }))
      .catch((e: unknown) => live && setError(describe(e)));
    return () => {
      live = false;
    };
  }, []);

  // Which repository this is, and what colour it was given. Two boards on two ports
  // are otherwise identical down to the pixel, and the answer to "which one is this"
  // should not be a page away. Read once: the settings page is the only thing that
  // changes a colour, and it puts its own — draft or saved — on the header while it
  // is open. Reading again on every event would overwrite an unsaved draft with the
  // saved colour each time a running ticket said anything.
  useEffect(() => {
    let live = true;
    wb.settings()
      .then((all) => {
        if (!live) return;
        const found = all.find((s) => s.key === 'repoRoot')?.value;
        if (typeof found === 'string') setRepo(found);
        const colour = all.find((s) => s.key === 'colour')?.value;
        applyBrand(isColour(colour) ? colour : null);
        const offered = all.find((s) => s.key === 'ticketPrefixes')?.value;
        if (Array.isArray(offered)) setPrefixes(offered);
      })
      .catch((e: unknown) => live && setError(describe(e)));
    return () => {
      live = false;
    };
  }, [settingsVersion]);

  // The tab as well as the header: a window you are looking for is usually one you
  // cannot see, and its title is all the switcher shows of it. Abbreviated to "WB"
  // because a narrow tab truncates from the end — so the part every board shares
  // has to be the short one, leaving the folder that tells them apart.
  useEffect(() => {
    document.title = repo === null ? 'WB' : `WB: ${folder(repo)}`;
  }, [repo]);

  // The page, and the ticket on it, are both in the address — so a card can be
  // linked to and survives a reload, which is what "link to ticket" asks for.
  useEffect(() => {
    const onHash = () => setAt(idInHash());
    addEventListener('hashchange', onHash);
    return () => removeEventListener('hashchange', onHash);
  }, []);

  const act = useCallback(async (work: Promise<unknown>) => {
    try {
      await work;
      setError(null);
    } catch (e: unknown) {
      setError(describe(e));
    }
  }, []);

  /**
   * Something about the whole board rather than about a ticket. Nothing is appended
   * when the board is stopped or started, so there is no event to redraw off: the
   * press asks for the read again itself.
   */
  const control = useCallback(
    (work: Promise<unknown>) => act(work.then(() => setVersion((v) => v + 1))),
    [act],
  );

  const move = useCallback(
    (t: Ticket, column: string) => {
      // Dropping ends the drag here rather than waiting for `dragend`: the card is
      // about to be re-rendered into another column, and a source element that
      // disappears mid-drag never sends one — leaving the board lit up for ever.
      setDragging(null);
      // Dropped back where it came from: the column is the board behind the cards,
      // so that means the end of it rather than a move between columns.
      if (columnFor(t) === column) return void act(wb.move(t.id, null));
      if (dropTarget(t) !== column) return;
      void act(column === COMMITTED ? wb.queue(t.id) : wb.backlog(t.id));
    },
    [act],
  );

  /** Dropped on a card: the dragged one goes in front of it, in the board's order. */
  const reorder = useCallback(
    (t: Ticket, before: Ticket) => {
      setDragging(null);
      if (t.id !== before.id) void act(wb.move(t.id, before.id));
    },
    [act],
  );

  const tab = tabInHash(at ?? '');
  // Everything in the address that is not one of the five pages is a ticket.
  const selected = tab === 'Board' ? at : null;
  const waiting = tickets.filter(needsYou).length;

  /**
   * How much is on each page, on its own tab. The board counts what has not ended
   * — a finished ticket is still on it, and counting those would climb for ever
   * and say nothing. Settings and Analytics have no count: one page each, always
   * the same size.
   */
  const counts: Record<Tab, number | null> = {
    Board: tickets.filter((t) => !ended(t)).length,
    Agents: docs?.agent?.length ?? null,
    Skills: docs?.skill?.length ?? null,
    Analytics: null,
    Settings: null,
  };

  /** What one page saved, kept where the count is read from. */
  const saved = (kind: DocKind) => (doc: Doc) =>
    setDocs((held) =>
      held === null
        ? held
        : { ...held, [kind]: held[kind].map((d) => (d.name === doc.name ? doc : d)) },
    );
  /** And what one page added or removed, which the count is the same count of. */
  const created = (kind: DocKind) => (doc: Doc) =>
    setDocs((held) =>
      held === null
        ? held
        : { ...held, [kind]: [...held[kind], doc].sort((a, b) => (a.name < b.name ? -1 : 1)) },
    );
  const deleted = (kind: DocKind) => (name: string) =>
    setDocs((held) =>
      held === null ? held : { ...held, [kind]: held[kind].filter((d) => d.name !== name) },
    );
  const from = continuing(selected);
  const writing = selected === NEW || from !== null;
  /**
   * What the workbench was stopped in the middle of, and has not been asked about.
   * Not a ticket waiting out a session limit: the modal is for work nobody has
   * decided about, and that work has decided — it carries on at the time it says.
   */
  const stoppedMidStage = tickets.filter((t) => t.interrupted && !waitingOutLimit(t, Date.now()));

  // Which cards are next rather than idle. One count for the whole board, so every
  // card is judged against the same load — and none before the policy has arrived.
  const running = tickets.filter((t) => t.running).length;
  const held = (t: Ticket) => heldBy(t, tickets);
  const queued = (t: Ticket) =>
    policy !== null && waitingForSlot(t, running, policy, held(t).length > 0);

  return (
    <>
      <header>
        <h1>Workbench</h1>
        {repo !== null && <Repo dir={repo} />}
        <nav className="tabs">
          {TABS.map((name) => (
            <a
              key={name}
              className={name === tab ? 'picked' : ''}
              href={`#${name === 'Board' ? '' : name.toLowerCase()}`}
            >
              {name}
              {counts[name] !== null && <span className="count"> ({counts[name]})</span>}
            </a>
          ))}
        </nav>
        {waiting > 0 && <span className="waiting">{waiting} waiting on you</span>}
        {policy !== null && <span className="quiet">{policy.wipLimit} at a time</span>}
        {stopped !== null && <Stop state={stopped} onAct={control} />}
        <Theme />
      </header>

      {error !== null && <div className="error">{error}</div>}

      {tab === 'Agents' && (
        <Docs
          kind="agent"
          docs={docs?.agent ?? null}
          onSaved={saved('agent')}
          empty="No agent files."
        />
      )}
      {tab === 'Skills' && (
        <Docs
          kind="skill"
          docs={docs?.skill ?? null}
          onSaved={saved('skill')}
          onCreated={created('skill')}
          onDeleted={deleted('skill')}
          empty="No skills yet. They live in the workbench's skills/ directory."
        />
      )}
      {tab === 'Analytics' && <Analytics version={version} />}
      {tab === 'Settings' && (
        <Settings
          onSaved={() => {
            setVersion((v) => v + 1);
            setSettingsVersion((v) => v + 1);
          }}
        />
      )}

      {tab === 'Board' && (
        <div className="board">
          {COLUMNS.map((column) => (
            <Column
              key={column.name}
              name={column.name}
              tickets={
                column.name === DONE
                  ? sortedDone(tickets, doneView)
                  : inColumn(tickets, column.name)
              }
              queued={queued}
              held={held}
              // Only Done: the other six are the queue, and the order work is
              // taken in is the manager's to set rather than the reader's to sort.
              view={column.name === DONE ? doneView : undefined}
              onView={chooseDone}
              // The kinds on the finished cards, not the ones the settings offer:
              // the menu filters on what `prefixOf` reads back off a title.
              kinds={column.name === DONE ? kindsInDone(tickets) : []}
              // Done under one of its own sorts is not in the board's order, so a
              // drag there would write a move nothing on screen could show.
              reorderable={column.name !== DONE || keepsBoardOrder(doneView.sort)}
              // The backlog is where a ticket starts, so that is where writing one
              // belongs — at the top of the column it will appear in, rather than in
              // the header beside things that are about the whole board.
              action={
                column.name === BACKLOG ? (
                  <button className="go new" type="button" onClick={() => open(NEW)}>
                    New ticket
                  </button>
                ) : undefined
              }
              // Its own column too, where the drop means the end of it. Anywhere a
              // card can land says so before it is dropped rather than after.
              accepts={
                dragging !== null &&
                (dropTarget(dragging) === column.name || columnFor(dragging) === column.name)
              }
              dragging={dragging}
              onDrop={() => dragging && move(dragging, column.name)}
              onDropOn={(before) => dragging && reorder(dragging, before)}
              onDragStart={setDragging}
              onDragEnd={() => setDragging(null)}
              onOpen={open}
            />
          ))}
        </div>
      )}

      {writing && (
        <aside>
          <h2>{from === null ? 'New ticket' : `Carrying on from ${from}`}</h2>
          <div className="meta">
            {from === null
              ? 'Put it on the backlog to decide later, or commit to it now and it starts.'
              : `It starts on ${from}'s branch, so that work is in its worktree from the ` +
                `first stage, and its brief says what stopped ${from}. Then the backlog, as usual.`}
          </div>
          <TicketForm
            submitLabel="Create on backlog"
            commitLabel="Create and commit"
            askAboutApproval
            tickets={tickets}
            prefixes={prefixes}
            onCancel={() => open(null)}
            // Straight into the ticket that was just written, either way — whether
            // you have just committed to it or are about to decide.
            onSubmit={(fields) =>
              act(
                wb
                  .create(fields.title, fields.body, {
                    from: from ?? undefined,
                    on: fields.on.trim() || undefined,
                    requiresApproval: fields.requiresApproval,
                    waitsFor: fields.waitsFor,
                  })
                  .then(async (t) => {
                    if (fields.commit) await wb.queue(t.id);
                    open(t.id);
                  }),
              )
            }
          />
        </aside>
      )}

      {/* Over everything, and before anything else is read: work that was stopped
          and is waiting to hear whether to carry on is spending nothing in the
          meantime, and is invisible on a board full of cards. */}
      {stoppedMidStage.length > 0 && !decided && (
        <Interrupted tickets={stoppedMidStage} onAct={act} onClose={() => setDecided(true)} />
      )}

      {selected !== null && !writing && (
        <Detail
          id={selected}
          version={version}
          // The whole board, so a suggestion already made into a ticket can say
          // which one rather than offering to make it again.
          tickets={tickets}
          prefixes={prefixes}
          // What Done is sorted and filtered by, so the panel's pager steps through
          // the board in the order the board is actually drawn in.
          view={doneView}
          onAct={act}
          onClose={() => open(null)}
        />
      )}
    </>
  );
}

/**
 * The whole board, stopped and started.
 *
 * One press stops it: nothing new starts, and the stages already going are left to
 * finish — which is why the second button appears rather than a dialog. Pressing
 * stop again is what ends them, and the first press is the confirmation for it: you
 * have already decided, and now you are deciding whether to wait.
 */
function Stop({
  state,
  onAct,
}: {
  state: { stopped: boolean; running: string[] };
  onAct: (work: Promise<unknown>) => void;
}) {
  if (!state.stopped) {
    return (
      <button type="button" className="stopper" onClick={() => onAct(wb.stop())}>
        Stop
      </button>
    );
  }

  return (
    <>
      <button type="button" className="stopper go" onClick={() => onAct(wb.start())}>
        Start
      </button>
      {state.running.length > 0 && (
        <button type="button" className="stopper" onClick={() => onAct(wb.stop())}>
          Stop {state.running.length} still running
        </button>
      )}
    </>
  );
}

/** The panel is in the address, so a ticket can be linked to and survives a reload. */
function open(id: string | null): void {
  location.hash = id ?? '';
}

function Column(props: {
  name: string;
  tickets: Ticket[];
  /** Something to do in this column, under its heading. Only the backlog has one. */
  action?: ReactNode;
  /** How this column is read, when it is the one column that can be sorted and cut down. */
  view?: DoneView;
  onView: (change: Partial<DoneView>) => void;
  /** The words found on this column's titles, which is what the kind filter offers. */
  kinds: string[];
  /** Whether a card here can be dragged: only where the board's order is what is drawn. */
  reorderable: boolean;
  /** Whether a card is next for a slot — the same judgement for every column. */
  queued: (t: Ticket) => boolean;
  /** The tickets a card is held behind. */
  held: (t: Ticket) => Ticket[];
  accepts: boolean;
  /** The card being dragged, so a card can say whether it is a place to land. */
  dragging: Ticket | null;
  onDrop: () => void;
  onDropOn: (before: Ticket) => void;
  onDragStart: (t: Ticket) => void;
  onDragEnd: () => void;
  onOpen: (id: string) => void;
}) {
  const { name, tickets, accepts, dragging, view, reorderable } = props;

  // What the kind filter offers: the words found on the cards, plus the one being
  // filtered on if no card carries it. A saved choice must always have an option
  // that shows it — otherwise Done is cut down by a word with nothing on screen
  // saying so, and no way back to Any.
  const kinds =
    view === undefined || view.prefix === 'all' || props.kinds.includes(view.prefix)
      ? props.kinds
      : [...props.kinds, view.prefix];

  return (
    <div
      className={`col${accepts ? ' drop' : ''}`}
      // Only a column that would accept this card allows the drop, so an illegal
      // move shows as one before it is attempted rather than as an error after.
      onDragOver={(e) => accepts && e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        props.onDrop();
      }}
    >
      <h2>
        {name} {tickets.length > 0 && <span>({tickets.length})</span>}
      </h2>
      {view !== undefined && (
        <div className="done-view">
          <select
            aria-label={`${name} order`}
            value={view.sort}
            onChange={(e) => props.onView({ sort: e.target.value as DoneView['sort'] })}
          >
            {SORTS.map((sort) => (
              <option key={sort} value={sort}>
                {SORT_LABELS[sort]}
              </option>
            ))}
          </select>
          <select
            aria-label={`${name} outcome`}
            value={view.outcome}
            onChange={(e) => props.onView({ outcome: e.target.value as DoneView['outcome'] })}
          >
            {OUTCOMES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label={`${name} kind`}
            value={view.prefix}
            onChange={(e) => props.onView({ prefix: e.target.value })}
          >
            <option value="all">Any kind</option>
            {kinds.map((prefix) => (
              <option key={prefix} value={prefix}>
                {prefix}
              </option>
            ))}
          </select>
        </div>
      )}
      {props.action}
      {tickets.map((t) => (
        <Card
          key={t.id}
          ticket={t}
          queued={props.queued(t)}
          held={props.held(t)}
          // Every card, not only the two that change column: order is the queue,
          // and a card that cannot be moved cannot be put at the front of it. The
          // exception is Done sorted by price, title or outcome, where the order
          // drawn is not the board's — there a drag would be a move that happened
          // in the log and nowhere the reader can see.
          draggable={reorderable}
          accepts={
            reorderable && dragging !== null && dragging.id !== t.id && name === columnFor(dragging)
          }
          onDragStart={() => props.onDragStart(t)}
          onDragEnd={props.onDragEnd}
          onDrop={() => props.onDropOn(t)}
          onOpen={() => props.onOpen(t.id)}
        />
      ))}
    </div>
  );
}

/**
 * Which repository this board is working in. The badge has room for the last
 * segment of the path and no more, and two checkouts of the same project end in
 * the same segment — so the whole path is a press away, rather than a hover
 * tooltip nobody knows is there.
 */
function Repo({ dir }: { dir: string }) {
  const [open, setOpen] = useState(false);

  // Escape closes it, the way it closes the list in Pick. Only while it is open:
  // a listener on the document outlives the panel otherwise.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <span className="repo-at">
      <button
        type="button"
        className="repo mono"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {folder(dir)}
      </button>
      {open && (
        <div className="repo-info">
          <div>Workbench working folder:</div>
          <div className="mono">{dir}</div>
          <div className="quiet">This is the folder the workbench is working in.</div>
        </div>
      )}
    </span>
  );
}

/** The folder a path ends in — what tells two boards apart where the whole path will not fit. */
function folder(dir: string): string {
  return dir.replace(/\/+$/, '').split('/').pop() || dir;
}

function idInHash(): string | null {
  return location.hash.slice(1) || null;
}
