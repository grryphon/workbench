# Other models

The workbench ships talking to Claude. It can talk to something else instead: the Codex
models on OpenAI's API, or a model running on your own machine.

Nothing about how work moves changes. The four stages, the plan gate, the guard that
confines an agent to its ticket's worktree, the pull request at the end — all of it is
the same code, and it does not know which model answered.

## Choosing one

In `workbench.config.json`:

```json
{
  "base": "main",
  "checks": ["npm test"],
  "provider": "openai",
  "baseUrl": "https://api.openai.com/v1",
  "models": {
    "claude-opus-5": "gpt-5-codex",
    "claude-fable-5-1": "gpt-5-mini"
  },
  "prices": {
    "gpt-5-codex": [1.25, 10]
  }
}
```

Or, without touching a file the board also writes to, in the environment. These win over
the file, and are what you want for an afternoon of trying something:

| Variable | What it does |
| --- | --- |
| `WB_PROVIDER` | `claude` (the default), `openai`, or `anthropic-gateway` |
| `WB_BASE_URL` | Where the service is |
| `WB_API_KEY` | The key. `OPENAI_API_KEY` is read too |
| `WB_MODELS` | `claude-opus-5=gpt-5-codex,claude-fable-5-1=gpt-5-mini` |
| `WB_MODEL` | One model for every stage, whatever the agent files say |
| `WB_PRICES` | `gpt-5-codex=1.25/10` — USD per million tokens, in then out |
| `WB_REASONING` | `on` sends `reasoning_effort`. Off, because several local servers refuse it |

Then prove it, the same way you prove a Claude credential:

```
wb auth      # spends a fraction of a penny asking the service one thing
wb serve     # the board; it says which model service it is on
```

## A model on your own machine

Ollama, LM Studio, llama.cpp's server and vLLM all answer the same wire, so they differ
only by address. None of them want a key.

```
WB_PROVIDER=openai WB_BASE_URL=http://127.0.0.1:11434/v1 WB_MODEL=qwen3-coder wb serve
```

| Server | `WB_BASE_URL` |
| --- | --- |
| Ollama | `http://127.0.0.1:11434/v1` |
| LM Studio | `http://127.0.0.1:1234/v1` |
| vLLM, llama.cpp | `http://127.0.0.1:8000/v1` |

Two things are worth knowing before you try it. A small model will get a real ticket
wrong, and often confidently: it will still be confined to its worktree, still stop at
the plan gate, and still arrive as a pull request you can refuse — which is what the
board is for. And the four stages name different models on purpose, so a single
`WB_MODEL` is the blunt instrument; `WB_MODELS` is the one that keeps a cheap model doing
the cheap stages.

## Money

`maxBudgetUsd` in the agent files, and the board's per-ticket ceiling, are spent money.
A service that tells you what a completion cost is charged in dollars. One that tells you
nothing is charged nothing — and a ceiling cannot bound a number nobody has, so **on an
unpriced model the money rails are inert**. That is stated rather than papered over: the
alternative, treating an unknown as zero and stopping everything, means a local model
never runs at all.

Put prices in and the rails work again. `WB_PRICES=gpt-5-codex=1.25/10` or the `prices`
block. The number is per million tokens, input first.

## What you give up

Honest list, because finding these out mid-ticket is the expensive way to learn them.

- **A run cannot be picked back up after a restart.** Claude's CLI keeps its
  conversations in `~/.claude/projects`, so a workbench that died mid-stage resumes
  where it stopped. This engine holds conversations in memory: after a restart, a stage
  that cannot resume is started again from the top, which costs one attempt and is
  correct. The board does not lose anything — the record of what happened is its own.
- **No subagents, no plugins, no ToolSearch, no file checkpointing.** Those are Claude
  Code, not the wire.
- **The tools are plainer.** `Read`, `Write`, `Edit`, `Grep`, `Glob`, `Bash`, `Skill`,
  and the workbench's own `map` and `where` — the ones the stages actually use, under the
  same names, behind the same guard. `Grep` here does not read `.gitignore`.
- **A preset system prompt is not translated.** If something asks for Claude Code's own
  brief, the engine says where it is standing and leaves it there, rather than
  paraphrasing another vendor's instructions to a model that would be worse for it.

What is *not* different: the guard. A tool call goes through the same `PreToolUse` hook a
Claude run goes through — the same allowed lists, the same protected paths, the same
refusal of `git commit` and `git push`, the same capture of a question for you. That is
deliberate: a second engine written with its own idea of what is allowed would be a way
to turn the safety off by changing a config file.

## When the native engine is not enough

`anthropic-gateway` keeps the shipped CLI — every tool, every skill, sessions that
survive a restart — and only changes where it points:

```
WB_PROVIDER=anthropic-gateway WB_BASE_URL=http://127.0.0.1:4000 WB_API_KEY=... wb serve
```

Anything in front that answers the Anthropic Messages wire works, LiteLLM and
claude-code-router both being built for exactly this. It is the route to take when a
model needs a tool this engine does not have, and it costs no code at all.

## Trying any of it without a model

`WB_RUNNER=fake` needs no provider, no key and no server: a scripted agent that does real
work on disk — worktrees, commits, diffs — so you can see how the board moves. It is the
thing to run first, whatever model you end up using.
