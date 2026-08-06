// Normalize paths for comparison: trim trailing separators and ignore case
// (filesystems on Windows are case-insensitive).
export function normalizePath(path: string): string {
  return path.replace(/[\\/]+$/, '').toLowerCase();
}

export function buildIgnoredSet(ignoreDirectories: string[]): Set<string> {
  return new Set(ignoreDirectories.map(normalizePath));
}

export function isIgnored(path: string, ignored: Set<string>): boolean {
  return ignored.has(normalizePath(path));
}
