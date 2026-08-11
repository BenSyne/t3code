/**
 * Directories worth never walking into.
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

/** Should this path be skipped? */
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
