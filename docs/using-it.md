# Using it

The board, the ticket panel, and how work moves. Why it works this way is in
[Design](design.md); what to type is in the [Reference](reference.md).

## The board

`http://127.0.0.1:4600` — five pages, named across the top. **Board** is the work and
**Analytics** is what that work has come to; **Agents**, **Skills** and **Settings** are the
workbench itself. Each is in the address (`#agents`), so one can be linked to and survives
a reload.

Tickets sit in columns and move themselves as the work proceeds:

| | |
|---|---|
| **Backlog** | ideas. **The workbench never touches this column.** |
| **Committed** | you have decided to do it. Work starts from the top. |
| **Planning** | a plan is being written |
| **Approval** | it is waiting for you to approve that plan |
| **Building** | implement, review, verify |
| **Pull request** | offered, and waiting on a merge or a change request |
| **Done** | finished, cancelled or given up on |

The only card you move between columns by hand is one between **Backlog** and
**Committed**. Everything to the right of that moves itself, and a ticket that is stuck
stays in the column of the stage it stopped in, marked as needing you. The header counts
everything waiting on you. Each backlog card has a tick box in its corner, and *Commit N*
above the column moves the ticked ones to **Committed** together, in the order they were in.

**A banner under the header when agent work is paused** because the Claude credential is
missing, expired or refused. It says which, and what to type to put it right; nothing
starts until you do, and the rest of the board — writing, approving, cancelling — carries
on as usual. A logged-out CLI picks itself up once you log in; a credential the service
refused needs replacing and the workbench restarting.

**Light or dark, at the end of the header.** *Auto* follows the machine and is what you
get until you say otherwise; *Light* and *Dark* overrule it. The choice is the browser's,
not the workbench's — it is kept locally rather than in Settings, so the same board read
from a laptop at night and a desktop by a window can be set differently.

**Order is the queue, so it is yours to set.** Work is taken from the top; dragging a card
onto another puts it in front of that one, and onto the column behind them puts it last.
The order a ticket was written in is a default, not a decision.

**Done reads the other way round, and reads however you like.** It is not a queue — nothing
is taken from it — and the ticket that just finished is the one worth seeing, so it is at the
top. Three menus under the heading say how it is read: sort by **Newest**, **Oldest**,
**Dearest**, **Title** or **Outcome**; then show only what was **Merged**, **Cancelled** or
**Given up on**; then only one kind of ticket, by the word its title is written behind —
the kind menu offers the words actually found on the finished tickets, so every choice on it
shows you something. Like the theme, the choice is kept in the browser and survives a reload.
The count beside the heading is what is showing, so a filtered column says how much of it you
are looking at. Sorted by anything but Newest or Oldest, its cards cannot be dragged: the
order on screen is worked out from the cards rather than the board's, and a move you could
not see is worse than one you cannot make.

## Analytics

**What the board has come to, in numbers.** Every figure on it is worked out from the event
log when the page is asked for — nothing is stored and nothing is a snapshot, so it is as
current as the board beside it and redraws whenever a stage says anything. Four sections:

| | |
|---|---|
| **The board** | how many tickets, where they are, how many merged, and what it has all cost |
| **Money** | spend by stage and by scale, what a ticket typically costs, and the ten dearest |
| **Flow** | tickets finished per week, how long one takes, and how often plans are sent back |
| **Agents** | runs per stage with how long and how much, tools used, tools refused, checks passed |

Costs are what the model service reported, so they are spend and not tokens. Chat is counted
apart from the stages, for the same reason it is kept off the ticket: talking about a ticket
must not be able to push it past its limit.

## The plan gate

A plan is written, and the ticket stops for you to approve it. That is the one place a
person sees the work before any money goes on building it.

**The gate can be turned off per ticket** — the switch on the ticket form, when you write
one or when you edit one whose plan is not yet finished, or `wb new --no-approval` and
`wb edit --no-approval`. It defaults to on, so skipping it is something to choose rather
than something to forget. The switch goes once the plan is finished: by then the ticket
either stopped at its gate or did not. It comes back if the ticket is sent to be planned
again. Off, the ticket goes straight from planning to
implementing; the plan is still written, still recorded, and still the `COMPLETION CRITERIA:` list
that review and verify hold the work to. The ticket says so on its panel, because one that
never stopped for you otherwise looks like one whose gate you missed.

## The ticket panel

