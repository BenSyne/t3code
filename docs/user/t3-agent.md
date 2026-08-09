# Theo

Theo is the coding agent built into T3 Code. Unlike the other providers, there is nothing to
install — you give it an API key and it works.

## Setting it up

1. Open **Settings → Providers** and add a **Theo** instance.
2. Choose a **Provider**: Anthropic, OpenAI, OpenRouter, or OpenAI-compatible.
3. Set the **API key variable** to the name of an environment variable — `ANTHROPIC_API_KEY`,
   `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, whatever you like.
4. In the **Environment variables** section — just above the config fields — click **Add**, enter
   that variable's name and your key as its value, and tick **sensitive**. Ticking it is what
   routes the value to T3 Code's secret store instead of `settings.json`, and keeps it redacted
   everywhere it would otherwise be displayed or logged.
5. Pick a **Default model**, or leave it blank for the provider's default.

That is the whole setup. Start a thread and pick Theo from the model picker.

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

**Other agents** — can start threads on Codex, Claude, Cursor, Grok, or OpenCode and read what they
produced. Those appear in your sidebar as ordinary threads that you can interrupt or revert.

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
in through their own CLI and T3 Code never sees a raw key. Theo talks to the model API itself,
so it needs the actual key.

The key is stored in T3 Code's secret store with owner-only file permissions, never written to
`settings.json`, never sent to a client, and redacted in logs. It is sent to the model provider you
chose, and to nowhere else. If that trade is not one you want to make, the CLI-based providers
remain available and unchanged.
