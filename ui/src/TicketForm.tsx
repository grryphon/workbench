import { useEffect, useRef, useState } from 'react';

import type { Ticket } from '../../src/domain/ticket.ts';
import { joinTitle, splitTitle } from '../../src/domain/titles.ts';
import { Pick } from './Pick.tsx';
import { wb } from './wb.ts';

/** How long the title has to stop changing before it is worth asking about. */
const SETTLED_MS = 800;

/**
 * Writing a ticket, and rewriting one. The same form both times: what you can say
 * when you create a ticket is exactly what you can change afterwards, so there is
 * no way to end up with a ticket you cannot fix.
 */
export function TicketForm(props: {
  title?: string;
  body?: string;
  /**
   * Offer the plan gate as a choice. Whenever the gate is still ahead — writing a
   * ticket, or rewriting one whose plan is not yet finished — and not after: a
   * ticket already past its plan cannot be given a gate it did not stop at.
   */
  askAboutApproval?: boolean;
  /** Whether it has one now, when rewriting. A new ticket has one unless told otherwise. */
  requiresApproval?: boolean;
  /**
   * Every ticket on the board, so a new one can say what it starts after. Offered
   * only when writing: this is the moment you know what the work follows, and
   * until now the only way to say it was to write the ticket and then go back
   * into it.
   */
  tickets?: Ticket[];
  /**
   * What the drop-down in front of the title offers, from the settings. It goes on
   * the front of the title itself, so with none configured there is no drop-down
   * and a title is just a title.
   */
  prefixes?: string[];
  submitLabel: string;
  /**
   * A second way to submit, which commits to the ticket as well as writing it.
   * Only when writing one: there is nothing to commit to when rewriting.
   */
  commitLabel?: string;
  onSubmit: (fields: {
    title: string;
    body: string;
    requiresApproval: boolean;
    waitsFor: string[];
    /** A branch, `#123` or a pull request's URL to work on and push back to. Empty for none. */
    on: string;
    commit: boolean;
  }) => Promise<unknown>;
  onCancel: () => void;
}) {
  const prefixes = props.prefixes ?? [];
  // A ticket being rewritten arrives with its prefix in its title, so it comes
  // apart into the two boxes it was written in and goes back together the same.
  const written = splitTitle(props.title ?? '', prefixes);
  const [prefix, setPrefix] = useState(written.prefix);
  const [title, setTitle] = useState(written.rest);
  const [body, setBody] = useState(props.body ?? '');
  const [requiresApproval, setRequiresApproval] = useState(props.requiresApproval ?? true);
  const [waitsFor, setWaitsFor] = useState<string[]>([]);
  const [on, setOn] = useState('');
  const [saving, setSaving] = useState(false);
  /** A better name for this ticket, and the name it is better than. */
  const [suggestion, setSuggestion] = useState<{ for: string; name: string; why: string }>();

  /**
   * Every name already asked about, so a name is asked about once however long
   * someone spends on the rest of the form — including one that came back with a
   * suggestion that was then dismissed, and the suggestion itself once taken.
   *
   * The name a ticket already has starts in it, as the box holds it — with the
   * prefix taken off — as well as whole: opening the form to rewrite the
   * instructions is not someone asking what the ticket should be called.
   */
  const asked = useRef(new Set<string>([written.rest.trim(), (props.title ?? '').trim()]));
  // Sent as context, but never what starts a question: typing the instructions
  // would otherwise keep pushing the one about the title further away.
  const bodyNow = useRef(body);
  bodyNow.current = body;
  // What is in the box now, so a slow answer about an earlier name cannot land on
  // top of the answer about this one. Two questions in flight is the ordinary
  // case: the wait is under a second and an answer takes several.
  const titleNow = useRef(title);
  titleNow.current = title;

  // Someone is writing a ticket, so a question about its name is coming. Almost all
  // of what one costs is getting something ready to ask, and told now that is over
  // before the typing stops — which is the difference between a hint that lands
  // while the form is open and one that lands after it has gone.
  useEffect(() => {
    void wb.warmNameCheck().catch(() => {});
  }, []);

  useEffect(() => {
    const name = title.trim();
    if (name === '' || asked.current.has(name)) return;

    const timer = setTimeout(() => {
      asked.current.add(name);
      void wb
        .checkName(name, bodyNow.current)
        .then((reply) => {
          if (name !== titleNow.current.trim()) return;
          if (reply.name !== null) {
            setSuggestion({ for: name, name: reply.name, why: reply.why ?? '' });
          }
        })
        // A hint about a name is never worth interrupting someone writing a ticket.
        .catch(() => {});
    }, SETTLED_MS);
    return () => clearTimeout(timer);
  }, [title]);

  const submit = (commit: boolean) => {
    if (title.trim() === '' || saving) return;
    setSaving(true);
    void props
      .onSubmit({ title: joinTitle(prefix, title), body, requiresApproval, waitsFor, on, commit })
      .finally(() => setSaving(false));
  };

  return (
    <form
      className="form"
      onSubmit={(e) => {
        e.preventDefault();
        // Enter submits the plain one: the safe half of the pair, when there is a pair.
        submit(false);
      }}
    >
      <label>
        Title
        <div className="titled">
          {prefixes.length > 0 && (
            <select value={prefix} onChange={(e) => setPrefix(e.target.value)}>
              <option value="">none</option>
              {prefixes.map((one) => (
                <option key={one} value={one}>
                  {one}
                </option>
              ))}
            </select>
          )}
          <input
            value={title}
            autoFocus
            placeholder="What you want done, in a few words"
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
      </label>

      {/* Shown only while it is still about what is in the box: carry on typing and
          it goes, rather than recommending a name for a name you have left behind. */}
      {suggestion !== undefined && suggestion.for === title.trim() && (
        <div className="suggest">
          <span className="name">{suggestion.name}</span>
          <span className="quiet">{suggestion.why}</span>
          <button
            type="button"
            onClick={() => {
              asked.current.add(suggestion.name);
              setTitle(suggestion.name);
              setSuggestion(undefined);
            }}
          >
            Accept
          </button>
          <button type="button" onClick={() => setSuggestion(undefined)}>
            Dismiss
          </button>
        </div>
      )}

      <label>
        Instructions
        <textarea
          value={body}
          rows={12}
          placeholder={
            'Everything the work needs: what to do, what not to, what done looks like.\n\n' +
            'This goes to every stage, in full.'
          }
          onChange={(e) => setBody(e.target.value)}
        />
      </label>

      {props.tickets !== undefined && (
        <label>
          Start after
          <Pick id="after-new" picked={waitsFor} onChange={setWaitsFor} tickets={props.tickets} />
          <span className="quiet">
            Once you commit to it, it runs nothing until every one of these has offered its work or
            ended.
          </span>
        </label>
      )}

      {/* Only when writing, like the one above: a ticket's branch is cut from what it
          is on, so there is no later moment to say it. */}
      {props.tickets !== undefined && (
        <label>
          On branch
          <input
            value={on}
            placeholder="a branch, #123 or a pull request URL — empty for the base"
            onChange={(e) => setOn(e.target.value)}
          />
          <span className="quiet">
            Works on that branch instead of the base, and pushes the finished work back to it.
          </span>
        </label>
      )}

      {props.askAboutApproval === true && (
        <label className="switch">
          <input
            type="checkbox"
            checked={requiresApproval}
            onChange={(e) => setRequiresApproval(e.target.checked)}
          />
          Plan requires your approval before implementation
          <span className="quiet">
            {requiresApproval
              ? 'It stops at the approval gate when the plan is written, and waits there for you.'
              : 'It builds what it plans, without stopping. The plan is still written, and still what review and verify hold it to.'}
          </span>
        </label>
      )}

      <div className="row">
        <button
          className={props.commitLabel === undefined ? 'go' : ''}
          type="submit"
          disabled={title.trim() === '' || saving}
        >
          {props.submitLabel}
        </button>
        {props.commitLabel !== undefined && (
          <button
            className="go"
            type="button"
            disabled={title.trim() === '' || saving}
            onClick={() => submit(true)}
          >
            {props.commitLabel}
          </button>
        )}
        <button type="button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
