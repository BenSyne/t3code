# Project settings

Open **Settings → Projects**. The project and machine pickers start at **All projects** and
**All machines**.

Change the default model, workspace, automatic pull, agent browser access, or actions for projects that inherit those values.
Select an individual project to override a default. Reset its row to inherit again. Changing a
default preserves explicit project overrides. Workspace preferences in `t3.json` take precedence
over machine defaults when the project has no explicit workspace override.

Select a machine to limit edits to it. **All machines** writes defaults to connected machines;
offline machines keep their previous values. Mixed values are indicated when selected machines
or checkouts disagree. Browser access changes apply when an agent session next starts.

Project grouping has a client-wide default across machines, with individual checkout overrides.
Shared actions apply to inheriting projects; editing a project's actions creates an independent list.
Reset that list to use shared actions again. Existing project actions are preserved.

Project names, icons, removal, and importing actions from a checkout remain project-specific.
When there are several checkouts, the checkout picker selects which actions and grouping to edit.

## Choose accounts for a project

Open a project's settings from its sidebar menu, or select it in **Settings → Projects**.
Under **Provider accounts**, turn off **Allow all accounts** and select the accounts that
may work on that checkout. Accounts belong to the machine running the project.

For a Codex-only project, select your Codex main and backup accounts and leave Claude
and other providers off. Choose a Codex model for the project's default model and, when
using orchestration, a Codex account and model in **Settings → Providers**.

The account list applies to direct tasks, delegated workers, and automatic substitutes.
Fallback follows the order configured in Providers and skips accounts excluded here.
Changing the list keeps existing history and takes effect on the next turn. A task on
an excluded account cannot continue until that account is allowed again. New accounts
must be explicitly added to a restricted project. Turn **Allow all accounts** back on
to remove the restriction. Connected mobile clients follow the same account list;
edit the list from web or desktop.

The orchestrator decides whether a task benefits from delegation. It lists allowed
accounts, starts bounded worker tasks, reads their results, and integrates the work.
It does not send every task to every provider. Choosing one provider for all allowed
accounts keeps both the orchestrator and its workers on that provider. Workers share
the project's working directory.

## Project icons

Choose an icon, emoji, or image from the project to make it easier to recognize. The choice applies
to selected checkouts in the project group and appears on connected clients. Choose **Automatic** to
let T3 Code detect an icon again.

## Keep the default branch current

Enable **Automatically pull** to keep the default-branch checkout up to date with its configured
upstream.

T3 Code only pulls when it can fast-forward and the checkout has no changed files, untracked files,
or local commits. It skips checkouts on another branch or without an upstream. If a checkout has
local work, resolve it yourself before automatic pulls can resume.
