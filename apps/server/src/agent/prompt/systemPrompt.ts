/**
 * What the agent is told before it is told anything else.
 *
 * Kept short on purpose. A long system prompt is charged on every request of
 * every step of every turn, and past a certain length models follow it *less*,
 * not more. Everything here earns its place by changing behaviour we have a
 * reason to want changed.
 *
 * Model-specific coaching deliberately stays out. This prompt ships to Claude,
 * GPT, Gemini, Kimi, DeepSeek, and whatever the user points at a local port, and
 * instructions tuned to one of them are noise to the rest.
 *
 * @module agent/prompt/systemPrompt
 */

export interface SystemPromptInput {
  readonly workspaceRoot: string;
  /** Project instructions, already read and concatenated. Empty if there are none. */
  readonly projectContext: string;
  /** Names of the tools actually available this turn. */
  readonly toolNames: ReadonlyArray<string>;
  /** One line per available skill. Empty when the project has none. */
  readonly skillCatalog?: string | undefined;
}

const BASE = `You are the built-in coding agent in T3 Code, working in a real repository on the user's machine.

Work like a careful engineer:
- Read before you write. Never edit a file you have not looked at in this session.
- Make the smallest change that does the job. Do not reformat or refactor code you were not asked to touch.
- Prefer the glob and grep tools over shell equivalents; they are faster and skip build output.
- After changing code, run the project's own tests or type checks if you can find them.
- If a tool fails, read the error and adapt. Do not repeat the identical call.

Be honest about what happened:
- If you could not finish, say what is left and why.
- If you are unsure whether a change is correct, say so rather than asserting it.
- Never claim to have run something you did not run.

Keep replies short. The user is reading them on a phone as often as a desktop.`;

/**
 * Assemble the prompt.
 *
 * Order matters: the fixed instructions first, the user's project instructions
 * after, so a project can add to the defaults and — where it disagrees — win by
 * being the last thing read.
 */
export function buildSystemPrompt(input: SystemPromptInput): string {
  const sections = [BASE, `Working directory: ${input.workspaceRoot}`];

  if (input.toolNames.length > 0) {
    sections.push(`Available tools: ${input.toolNames.join(", ")}.`);
  }

  if (input.skillCatalog !== undefined && input.skillCatalog.trim() !== "") {
    sections.push(input.skillCatalog);
  }

  if (input.projectContext.trim() !== "") {
    sections.push(
      `Project instructions follow. They come from this repository and take precedence over the general guidance above.\n\n${input.projectContext.trim()}`,
    );
  }

  return sections.join("\n\n");
}
