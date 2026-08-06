# Per-File Progress in Scanning and Resyncing — Design

Date: 2026-08-06
Status: Approved design (pre-implementation)

## Goal

When the CLI is run interactively, the live progress message shows the current file being examined — its path relative to the scanned/resynced directory — in addition to the directory, for both the **Scanning** and **Resyncing** phases.

Example messages (interactive spinner):

```
Scanning C:\Users\me\Pictures → sub\IMG_1234.jpg
Resyncing C:\Users\me\Pictures → sub\IMG_1234.jpg
```

## Dependencies

None. Uses the existing `reporter.progress()` (already TTY-gated) and `node:path`'s `relative`.

## Approach

Add an optional `onFile` callback to `listFilesRecursive` so the walk can report each file as it is encountered. The Runner passes a callback that formats `dir → relativePath` and calls `reporter.progress()`. For the resync phase no service change is needed — the Runner already iterates DB entries, so it adds a `reporter.progress()` call per entry.

Per-file updates flow only through `reporter.progress()` (spinner-only). When progress is disabled (piped output or `--no-progress`), the callback still runs but `progress()` is a no-op, so captured logs are unchanged — no per-file plain-line spam. Verbose debug output already logs each file.

## 1. file-service change

`listFilesRecursive` gains a trailing optional parameter:

```ts
export async function listFilesRecursive(
  rootDir: string,
  extensions?: string[],
  getHash: boolean = true,
  ignoreDirectories?: string[],
  onFile?: (filePath: string) => void,
): Promise<FileEntry[]>;
```

Inside the walk's `isFile()` branch, call `onFile?.(fullPath)` immediately before `readFileInfo`, so it fires once per file encountered — every file, including those later filtered out by extensions or skipped as unreadable — with the absolute path:

```ts
} else if (entry.isFile()) {
  onFile?.(fullPath);
  try {
    const info = await readFileInfo(fullPath, getHash);
    // ... extension filter, result.push(info)
  } catch {
    // skip files that cannot be read
  }
}
```

The parameter is optional; existing callers and tests are unaffected. `listFilePathsRecursive` is unchanged (resync listing is fast and not per-file).

## 2. Runner scan phase

In `processDirectories`, pass an `onFile` callback to `listFilesRecursive`:

```ts
files = await listFilesRecursive(directory, extensions, true, ignore_directories, (filePath) => {
  this.reporter.progress(`Scanning ${directory} → ${relative(directory, filePath)}`);
});
```

- `relative` is imported from `node:path`.
- The existing `this.reporter.progress(\`Scanning ${directory}\`)` remains as the initial per-directory message; the callback then updates the file part as files are encountered.

## 3. Runner resync phase

In both `resyncDirectories` branches, add a progress update per DB entry, before the per-entry check:

- `checkActualFile=true` (checking actual file existence):

```ts
for (const entry of entries) {
  this.reporter.progress(`Resyncing ${directory} → ${relative(directory, entry.path)}`);
  this.reporter.debug(`Checking file existence: ${entry.path}`);
  const exists = await fileExists(entry.path);
  // ...
}
```

- `checkActualFile=false` (comparing against the current directory listing):

```ts
for (const entry of entries) {
  this.reporter.progress(`Resyncing ${directory} → ${relative(directory, entry.path)}`);
  this.reporter.debug(`Verifying file entry: ${entry.path}`);
  // ...
}
```

The relative path is computed from the entry's stored absolute path.

## 4. Display behavior

- Per-file updates appear only in the interactive spinner (`reporter.progress()` is a no-op when progress is disabled or quiet).
- Piped / `--no-progress`: no per-file lines in output (existing degradation to phase-boundary plain lines is preserved).
- Quiet: unchanged (spinner already suppressed).
- Verbose: debug lines per file remain; the spinner additionally shows the current file.
- No throttling/debouncing — the per-file read/hash dominates cost, and `progress()` updates are cheap.

## 5. Testing

- **file-service**: `onFile` is called once per file encountered with the full absolute path, in encounter order, including nested files and files that do not match the configured extensions; omitting `onFile` still works (existing tests already cover this).
- **runner — scan**: `reporter.progress` is called with the initial `Scanning <dir>` and then with `Scanning <dir> → <relativePath>` for each scanned file.
- **runner — resync, both modes**: `reporter.progress` is called with `Resyncing <dir> → <relativePath>` for each entry checked/verified.

## Out of Scope

- No plain-line per-file output when piped or `--no-progress`.
- No changes to file listing, hashing, extension filtering, or dedup logic.
- No throttling/debouncing of progress updates.
