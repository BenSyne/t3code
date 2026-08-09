# T3 Code — Agent Build

> **An unofficial fork of [pingdotgg/t3code](https://github.com/pingdotgg/t3code).** Not affiliated
> with or endorsed by T3 Tools. Built from upstream `89c320df` (8 Aug 2026, v0.0.32) — everything
> below this banner is their work and their words.
>
> Their README says it better than I could: _"If we ever go the wrong direction, we want you to have
> everything you need to fork and build the editor that you want."_ This isn't a wrong direction. It's
> one gap, filled.

T3 Code is a genuinely excellent control surface for the agents you already have — Codex, Claude,
Cursor, Grok, OpenCode. The gap I kept running into is that it had no agent of **its own**.

So this build adds one.

**It's a real coding agent.** Reads, writes, globs, greps, runs commands, obeys the thread's runtime
mode and approval prompts, picks up your `AGENTS.md` / `CLAUDE.md`, loads skills, connects MCP
servers, spawns sub-agents, and checkpoints every turn like any other provider. One OpenRouter key
points it at almost any model — or bring Anthropic, OpenAI, or Cerebras directly, or run it fully
local against Ollama, LM Studio, or anything that speaks the OpenAI API.

**And it runs your other agents.** This is the part that changes how the app feels.

It can see which providers you have set up, whether each one bills per token or draws on a
subscription you've already paid for, and exactly which models each can be pointed at. Then it can
start work on them — choosing the provider, the model, and how hard to think, per task — read back
what they actually _did_ rather than what they claimed, send corrections into the same thread, and
settle or archive the results when they're done.

Which means you can deploy and supervise a swarm across providers **from a single chat**, instead of
clicking through the sidebar thread by thread.

## Try it

Same as upstream — see [Installation](#installation) below — then open **Settings → Providers → +**
and add the built-in agent. It defaults to OpenRouter; drop your key in the Environment variables
section marked **sensitive** and you're running.

Full guide: **[docs/user/t3-agent.md](./docs/user/t3-agent.md)**

## What it won't do

Stated plainly, because finding out later is worse:

- **Nothing pings it when a delegated thread finishes.** It reads them back when you next ask. There
  is no background watcher, and it will tell you so rather than promising to keep an eye on things.
- **It can't delete anything** — not threads, not projects. Deletion is the one action with no undo.
- **It can't change what another thread is allowed to do**, so it can never widen its own reach by
  raising a delegate's permissions.
- **It won't answer approval prompts for you** unless you turn that on separately. Approvals are how
  you stay in the loop.
- Delegating spends the **target** provider's credits — nothing per turn on a subscription, real
  money on an API key. It's capped at four delegated threads at once.

---

_Everything from here down is upstream's README, unchanged._

# T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, and OpenCode. If they're set up on your computer, T3 Code can control them.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build and OpenCode. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Try it out (install-free)

The easiest way to test T3 Code is to run the server in your terminal (requires Node.js 22.16+, 23.11+, or 24.10+):

```bash
npx t3@latest
```

This will launch T3 Code's backend on your machine as well as the local web app to control your agents.

Tip: Use `npx t3@latest --help` for the full CLI reference.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Arch Linux (AUR)

```bash
yay -S t3code-bin
```

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- Linux: [run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
