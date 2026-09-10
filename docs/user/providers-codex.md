# Codex

For one account, use the default Codex provider with your normal Codex login.
[Provider setup](./install.md#providers) covers installation, Settings > Providers,
and custom binaries or environment variables.

## Use multiple accounts

In **Settings > Providers > Subscription accounts**, select **Add Codex subscription**,
enter a distinct name, and choose a main account if you have more than one.
Sign in to the new account using the displayed device code. Enable device code
authorization in that account's **ChatGPT > Settings > Security** first; the
information icon beside **Sign in** explains the steps. T3 Code prepares its private login
directory and shares conversation storage with the main account. The accounts
and credentials belong to the connected environment, including when you connect
remotely.

New accounts become substitutes for the selected main account. Reorder them,
change the main account, or remove an account from the substitute list in the
same section. A confirmed usage limit switches to the next available account
with the same model and saved conversation. Network errors do not trigger a
switch. When every substitute is exhausted or unavailable, the task stops with
its conversation saved. The activity log records each switch or skipped account.

The following manual setup remains available for existing account directories.

A shared Codex home with a shadow home lets work and personal accounts continue
the same threads. The accounts share Codex sessions and configuration while keeping
their own login and available models.

Keep your first account in `~/.codex`. On the environment's machine, sign the
second account into a fresh directory:

```bash
mkdir -p ~/.codex_personal
CODEX_HOME=~/.codex_personal codex login
```

Then add a second Codex instance in **Settings > Providers**:

| Instance       | CODEX_HOME path | Shadow home path    |
| -------------- | --------------- | ------------------- |
| Codex Work     | `~/.codex`      | Leave empty         |
| Codex Personal | `~/.codex`      | `~/.codex_personal` |

Both instances must use the same **CODEX_HOME path**. T3 Code prepares the shared
state in the shadow directory; do not populate it by copying your whole Codex
home.

The shadow account needs its own `auth.json` file. If Codex uses an OS credential
store, configure file storage for this setup. See
[OpenAI's credential storage guide](https://learn.chatgpt.com/docs/auth#credential-storage).

Use a completely separate **CODEX_HOME path**, with no shadow home, when you want
separate Codex sessions and configuration. That instance cannot continue threads
from the other home.

## Switch accounts in an existing thread

Choose the other account from the thread's model picker. T3 Code offers compatible
Codex instances that share the thread's **CODEX_HOME path**. Changing accounts does
not move the conversation into a separate Codex home.

If the account is missing from the picker, compare the home paths in provider
settings. If two instances show the same unexpected account or models, check their
reported accounts, refresh provider status, and confirm the second instance has
its own shadow path and login. A shadow-home conflict usually means the directory
contains a copied Codex setup. Use a fresh shadow directory and sign in again.

## Use a subscription as the orchestrator

Choose the account and model in the chat's model picker. Open **Working accounts**
next to it to choose how that thread runs:

- **Same account and model** (the default): the selected model plans, builds, and
  verifies in the same conversation. T3 changes accounts automatically only when
  that model reaches a usage limit, following the configured substitute order.
- **Separate worker accounts**: the selected chat model orchestrates. Select which
  accounts it may assign development work to. It chooses available models for those
  workers, reads their results, and integrates the work. Workers share the project's
  working directory. Each worker uses its own account's configured usage-limit fallback.

For Codex-only work, choose a Codex chat model and either use **Same account and model**
or select only Codex worker accounts. Selecting Claude for orchestration and Codex
workers keeps their conversations separate while the orchestrator coordinates results.
The orchestrator decides when delegation is useful; it does not send every task to
all selected accounts.

These choices belong to the thread and are available on web, desktop, and mobile.
Change them between turns. Your conversation stays intact when changing the working
mode. Existing threads default to **Same account and model**; the former project and
global orchestrator settings no longer control delegation.
Manage subscription sign-in and substitute order in **Settings → Providers**.
Substitutes retain the selected model and native conversation; automatic fallback
never switches between Codex and Claude.

## Answer questions while Codex works

Codex can ask a question and keep working. Answer it in the thread's question
panel. The answer becomes a new message: it reaches the active turn, or starts
another turn if Codex has finished. Unanswered questions survive reconnects.
If you do not want to answer, dismiss the question from its panel. Dismissing
closes it without sending anything to Codex. This requires a Codex version that
supports async questions.

## Approve app access

Codex tools can request access to another app. Respond to the named app's request
in the thread on web, desktop, or mobile. Some tools offer access for one request,
the current session, or permanently. See [Permission modes](./permission-modes.md)
for command and file approvals.

## Codex says I hit a usage limit

When Codex stops on a usage limit, the thread names the window that ran out and
when it resets, when Codex reports them. Send the message again after the reset. On a workspace plan the
message also says whether your workspace owner needs to add credits or raise the
spend limit to continue sooner.

## Send feedback to OpenAI

In an existing Codex thread, send `/feedback` with an optional description, for
example `/feedback The agent stopped before finishing the tests`. This uploads
the conversation and Codex logs to OpenAI. The returned thread ID can be shared
with OpenAI support.
