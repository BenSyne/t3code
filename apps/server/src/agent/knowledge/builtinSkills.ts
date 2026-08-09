/**
 * What the agent knows about T3 Code itself.
 *
 * Without this the agent is a competent coding assistant that happens to run
 * inside T3 Code and knows nothing about it — ask it "how do I point Codex at a
 * different model" and it guesses, or greps a filesystem that has no answer,
 * because the app's own documentation is not in the project it is working on.
 *
 * These are written for the agent, not lifted from the user guide. A human
 * reading a docs page wants prose and screenshots; the agent needs the concept,
 * the exact place a thing lives, and the failure it will otherwise walk into.
 *
 * They ride the skill mechanism, so they cost one line of context each until the
 * agent decides it needs one. That is what makes it affordable to ship this much
 * — the full text only arrives when a question actually calls for it.
 *
 * @module agent/knowledge/builtinSkills
 */
import type { DiscoveredSkill } from "../skills/discover.ts";

interface BuiltinSkill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

const SKILLS: ReadonlyArray<BuiltinSkill> = [
  {
    name: "t3-providers",
    description:
      "How T3 Code's providers and provider instances work — adding one, keys, models, and why a provider shows as unavailable. Use for any question about setting up or fixing a coding agent in T3 Code.",
    body: `# Providers in T3 Code

A **provider** is a coding agent T3 Code can run. Six ship built in: Codex, Claude,
Cursor, Grok, OpenCode, and T3 Agent (this one).

A **provider instance** is one configured copy of a provider. You can have several
of the same kind — say two Codex installs pointed at different accounts — each with
its own id, display name, environment, and settings.

## Adding one

Settings → Providers → the **+** button ("Add provider instance"). Three steps:
choose the driver, give it a label and instance id, then fill in its config.

## The five CLI-based providers

Codex, Claude, Cursor, Grok, and OpenCode each wrap that agent's own command-line
tool running as a subprocess. They need the CLI installed and logged in through
its own login flow. T3 Code never sees a raw API key for these — the CLI holds
its own credentials.

Common failure: **"Not found - <name> CLI is not installed or not on PATH."** The
binary is missing, or the server's PATH does not include it. Point the instance's
\`binaryPath\` setting at the executable, or install it where the server can see it.

## T3 Agent

The odd one out: no CLI, no subprocess. It talks to a model API directly, so it
needs an actual API key. Five backends:

| Backend | Use for |
| --- | --- |
| \`anthropic\` | Claude models direct from Anthropic |
| \`openai\` | GPT models direct from OpenAI |
| \`openrouter\` | Almost any model, one key — model ids look like \`vendor/model\` |
| \`cerebras\` | Open-weight models at very high speed, on a fixed endpoint |
| \`openai-compat\` | Ollama, LM Studio, vLLM, LiteLLM, any OpenAI-shaped endpoint |

Choose \`openai-compat\` and set **Base URL** for local inference. No key is needed
there — leave the value blank and the instance still reports ready.

Cerebras needs a real key but no Base URL: its endpoint is fixed, and anything
typed there is ignored. Its models are \`zai-glm-4.7\`, \`gpt-oss-120b\`, and
\`gemma-4-31b\`.

## Where the key goes

Settings → Providers → expand the instance → **Environment variables** → **Add**.
Set the name (e.g. \`OPENROUTER_API_KEY\`), paste the value, and **tick "sensitive"**.
Ticking it is what routes the value into the secret store instead of settings.json.

The **API key variable** field below only names the variable. Setting it without
adding the matching environment variable leaves the instance unauthenticated.

## Model ids differ by backend

An OpenRouter instance wants \`anthropic/claude-sonnet-5\`, not \`claude-sonnet-5\`.
Using the bare slug returns a model-not-found error. The picker lists what the
chosen backend actually accepts.`,
  },
  {
    name: "t3-threads-and-checkpoints",
    description:
      "Threads, turns, checkpoints, and reverting work in T3 Code. Use when asked how to undo something, recover earlier work, or understand what a thread is.",
    body: `# Threads, turns, and checkpoints

A **thread** is one conversation with one provider instance, inside one project.
A **turn** is one exchange: your message, everything the agent does in response,
and its reply.

## Checkpoints

T3 Code takes a checkpoint of the working tree **per turn**, stored as hidden git
refs. This is what makes an agent's work reversible: you can send it off, dislike
the result, and put the files back exactly as they were.

Reverting to a checkpoint restores the **files**. It does not un-say the
conversation — the transcript stays, which is usually what you want, because the
agent can then be told what was wrong with the attempt.

Because checkpoints are git refs, they are local to the repository and do not
appear in \`git log\` or get pushed.

## Runtime modes

Each thread runs in one of four modes, changeable per thread:

| Mode | Reads | Edits | Commands |
| --- | --- | --- | --- |
| \`approval-required\` | runs | asks | asks |
| \`auto-accept-edits\` | runs | runs | asks |
| \`auto\` | runs | runs | runs, except destructive ones |
| \`full-access\` | runs | runs | runs |

In \`auto\`, a command that looks destructive — \`rm\`, \`sudo\`, a force push, or a
download piped into a shell — still asks. Only \`full-access\` turns that off.

## Worktrees

A thread can run in its own git worktree instead of the main checkout, so an agent
working on a branch does not disturb what you have open. Set it when creating the
thread, via the branch control near the composer.`,
  },
  {
    name: "t3-agent-capabilities",
    description:
      "What the T3 Agent provider can and cannot do — its tools, MCP servers, skills, sub-agents, and how long conversations are handled. Use when asked what this agent is capable of or how to extend it.",
    body: `# T3 Agent capabilities

## Tools

- \`read\`, \`write\`, \`edit\` — files, confined to the project directory
- \`glob\`, \`grep\` — find files by name or contents, skipping build output
- \`bash\` — run a command, with a timeout and bounded output
- \`skill\` — load a skill's full instructions on demand
- \`task\` — hand a self-contained job to a fresh sub-agent

With "Let this agent run other agents" turned on, seven more appear:
\`list_providers\`, \`list_projects\`, \`list_threads\`, \`delegate_to_agent\`,
\`read_delegated_thread\`, \`stop_delegated_thread\`, \`revert_delegated_thread\`.
\`list_threads\` covers every thread in a project, not only ones you started, so
you can read what another agent is doing right now.

Every file path is checked twice: once as text, once against where it really
points. A symlink inside the project that resolves outside it is refused.

## MCP servers

Add them under the instance's \`mcpServers\` setting, in the same shape other agents
use. Local **stdio** servers work; remote HTTP servers are not supported yet.

Their tools appear namespaced \`mcp__<server>__<tool>\`. Core tools are resolved
first, so an MCP server cannot take the name \`read\` or \`bash\`.

A server that fails to start costs its own tools and produces a warning. It never
takes the turn down.

## Skills

A \`SKILL.md\` file with \`name\` and \`description\` in its frontmatter, under
\`.claude/skills\`, \`.opencode/skills\`, \`.t3/skills\`, or \`skills\` — in the project or
in your home directory. Project beats global on a name clash.

Only the name and description go into the prompt; the body loads when the agent
calls \`skill\`. **A skill with no \`description\` is skipped** — that field is all the
agent has to choose by.

## Sub-agents

\`task\` runs a fresh agent on one job and returns a summary. Useful when a search
would otherwise fill the conversation with files that turned out not to matter.
Nesting is capped at two levels.

## Long conversations

When the conversation approaches the model's context limit, the earlier part is
replaced with a summary and the recent messages are kept verbatim. You will see a
note when it happens. If the summary fails, the turn continues uncompacted rather
than failing.`,
  },
  {
    name: "t3-choosing-an-agent",
    description:
      "Which coding agent and model to delegate a task to, and how hard to make it think. Use before delegate_to_agent, or when the user asks which agent or model is best for something.",
    body: `# Choosing an agent

Read this as a starting point, not a ranking. Two things below are facts you
can check; the rest is a summary of how these tools were understood in
**August 2026**, and model releases have been about six weeks apart. Where the
call is close and the work is expensive, say what you would pick and why, then
ask — a wrong routing decision costs the user real money and a whole run.

## Check the facts first

\`list_providers\` reports two things worth more than any general claim:

**\`billing\`** — \`subscription\` means the user has already paid for that
agent's capacity, so a delegation costs nothing extra. \`per-token\` means every
delegation adds to a bill. When two agents would both do the job, this decides
it, and it is the single most common reason to prefer one.

**\`available\`** — an agent that is not authenticated or not installed is not a
choice, however well suited it would be.

Neither is guesswork. Prefer them over anything in the next section.

## What each one is

| Agent | What it is |
| --- | --- |
| **Codex** | OpenAI's CLI. Fast, decisive, token-efficient. Proceeds on reasonable assumptions rather than stopping to ask. |
| **Claude** | Anthropic's CLI. Stronger on planning, ambiguity, and repository-scale work; larger default context. |
| **Cursor** | Cursor's agent. Editor-native; useful where its own indexing helps. |
| **Grok** | xAI's CLI. |
| **OpenCode** | An aggregator — one CLI in front of many upstream models, so what it is good at depends on which model it is pointed at. |
| **T3 Agent** | Yourself. You cannot delegate to another T3 Agent. |

## Rough heuristics

- **Ambiguous, design-heavy, or spanning many files** — Claude. Its advantage
  is deciding *what* to do, and it is more willing to plan before acting.
- **Well-specified and self-contained** — Codex. When the task already says
  exactly what to change, its speed is the whole benefit and the planning
  advantage is not in play.
- **Second opinion on a hard call** — send the same question to two, then
  report where they disagree. Disagreement is usually the interesting part.
- **Mechanical and repetitive** — cheapest available agent at a low reasoning
  level. Effort spent on a rename is effort wasted.

## Reasoning effort

\`delegate_to_agent\` takes \`reasoningEffort\`: \`none\` through \`max\`. It
costs time and money roughly in proportion.

- **none / minimal** — mechanical edits, renames, formatting, "apply this diff"
- **low** — small well-specified changes
- **medium** — ordinary feature work; a sensible default when unsure
- **high** — debugging something you do not understand, design decisions
- **xhigh / max** — genuinely hard problems where a wrong answer is expensive

Raising effort on a task that was never hard buys nothing. Lowering it on a
subtle bug wastes the whole delegation.

## Say what you did

After delegating, tell the user which agent and effort you chose and why —
especially when it was \`per-token\`. They are paying for it, and a choice they
can see is a choice they can correct.`,
  },
  {
    name: "t3-troubleshooting",
    description:
      "Diagnosing common T3 Code problems: unavailable providers, unauthenticated instances, missing models, failing turns. Use when something is not working and the cause is not obvious.",
    body: `# Troubleshooting T3 Code

Work from the status line in Settings → Providers. Its wording names the cause.

## "Not authenticated - Set X on this instance"

The instance knows which variable holds its key but that variable has no value.
Expand the instance → **Environment variables** → **Add** → name it exactly as
shown, paste the value, tick **sensitive**.

## "Not found - <name> CLI is not installed or not on PATH"

A CLI-based provider whose binary the server cannot see. Either install it, or set
that instance's \`binaryPath\` to the executable. Remember the server's PATH may
differ from your shell's, especially when it runs as a background service.

## "Unavailable - ... failed to run" / "Timed out"

The binary exists but did not answer. Run it once yourself in a terminal — it is
usually waiting on a login or a first-run prompt.

## The model picker shows the wrong models

For T3 Agent, the list follows the instance's **backend**. An OpenRouter instance
lists \`vendor/model\` ids; an Anthropic one lists bare slugs. If the model you want
is missing, type it into **Default model** — it will appear.

## A turn fails immediately with a model error

Usually a model id in the wrong shape for the backend. \`claude-sonnet-5\` works on
Anthropic; OpenRouter needs \`anthropic/claude-sonnet-5\`.

## A skill is not being offered

Its frontmatter is missing \`name\` or \`description\`, or the file is not called
\`SKILL.md\`. The Work Log for the turn says which file was skipped and why.

## Undoing what an agent did

Revert to the checkpoint from before that turn. Files go back; the conversation
stays, so you can tell the agent what went wrong.`,
  },
];

/**
 * Built-in knowledge as skills.
 *
 * `location` is a marker rather than a path — nothing reads these from disk,
 * because they are compiled in and must work in a packaged build where the
 * repository's docs directory does not exist.
 */
export const BUILTIN_SKILLS: ReadonlyArray<DiscoveredSkill> = SKILLS.map((skill) => ({
  name: skill.name,
  description: skill.description,
  location: `<built-in>/${skill.name}`,
  scope: "global",
  body: skill.body,
}));
