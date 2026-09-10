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

T3 checks the account identity, not just the plan name. A substitute signed into
the same account is marked **Duplicate subscription** and skipped during automatic
continuation. Select **Use different account** to reconnect it. Accounts whose
identity cannot be verified are also skipped until verification succeeds.

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

Open **Thread models** in the chat and choose the orchestrator account and model,
then select a working mode:

- **Usage-only fallback** (the default): the orchestrator plans, builds, and verifies
  in one conversation. T3 switches only after the provider confirms a usage limit
  for that model. Choose which configured backups may take over in this thread.
- **Parallel team**: choose one or more models under each worker account. The
  orchestrator can start independent workers concurrently, read their results,
  and integrate the work. Only the selected account and model pairs may receive
  assignments. Workers share the project's files, so the orchestrator must keep
  edits separate and review the combined result. Parallel work is not always faster.

Backups remain reserves in either mode: they take over only at a usage limit,
using the same model and saved conversation. Unchecked backups are excluded from
this thread and workers it starts. Configure subscription sign-in and backup order
in **Settings → Providers**. Automatic fallback never switches between Codex and Claude.

For Codex-only work, choose a Codex orchestrator and only Codex workers and backups.
You can also choose a Claude orchestrator with Codex workers. Each worker has its
own conversation; the orchestrator supplies its task and reviews its result. It
chooses when delegation is useful, rather than sending every task to every model.

These choices belong to the thread. Change them between turns; switching work mode
keeps the conversation. Web and desktop combine the choices in **Thread models**;
on mobile, choose the orchestrator in model settings and workers in **Thread models**.
Older threads retain their existing account selections until you choose specific
models. Project and global orchestrator settings do not control delegation.

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
