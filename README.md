# Workbench

A board of tickets. Each ticket is a piece of work you want done. Agents do the work; you
decide what gets done and whether it is good enough.

Every ticket goes through four stages — **plan**, **implement**, **review**, **verify** —
each one a separate agent with its own tools. You approve the plan before any code is
written, and accept or reject the result as a pull request.

Each ticket gets its own git branch and worktree, so tickets running at the same time
cannot collide and your own working tree is never touched.

## What you need

- **Node 26+** — it uses Node's built-in SQLite and its TypeScript support, so there is
  no database to install.
- **git**, and **[`gh`](https://cli.github.com)** authenticated, for pull requests.
- A **Claude** credential. `claude setup-token` gives a long-lived one from a
  subscription; `ANTHROPIC_API_KEY` uses a Console key, billed per token. The stages can
  also run on a Chat Completions service instead — Codex, Ollama, LM Studio, llama.cpp,
  vLLM — by setting `WB_PROVIDER=openai` with `WB_BASE_URL`, `WB_API_KEY` and `WB_MODEL`.
  `wb auth` reports which service is live.

## Getting started

In the repository you want work done in:

```bash
npm install github:peterbjohnson/workbench
npx wb init      # writes .workbench/ — config, and somewhere for your own skills
npx wb auth      # spends a fraction of a penny proving the credential works
npx wb serve     # the board, on http://127.0.0.1:4600
```

Then, from anywhere in that repository:

```bash
wb new "Add a retry" "It gives up on the first failure."
wb queue t1        # commit to it; nothing starts before this
wb list            # every ticket and where it is
wb approve t1      # let implementation start
wb show t1         # the plan, and everything that happened
```

There is nothing to release and no version to track: `npm install` resolves your
dependency to a commit and writes it into your lock file, and `wb update` asks the same
question again later. It predicts nothing — it installs, then says what actually moved,
so a tag, a branch or a commit all behave the way you told npm they should.

`wb serve` says at startup when something newer is waiting, and never does anything
about it. A dependency pinned to a tag is silent, because its tag has not moved.

```bash
wb update          # fetch whatever has been pushed since; then restart wb serve
```

`wb --help` lists every command. Everything the command line does, the board does too —
they are both clients of `wb serve`, which is the only process that touches the database
or calls an agent.

⚠️ **`wb serve` calls real agents and spends real money.** `WB_RUNNER=fake wb serve` runs
a scripted agent that makes no external calls but does real work on disk, so worktrees,
commits and diffs are genuine. It is the way to try this without spending anything.

## Where it stops for you

A ticket waits for you at three points, and guesses at none of them:

- **The backlog** — until you commit to it. The workbench never touches this column.
- **The plan gate** — the plan is written and waiting for your approval. This is the one
  place a person sees the work before any money goes on building it.
- **Anything an agent cannot decide** — it stops and asks rather than choosing for you.

Finished work arrives as a pull request. Merging it accepts the work; requesting changes
sends it back, and what you write becomes what the next attempt is briefed with.

## Documentation

- [Using it](docs/using-it.md) — the board, the ticket panel, and how work moves
- [Reference](docs/reference.md) — commands, configuration, limits, the HTTP API, tools
- [Design](docs/design.md) — why four stages, and why they are allowed to say what they
  say
- [Archive](docs/archive/) — superseded documents, kept for how this got here

## Working on the workbench itself

```bash
npm install
npm test
npm run typecheck
```

The tests need no credential, no network and no agents: the rules, the state machine, the
guard and the orchestrator are tested with the outside world faked, and the git tests run
against throwaway repositories.