**A ticket opens on where it is.** Under the title, in words: what state it is in and what
happens next — *Waiting on you: approve the plan, or send it back*, *Building: review is
running, step 2/5*, *Offered: waiting on the pull request*. Then a line of stages saying
which ran and how each ended, then everything identifying it — what it costs, which round
it is on, who it waits for, its pull request — then whatever it is waiting on you for, then
the buttons that answer it.

**One of those is a guess at how long it will take**, written `~2–4 hours`, with what it was
compared to on hover. It is asked of a model when the ticket is queued and again after each
stage, from the tickets this workbench has already finished — so it is a comparison with
your own work rather than an opinion about software, and it is worth about as much as that
history is long. What is asked is the **Estimate prompt** setting, and you can rewrite it.

**Only what the ticket is acting on is at the top.** A rejection or a set of changes stays
on the ticket for good, because the next plan and the hand-over message both read it — so
it leads the panel only while the stage answering it is the one running, or while the plan
answering it waits at the gate for you, and otherwise folds into **Earlier**, below the
buttons. Without that, a ticket in a pull request opened
on why it was sent back three stages ago.

Everything you can do to a ticket is in that one block:

| | |
|---|---|
| **Answer it** | a stage stopped to ask you something |
| **Start after** | which tickets this one waits for |
| **Ask for changes** | keep the work, put these right |
| **Replan it** | the approach is wrong; buy a new plan |
| **Return with tweaks** | it merged, and you want it changed; back to planning with what to tweak |
| **Ship it** | offer what it has as a pull request, whatever the agents said |
| **Reject/cancel it** | stop it |

Anything that has not ended can be cancelled, an idea still in the backlog included — that
is how one you have decided against leaves the board.

Under those, in the order you read them: the **description**, then the plan, then what each
stage made of it. The description comes first because the plan and the runs are answers to
it, and judging work against anything else is how a ticket gets rejected for something it
never asked for.

**Nothing is shown at full length twice.** The plan collapses to its steps; each stage run
collapses to a line — what it was, how it ended, its checks, its tool calls and what it
cost — and the prose opens when you want it.

**Everything that happened** is the whole record, one line per event, and any line with
more behind it opens: what an agent said in full, the arguments a tool was really given,
what a stage cost.

**The bottom of the panel moves on to another ticket.** *← Previous in column* and *Next in
column →*, each with the id it goes to, so a column can be read through without going back
to the board between cards. The sequence is the board's own: the rest of that column, then
on into the next one — and a step that leaves the column says which one it lands in, *Next ·
Building · t9*. The menu between the two changes the sequence to ticket number instead,
*Next ticket · t14*, for going through everything once; the choice stays in your browser. At
the two ends of the board the control is still there and does nothing, rather than vanishing
and moving the other one under your pointer.

**A stage that failed can be restarted.** A crash — the model service hanging up, a push
that could not reach the remote — parks the ticket with nothing to answer, so the panel
offers **Restart this stage** rather than a question box. It runs again from the top, and
the failed attempt stays in the record beside the one that worked.

**A stage the workbench was stopped in the middle of carries on instead.** Being stopped
is not failing — it is how a `wb update` is picked up — and the run it was in the middle
of is still there, so paying for the whole stage again would be paying twice for thinking
already done. Those tickets say **stopped mid-stage** rather than **needs you**, and the
board asks about them in one box the next time you open it: everything checked, one press
for all of it. Nothing carries on by itself. `wb continue <id>` does one from the command
line, and **Start this stage again** is there when carrying on is the wrong answer.

**A stage stopped by a session limit carries on without being asked.** When a run ends on
*You've hit your session limit · resets 10:30pm*, the model service is saying come back
later rather than that anything went wrong. The ticket parks holding its conversation, its
card says **carries on at 10:30 pm** instead of asking for you, and at that time it picks
the stage up where it stopped. Nothing else that runs on the same model starts in the
meantime — those stages would only spend a run finding out the same thing — but anything on
another model carries on, so a plan waiting out a limit does not stop work being built.
Several tickets can be waiting at once, on different models, and each carries on at its own
time. Those tickets are not in the box that asks you about stopped stages — there is
nothing to decide — but both buttons are still on the panel if you want it sooner, or
differently. A limit message that does not say when it resets fails like any other crash.

## Holding a ticket behind others

`wb wait t43 t37,t40`, `wb new --after`, or the **Start after** box on the panel and the
new-ticket form. You filter it by typing and pick from it — an id is not something anyone
remembers, and a free-text box takes one that does not exist as readily as one that does.
Only tickets that would actually hold it back are offered.

A held ticket runs nothing at all until every one of them has let go, says whose cards it
is behind, and does not say `queued` — a slot coming free would do nothing for it.

