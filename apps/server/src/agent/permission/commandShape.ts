/**
 * Reading a shell command well enough to know if it should be asked about.
 *
 * @module agent/permission/commandShape
 */

export interface CommandShape {
  /** Each program invoked, in order: `a && b | c` yields `["a", "b", "c"]`. */
  readonly programs: ReadonlyArray<string>;
  /** True when output is piped into a shell — the fetch-and-execute shape. */
  readonly pipesIntoShell: boolean;
  /** True when the command writes over a file with `>`. */
  readonly overwritesViaRedirect: boolean;
}

export interface DangerVerdict {
  readonly destructive: boolean;
  /** Shown to the user in the prompt, so it says what specifically looks risky. */
  readonly reason?: string | undefined;
}

const SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh"]);

/** Programs whose whole job is to remove or overwrite things. */
const DESTRUCTIVE_PROGRAMS = new Set(["rm", "rmdir", "shred", "mkfs", "dd", "fdisk", "diskutil"]);

/** Fetchers: harmless alone, the first half of fetch-and-execute. */
const FETCHERS = new Set(["curl", "wget", "fetch"]);

/** Break a command line into the programs it runs. */
export function analyzeCommand(command: string): CommandShape {
  const segments = splitOnOperators(command);
  const programs: Array<string> = [];

  for (const segment of segments) {
    const program = firstWord(segment.text);
    if (program !== null) {
      programs.push(program);
    }
  }

  const pipesIntoShell = segments.some(
    (segment, index) =>
      index > 0 && segment.operator === "|" && SHELLS.has(basename(firstWord(segment.text) ?? "")),
  );

  return {
    programs,
    pipesIntoShell,
    overwritesViaRedirect: /(^|[^\\>])>(?!>)/.test(stripQuoted(command)),
  };
}

/** Does this command deserve a prompt even in an unattended mode? */
export function judgeCommand(command: string): DangerVerdict {
  const shape = analyzeCommand(command);
  const names = shape.programs.map(basename);

  if (shape.pipesIntoShell && names.some((name) => FETCHERS.has(name))) {
    return {
      destructive: true,
      reason: "downloads a script and runs it",
    };
  }

  if (names.includes("sudo") || names.includes("doas")) {
    return { destructive: true, reason: "runs as another user" };
  }

  const destructive = names.find((name) => DESTRUCTIVE_PROGRAMS.has(name));
  if (destructive !== undefined) {
    return { destructive: true, reason: `runs ${destructive}` };
  }

  if (/\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f)/.test(command)) {
    return { destructive: true, reason: "changes git history or the remote" };
  }

  return { destructive: false };
}

interface Segment {
  readonly text: string;
  /** The operator that introduced this segment, or null for the first. */
  readonly operator: "|" | "&&" | "||" | ";" | null;
}

function splitOnOperators(command: string): ReadonlyArray<Segment> {
  const segments: Array<Segment> = [];
  let current = "";
  let operator: Segment["operator"] = null;
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? "";
    const next = command[index + 1] ?? "";

    if (quote !== null) {
      if (character === quote) {
        quote = null;
      }
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }

    if (character === "&" && next === "&") {
      segments.push({ text: current, operator });
      current = "";
      operator = "&&";
      index += 1;
      continue;
    }
    if (character === "|" && next === "|") {
      segments.push({ text: current, operator });
      current = "";
      operator = "||";
      index += 1;
      continue;
    }
    if (character === "|") {
      segments.push({ text: current, operator });
      current = "";
      operator = "|";
      continue;
    }
    if (character === ";") {
      segments.push({ text: current, operator });
      current = "";
      operator = ";";
      continue;
    }

    current += character;
  }

  segments.push({ text: current, operator });
  return segments;
}

/** The program name, skipping leading environment assignments like `FOO=1 cmd`. */
function firstWord(segment: string): string | null {
  for (const word of segment.trim().split(/\s+/)) {
    if (word === "") {
      continue;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) {
      continue;
    }
    return word;
  }
  return null;
}

function basename(program: string): string {
  const parts = program.split("/");
  return parts[parts.length - 1] ?? program;
}

/** Quoted text cannot contain a real redirect, so remove it before looking. */
function stripQuoted(command: string): string {
  return command.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''");
}
