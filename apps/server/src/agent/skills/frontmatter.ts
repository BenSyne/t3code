/**
 * Reading the header of a `SKILL.md`.
 *
 * A skill is a markdown file whose YAML frontmatter names it and says when to
 * use it. Only two fields are read — `name` and `description` — so this is a
 * two-field reader rather than a YAML parser, which keeps a dependency out and
 * makes the failure modes obvious.
 *
 * Nothing here throws. A malformed skill file is dropped with a reason; one
 * user's broken skill must not stop a turn from starting.
 *
 * @module agent/skills/frontmatter
 */

export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
}

export type FrontmatterResult =
  | { readonly _tag: "Parsed"; readonly frontmatter: SkillFrontmatter; readonly body: string }
  | { readonly _tag: "Invalid"; readonly reason: string };

/**
 * Split a `SKILL.md` into its header and its body.
 *
 * `description` is required, not optional: it is the only thing the model sees
 * before deciding whether to open the skill, so a skill without one can never
 * be chosen and is better reported than silently listed.
 */
export function parseSkillFile(content: string): FrontmatterResult {
  const normalised = content.replace(/^﻿/, "");
  if (!normalised.startsWith("---")) {
    return { _tag: "Invalid", reason: "missing frontmatter" };
  }

  const end = normalised.indexOf("\n---", 3);
  if (end === -1) {
    return { _tag: "Invalid", reason: "frontmatter is not closed" };
  }

  const header = normalised.slice(3, end);
  const body = normalised.slice(end + 4).replace(/^\r?\n/, "");

  const name = readField(header, "name");
  const description = readField(header, "description");

  if (name === null) {
    return { _tag: "Invalid", reason: "no name" };
  }
  if (description === null) {
    return { _tag: "Invalid", reason: "no description" };
  }

  return { _tag: "Parsed", frontmatter: { name, description }, body };
}

/**
 * Read one `key: value` line.
 *
 * Handles the three shapes that actually appear in these files: bare, single
 * quoted, and double quoted. A multi-line YAML block is not supported and is
 * reported as missing rather than mis-read.
 */
function readField(header: string, key: string): string | null {
  for (const line of header.split("\n")) {
    const match = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`).exec(line);
    if (match === null) {
      continue;
    }
    const raw = (match[1] ?? "").trim();
    if (raw === "" || raw === "|" || raw === ">") {
      return null;
    }
    return unquote(raw);
  }
  return null;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
