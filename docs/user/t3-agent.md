# T3 Orchestrator

T3 Orchestrator is the coding agent built into T3 Code. Unlike the other providers, there is nothing to
install — you give it an API key and it works.

## Setting it up

It is already in the model picker. Pick **T3 Orchestrator** and the composer asks for an
[OpenRouter key](https://openrouter.ai/keys); paste it and press **Connect**. The key is checked
against OpenRouter before it is saved, so a typo tells you immediately rather than killing your
first message.

That is the whole setup. If you would rather use a different provider, or you already have a key in
your environment, everything below still works.

### Setting it up by hand

1. Open **Settings → Providers** and select the **T3 Orchestrator** instance (or add another).
2. Choose a **Provider**: Anthropic, OpenAI, OpenRouter, Cerebras, or OpenAI-compatible.
3. Set the **API key variable** to the name of an environment variable — `ANTHROPIC_API_KEY`,
   `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, whatever you like.
4. In the **Environment variables** section — just above the config fields — click **Add**, enter
   that variable's name and your key as its value, and tick **sensitive**. Ticking it is what
   routes the value to T3 Code's secret store instead of `settings.json`, and keeps it redacted
   everywhere it would otherwise be displayed or logged.
5. Pick a **Default model**, or leave it blank for the provider's default.

Start a thread and pick T3 Orchestrator from the model picker.

### How hard it thinks

Models that support it get a **Reasoning** control next to the model in the picker, from `none`
through `max`. It costs time and money roughly in proportion, so raise it for design and debugging
and drop it for mechanical work. **Default** leaves the choice to the provider, which is not the
same as off — some models reason unless told not to.

Only the levels a given model actually accepts are offered, so the list changes as you switch
models. A model with no reasoning control shows none.

### What a conversation costs

On the Anthropic backend, the growing conversation is marked for prompt caching, so each turn
re-bills the repeated prefix at cache rates rather than full price — on a long thread that is
most of the bill. OpenAI applies its caching automatically. A dropped connection or a rate limit
is retried quietly with backoff rather than failing your turn; you pay for requests that ran, not
for the retry logic.

### Running against a local model

Choose **OpenAI-compatible** and set the **Base URL** to your server:

| Server    | Base URL                    |
| --------- | --------------------------- |
| Ollama    | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1`  |
| vLLM      | `http://localhost:8000/v1`  |

No API key is required for a local server — leave the value blank and the instance still reports as
ready. Set the **Default model** to whatever your server has loaded, for example `qwen3-coder`.

Anything that speaks the OpenAI wire format works, including gateways like LiteLLM and providers
this list has never heard of.

## What it can do

**Files and search** — read, write, edit, glob, and grep, all confined to the project directory.

**Commands** — run builds, tests, and git through a shell, with a timeout and bounded output.

**The web** — fetch a URL you point it at and read it as text. Fetches go through the same
approval flow as commands, with the URL as what you are asked about.

**A visible plan** — on multi-step work it keeps a checklist in the timeline, ticking steps off
as they finish, so a long task reads as progress instead of silence.

**Project instructions** — reads `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, and
`.github/copilot-instructions.md` from the repository root, so rules you already wrote apply here
without being rewritten.

**Skills** — picks up `SKILL.md` files under `.claude/skills`, `.opencode/skills`, `.t3/skills`, or
`skills`, and under the same paths in your home directory. Only each skill's name and description
sit in the prompt; the full text loads when the agent decides to use it.

**MCP servers** — add them under the instance's `mcpServers` setting, in the same shape other agents
use. Local (stdio) servers are supported; remote HTTP servers are not yet.

**Sub-agents** — can hand a self-contained job to a fresh agent and get back a summary, which keeps
a long search from filling the main conversation.

**Other agents** — see below. On by default.

## Running your other agents

T3 Orchestrator can drive the rest of T3 Code on your behalf: start work on Codex, Claude, Cursor, Grok or
OpenCode, follow it, and tidy up after it. This is on out of the box.

Worth knowing what that spends. A delegation runs on whatever key the _target_ provider holds — for
a CLI signed in to a subscription that is nothing extra per turn, and for a provider holding an API
key it is real money. Turn off **Let this agent run other agents** in the instance's settings if you
would rather it never did that; the tools disappear from its prompt entirely rather than being
offered and refused.

It can:

- **See what is available** — which agents are set up, whether each one bills per token or draws on
  a subscription you have already paid for, and which models each can be pointed at.
- **Delegate** — start a thread with a task, choosing the agent, the model, and how hard to think.
  From a phone: "review this PR with Codex and Claude in parallel and tell me where they disagree."
- **Follow the work** — read a thread back, including what it actually did and anything that failed,
  not just what it said about itself.
- **Stay with it** — send a follow-up to correct or extend work rather than starting over, answer a
  question a thread is blocked on, or interrupt and revert. This applies to any thread in the
  project, not only ones it started itself.
- **Tidy up** — settle, archive, snooze, pin or rename threads, and create a project for a
  directory.

Everything it starts is an ordinary thread. It appears in your sidebar, streams live, and you can
interrupt, revert, or take it over at any point.

Delegated threads run in **full access**, the same mode new threads use by default. Nobody is
watching an unattended delegation to answer a permission prompt, so a mode that raises one would
simply hang. If that is more rope than you want a delegate to have, turn orchestration off — or
change the thread's runtime mode yourself once it exists.

Two things it will not do. It cannot **delete** anything — threads or projects — because deletion
is the one action with no undo behind it. And it cannot change another thread's **runtime mode**, so
it can never widen what some other agent is allowed to do.

Answering **approval prompts** on your behalf is separate, off, and behind its own setting. Approval
is how you stay in the loop; leaving it off means T3 Orchestrator tells you what is waiting instead of deciding
for you. Answering a _question_ a thread asked is different and allowed, but only on threads T3 Orchestrator
started itself — it will not put words in your mouth in a conversation it was never part of.

Each thread it starts gets its own **git worktree and branch**, the same isolation you get from the
branch control, so a fan-out cannot have two agents overwriting each other's files. It tells you the
branch when it delegates; the work is not in your checkout until you merge it.

Worth knowing: a worktree starts from the current commit, so uncommitted changes in your own checkout
are not in it. If you want a delegate working on something you have in progress, commit it first —
or ask for the work to run in your directory instead.

Isolation is a default, not a rule you have to argue with. Tell it not to use worktrees and it will
say once what that risks and then do as you asked, including for parallel work. It is your
repository.

There is no cap on how many delegations run at once — swarming is the point — so a large fan-out
spends a large amount at once on whatever keys those providers use. It can never delegate to another
T3 Orchestrator instance, though: an agent that can start copies of itself is unbounded recursion rather than a
wide fan-out, and that one does not stop.

## Permissions

The agent obeys the thread's runtime mode, the same one every other provider uses:

| Mode                | Reads | Edits | Commands |
| ------------------- | ----- | ----- | -------- |
| `approval-required` | runs  | asks  | asks     |
| `auto-accept-edits` | runs  | runs  | asks     |
| `auto`              | runs  | runs  | runs\*   |
| `full-access`       | runs  | runs  | runs     |

\* In `auto`, a command that looks destructive still asks — `rm`, `sudo`, a force push, or anything
that downloads a script and pipes it into a shell. Only `full-access` turns that off.

That check is a prompt trigger, not a sandbox. It catches obvious cases and can be worked around by
anything determined to. The real boundaries are the approval prompt and the fact that every file
tool is confined to the project directory, symlinks included.

## Long conversations

When a conversation approaches the model's context limit, the agent summarises the earlier part and
carries on, keeping the recent messages verbatim. You will see a note when this happens. If the
summary cannot be generated, the turn continues on the full conversation rather than failing.

Conversations are written to disk, so a thread survives restarting T3 Code.

## About your API key

Worth being explicit, because this differs from the other providers. Codex, Claude, and the rest log
in through their own CLI and T3 Code never sees a raw key. T3 Orchestrator talks to the model API itself,
so it needs the actual key.

The key is stored in T3 Code's secret store with owner-only file permissions, never written to
`settings.json`, never sent to a client, and redacted in logs. It is sent to the model provider you
chose, and to nowhere else. If that trade is not one you want to make, the CLI-based providers
remain available and unchanged.
