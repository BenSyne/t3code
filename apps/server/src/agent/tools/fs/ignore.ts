/**
 * Directories worth never walking into.
 *
 * Search tools that descend into `node_modules` are not slow, they are useless:
 * the model gets a thousand hits from dependencies and none from the code it
 * was asked about. This is a deliberately small, boring list of directories
 * that are build output or vendored code in essentially every project.
 *
 * It is not a `.gitignore` parser. Honouring `.gitignore` properly means
 * per-directory files, negations, and precedence rules, and getting it subtly
 * wrong silently hides a file the model needed. A fixed list is worse at
 * tidiness and better at being predictable.
 *
 * @module agent/tools/fs/ignore
 */

/** Matched against a single path segment, not the whole path. */
const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".vite-plus",
  ".cache",
  ".parcel-cache",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".gradle",
  ".idea",
  ".DS_Store",
]);

/**
 * Should this path be skipped?
 *
 * Takes a `/`-separated path relative to the search root and returns true if
 * any segment is an ignored directory, so `a/node_modules/b/c.js` is skipped
 * without the walker having to notice the directory on the way down.
 */
export function isIgnoredPath(relativePath: string): boolean {
  for (const segment of relativePath.split("/")) {
    if (IGNORED_DIRECTORIES.has(segment)) {
      return true;
    }
  }
  return false;
}

/** The set itself, for a caller that walks directories and wants to prune early. */
export function isIgnoredSegment(segment: string): boolean {
  return IGNORED_DIRECTORIES.has(segment);
}