**The release is the pull request, not the merge.** What one ticket needs of another is
that it stop committing; after that its branch is final. Waiting for the merge would put
every dependency behind a person. A ticket that was cancelled or given up on releases what
waits on it too: a queue held up by a ticket nobody is working on is the one failure with
no way out.

**And the work comes with it.** An offer is not a merge, so the base does not have that
work in it — the held ticket is branched from the base as everything is, and then every
branch it waited for is merged into its own before its first stage starts. One that was
cancelled or given up on brings nothing, because there is nothing of it to bring; one whose
pull request has landed brings nothing either, because the base already has it. Two
branches that will not sit in the same tree **block** the ticket then and there, naming the
branch and the files, rather than after it has been built on half of what it waited for.

## Steps

A plan ends with a `STEPS:` list. They cost nothing extra — the plan is writing them
anyway — and you see them when you approve, so approving the plan approves its steps.

Afterwards they are what progress is reported against. The implement stage says `STEP <n>`
as it begins each one, and the card says `step 2/5` instead of `running`. Without it a
twenty-minute stage says nothing but that it is going. An agent that never announces a
step costs the ticket its checklist and nothing else.

**A ticket can be rewritten at any point**, including while it is being worked on. Every
stage is briefed from the ticket as it stands when that stage starts, so a rewrite reaches
everything that has not begun; a stage already running keeps the wording it was given,
because it has already read it.

## Not going stale

A branch is cut from `origin/main` once, and then the ticket works for hours while other
tickets merge. By the time it is offered it is built on a base that no longer exists — and
that, not any difficulty about merging text, is where conflicts come from.

So the base is brought in rather than resolved later. Before a ticket opens its pull
request, and again for every pull request still standing when another one merges, the
branch merges the current base and the standing checks are run against it. A branch that
already has the base is the ordinary case: nothing merges, nothing is recorded, nothing is
re-run and nothing is spent.

When something does merge and the checks then fail, the ticket **blocks** with the failing
output. Its work stands and its branch is untouched; what to do about a base that breaks it
is a decision rather than another stage.

A conflict is not a decision. A standing pull request whose branch will not take the base
is handed to an implement run, which finishes the merge, has the standing checks run
against what it left, and pushes the result to the same pull request — the ticket stays
offered and nobody is asked anything. It gets one attempt: a run that leaves a path
conflicted, or that fails the checks, puts the branch back exactly as it was — nothing
committed — and **blocks** with the conflicting paths, saying that a resolution was tried
and what it left. A clash with work the ticket waited for buys the same one attempt: it is
the same mechanical resolution, and a run that cannot make it **blocks** naming that branch
rather than the base — which tells you more about a decomposition that was wrong than a
button that always says the same thing.

Accepting work that clashes with the base gets that same one attempt before it blocks, so a
click that lands is a click. The pass over the other pull requests does not wait for the
runs it sets off — it does the merges, hands each clash to a run beside it, and is done in
seconds, so accepting five things in a row costs at most one resolution each rather than one
for every other branch after every landing. Only one merge happens at a time, and a ticket
whose turn has not come says on its card and in its panel which merge it is behind.

A pull request you have already answered is left alone. Pushing a merge to it would be a
commit made for reasons nothing to do with your objection, and a branch that has moved past
a change request reads as one that has addressed it.

## Work that outlives its ticket

Work only leaves the workbench by being accepted. A ticket that is cancelled, or given up
on, still has its commits on `wb/<id>` — and nothing could otherwise reach them, since a
worktree is cut from `origin/main` and the guard refuses every path outside it.

```bash
wb new --from t13 "Fix the units" "The headline claim is not supported by table 2."
```

The new ticket's branch is cut from that ticket's, so the earlier work is in its own
worktree from the first stage: readable, editable, and needing no exception to the guard.
Its brief says what it is carrying on from and why that stopped — which is worth more than
the code, because an objection nobody passes on is rediscovered at full price. It is also
the only way it can travel: the objections are events in a database the worktrees
deliberately cannot see.

It is not restricted to tickets that failed. The rule is *start from that ticket's branch
instead of main*, and it reads the same whether the work was abandoned, superseded, or
finished and now being extended.

A stopped ticket that left commits says so on its card and offers **Carry on from this**,
which writes the new ticket already pointed at that branch. That is the only moment it can
be said: a ticket's branch is cut when it is created, so a body that merely *mentions* an
earlier ticket starts from main like any other.

Every objection the earlier ticket drew is passed on, not only the last. One that survived
being answered twice is rejected for the same thing three times, and that it recurred is
the most useful thing about it.
