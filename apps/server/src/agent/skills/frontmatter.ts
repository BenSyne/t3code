/**
 * Reading the header of a `SKILL.md`.
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

/** Split a `SKILL.md` into its header and its body. */
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

/** Read one `key: value` line. */
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
