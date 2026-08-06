# Per-File Progress in Scanning and Resyncing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the file currently being examined (path relative to the scanned/resynced directory) in the interactive `Scanning…` / `Resyncing…` progress messages.

**Architecture:** Add an optional `onFile` callback to `listFilesRecursive` so the walk can report each file as it is encountered; the Runner passes a callback that formats `dir → relativePath` and calls `reporter.progress()`. For resync, the Runner already iterates DB entries, so it just adds a `progress()` call per entry — no resync service change.

**Tech Stack:** Node.js 24, TypeScript 7 (strict, NodeNext/CJS), Vitest, oxlint, Prettier. No new dependencies.

**Execution workflow (per user instructions):** Each task is one PR. Per task: create branch → implement (TDD) → `pnpm typecheck && pnpm lint && pnpm test` → commit (Conventional Commits) → push to the `gh` HTTPS remote → open PR → **STOP AND WAIT for review/merge**. Only after the PR is merged: checkout `main`, pull, create the next branch.

## Global Constraints

- Per-file updates flow only through `reporter.progress()` — interactive spinner only. When progress is disabled (piped or `--no-progress`) or quiet, `progress()` is already a no-op, so captured logs are unchanged (no per-file plain lines).
- `onFile` fires once per file encountered, before `readFileInfo`, with the absolute path — including files later filtered out by extensions or skipped as unreadable.
- Message format: `Scanning <dir> → <relPath>` and `Resyncing <dir> → <relPath>`, where `<relPath>` = `node:path` `relative(directory, filePath)`.
- No changes to file listing, hashing, extension filtering, or dedup logic; no throttling/debouncing.
- Coverage threshold stays at 80% (`pnpm test:coverage`). `pnpm format:check` must be clean before each commit.
- Prettier: 2-space indent, single quotes, semicolons, print width 120, trailing commas `all`, arrow parens `always`.
- Commits follow Conventional Commits, one logical change per commit.

---

### Task 1: `onFile` callback on `listFilesRecursive`

Add an optional trailing `onFile?: (filePath: string) => void` parameter to `listFilesRecursive` that is invoked once per file encountered (before reading/hashing), with the absolute path. Purely additive — existing callers (which omit it) are unaffected. This PR also carries the committed design spec (docs commit first), as agreed with the user.

**Files:**

- Modify: `src/services/file-service.ts`
- Test: `src/services/file-service.test.ts`
- Create (commit): `docs/superpowers/specs/2026-08-06-per-file-progress-design.md` — already written; only needs committing.

**Interfaces:**

- Consumes: nothing new.
- Produces (used by Task 2):
  - `listFilesRecursive(rootDir: string, extensions?: string[], getHash?: boolean, ignoreDirectories?: string[], onFile?: (filePath: string) => void): Promise<FileEntry[]>`
  - `onFile` is called with the absolute path of every file encountered, immediately before `readFileInfo`, including files later extension-filtered or skipped as unreadable.

- [ ] **Step 1: Create the branch and commit the design spec**

```bash
git checkout main
git pull gh main
git checkout -b feat/list-files-onfile-callback
git add docs/superpowers/specs/2026-08-06-per-file-progress-design.md
git commit -m "docs: add per-file progress design spec"
```

- [ ] **Step 2: Write the failing test** — append inside the `describe('listFilesRecursive', ...)` block of `src/services/file-service.test.ts`, after the test `'rejects when the root directory cannot be read'`:

```ts
it('calls onFile with the full path of every file encountered', async () => {
  await createFile(rootDir, 'a/photo1.jpg', 'one');
  await createFile(rootDir, 'a/sub/photo2.JPG', 'two');
  await createFile(rootDir, 'notes.txt', 'three');

  const seen: string[] = [];
  await listFilesRecursive(rootDir, ['.jpg'], true, [], (filePath) => {
    seen.push(filePath);
  });

  // notes.txt does not match the .jpg filter but is still encountered
  expect(seen.sort()).toEqual(
    [join(rootDir, 'a', 'photo1.jpg'), join(rootDir, 'a', 'sub', 'photo2.JPG'), join(rootDir, 'notes.txt')].sort(),
  );
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test src/services/file-service.test.ts`
Expected: FAIL — `seen` is empty because the callback is ignored at runtime (the function has no 5th parameter).

- [ ] **Step 4: Write the minimal implementation** — edit `src/services/file-service.ts`:

Change the signature (lines 73-78) to add the trailing parameter:

```ts
export async function listFilesRecursive(
  rootDir: string,
  extensions?: string[],
  getHash: boolean = true,
  ignoreDirectories?: string[],
  onFile?: (filePath: string) => void,
): Promise<FileEntry[]> {
```

In the walk's `isFile()` branch, call `onFile` immediately before `readFileInfo`:

```ts
      } else if (entry.isFile()) {
        onFile?.(fullPath);
        try {
          const info = await readFileInfo(fullPath, getHash);

          if (normalizedExtensions && normalizedExtensions.length > 0) {
            if (!normalizedExtensions.includes(info.extension.toLowerCase())) {
              continue;
            }
          }

          result.push(info);
        } catch {
          // skip files that cannot be read
        }
      }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test src/services/file-service.test.ts`
Expected: PASS — all file-service tests including the new one.

- [ ] **Step 6: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage && pnpm format:check`
Expected: all pass; coverage ≥ 80%.

- [ ] **Step 7: Commit, push, open PR, STOP**

```bash
git add src/services/file-service.ts src/services/file-service.test.ts
git commit -m "feat: add onFile callback to listFilesRecursive"
git push -u gh feat/list-files-onfile-callback
```

Create the PR with `gh pr create --title "feat: add onFile callback to listFilesRecursive" --body-file <file>` (use a body file to avoid shell escaping issues), body:

```
Adds an optional trailing `onFile?: (filePath: string) => void` parameter to `listFilesRecursive` that fires once per file encountered, before reading/hashing, with the absolute path — including files later extension-filtered or skipped as unreadable. This is the foundation for the per-file progress feature (next PR). Also commits the approved design spec. Existing callers are unaffected (optional parameter).

Verification: typecheck, lint, all tests pass, coverage ≥ 80%.
```

**STOP AND WAIT.** Do not start Task 2 until this PR is reviewed and merged. Then run `git checkout main && git pull gh main`.

---

### Task 2: Per-file progress in the scan and resync phases

Wire the `onFile` callback into the Runner's scan phase and add per-entry progress updates to the resync phase, so the spinner shows `Scanning <dir> → <rel>` / `Resyncing <dir> → <rel>`. Also adds one README sentence documenting the behavior.

**Files:**

- Modify: `src/runner.ts`
- Test: `src/runner.test.ts`
- Modify: `README.md`

**Interfaces:**

- Consumes: `listFilesRecursive(..., onFile?)` from Task 1 (the 5th parameter).
- Produces: nothing new; behavior change to the reporter's progress output.

- [ ] **Step 1: Create the branch**

```bash
git checkout main
git pull gh main
git checkout -b feat/per-file-progress
```

- [ ] **Step 2: Write the failing tests** — append three tests to `src/runner.test.ts` inside the `describe('Runner', ...)` block:

```ts
it('updates progress with the current file during scanning', async () => {
  await createFile(rootDir, 'src/sub/a.txt', 'hello');

  const reporter = makeMockReporter();
  const runner = new Runner(makeConfig(dbPath, join(rootDir, 'src')), reporter);
  await runner.run();
  runner.close();

  expect(reporter.progress).toHaveBeenCalledWith(`Scanning ${join(rootDir, 'src')} → ${join('sub', 'a.txt')}`);
});

it('updates progress with the current entry during resync (check actual file)', async () => {
  await createFile(rootDir, 'src/a.txt', 'alpha');

  const runner = new Runner(makeConfig(dbPath, join(rootDir, 'src')), makeMockReporter());
  await runner.run();
  runner.close();

  const resyncConfig: RunConfiguration = {
    ...makeConfig(dbPath, join(rootDir, 'src')),
    process_directories: false,
    resync_directories: true,
    resync_check_actual_file: true,
  };
  const reporter = makeMockReporter();
  const resyncRunner = new Runner(resyncConfig, reporter);
  await resyncRunner.run();
  resyncRunner.close();

  expect(reporter.progress).toHaveBeenCalledWith(`Resyncing ${join(rootDir, 'src')} → ${join('a.txt')}`);
});

it('updates progress with the current entry during resync (directory listing)', async () => {
  await createFile(rootDir, 'src/a.txt', 'alpha');

  const runner = new Runner(makeConfig(dbPath, join(rootDir, 'src')), makeMockReporter());
  await runner.run();
  runner.close();

  const resyncConfig: RunConfiguration = {
    ...makeConfig(dbPath, join(rootDir, 'src')),
    process_directories: false,
    resync_directories: true,
    resync_check_actual_file: false,
  };
  const reporter = makeMockReporter();
  const resyncRunner = new Runner(resyncConfig, reporter);
  await resyncRunner.run();
  resyncRunner.close();

  expect(reporter.progress).toHaveBeenCalledWith(`Resyncing ${join(rootDir, 'src')} → ${join('a.txt')}`);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm test src/runner.test.ts`
Expected: FAIL — all three new tests (`reporter.progress` is not called with the `dir → rel` format).

- [ ] **Step 4: Write the implementation** — edit `src/runner.ts`:

Add the `relative` import at the top:

```ts
import { relative } from 'node:path';
```

In `processDirectories`, pass the `onFile` callback to `listFilesRecursive` (line 107):

```ts
let files: FileEntry[];
try {
  files = await listFilesRecursive(directory, extensions, true, ignore_directories, (filePath) => {
    this.reporter.progress(`Scanning ${directory} → ${relative(directory, filePath)}`);
  });
} catch (err) {
  errors.push(`Scan ${directory}: ${errorMessage(err)}`);
  this.reporter.warn(`Failed to scan directory: ${directory} (${errorMessage(err)})`);
  continue;
}
```

In `resyncDirectories`, add a progress update at the top of each entry loop:

`checkActualFile=true` branch (line 152):

```ts
for (const entry of entries) {
  this.reporter.progress(`Resyncing ${directory} → ${relative(directory, entry.path)}`);
  this.reporter.debug(`Checking file existence: ${entry.path}`);
  const exists = await fileExists(entry.path);
  if (!exists) {
    this.db.deleteFileEntryByPath(entry.path);
    staleRemoved += 1;
  }
}
```

`checkActualFile=false` branch (line 171):

```ts
for (const entry of entries) {
  this.reporter.progress(`Resyncing ${directory} → ${relative(directory, entry.path)}`);
  this.reporter.debug(`Verifying file entry: ${entry.path}`);
  if (!currentPaths.has(normalizePath(entry.path))) {
    this.db.deleteFileEntryByPath(entry.path);
    staleRemoved += 1;
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm test src/runner.test.ts`
Expected: PASS — all runner tests including the three new ones.

- [ ] **Step 6: Update `README.md`** — in the `### Output` section, add a sentence after the phase-numbering sentence:

From:

```
When run in a terminal, a live progress spinner shows the active phase — e.g. `[1/2] Scanning…`, `[2/2] Rebuilding records…` with the default config. Phases are numbered `1/N…N/N` across the phases enabled in the config (all three enabled shows `[1/3]…[3/3]`). When output is piped or `--no-progress` is used, phases are printed as plain lines instead — no control characters in captured logs. A run summary with per-phase timings, counters, and any collected errors is printed at the end.
```

To:

```
When run in a terminal, a live progress spinner shows the active phase — e.g. `[1/2] Scanning…`, `[2/2] Rebuilding records…` with the default config. Phases are numbered `1/N…N/N` across the phases enabled in the config (all three enabled shows `[1/3]…[3/3]`). During scanning and resyncing, the spinner also shows the file currently being examined (its path relative to the scanned directory). When output is piped or `--no-progress` is used, phases are printed as plain lines instead — no control characters in captured logs. A run summary with per-phase timings, counters, and any collected errors is printed at the end.
```

- [ ] **Step 7: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage && pnpm format:check`
Expected: all pass; coverage ≥ 80%.

- [ ] **Step 8: Commit, push, open PR, STOP**

```bash
git add src/runner.ts src/runner.test.ts README.md
git commit -m "feat: show current file in scan and resync progress"
git push -u gh feat/per-file-progress
```

Create the PR via `gh pr create --title "feat: show current file in scan and resync progress" --body-file <file>`, body:

```
The interactive spinner now shows the file currently being examined in addition to the directory, for both the scan and resync phases:

- Scan: `Scanning <dir> → <relPath>` — via the new `onFile` callback from the previous PR.
- Resync (both modes): `Resyncing <dir> → <relPath>` — per DB entry in the runner's existing loops.
- Paths are relative to the scanned directory (`node:path` `relative`).
- Updates flow only through `reporter.progress()`, so piped/`--no-progress`/quiet output is unchanged (no per-file plain lines).
- README Output section updated.

Verification: typecheck, lint, all tests pass, coverage ≥ 80%.
```

**STOP AND WAIT.** This is the final task. After this PR is merged, the feature is complete.

---

## Self-Review

**Spec coverage:**

| Spec section                                                                               | Task                                          |
| ------------------------------------------------------------------------------------------ | --------------------------------------------- |
| §1 file-service `onFile` callback (fires before `readFileInfo`, every file, absolute path) | Task 1                                        |
| §2 Runner scan phase (`Scanning <dir> → <rel>`)                                            | Task 2                                        |
| §3 Runner resync both modes (`Resyncing <dir> → <rel>`)                                    | Task 2                                        |
| §4 Display behavior (spinner-only, piped/quiet unchanged)                                  | Task 2 (no code — `progress()` already gates) |
| §5 file-service callback test                                                              | Task 1                                        |
| §5 runner scan + resync progress tests                                                     | Task 2                                        |

**Design decisions:**

1. `onFile` fires before `readFileInfo` (outside the file's try/catch) — per the approved spec's "every file encountered" choice; the runner's callback only calls `progress()` which never throws.
2. The relative path is computed by the Runner (via `node:path` `relative`), keeping the service callback generic (absolute path) and the display formatting in the caller.
3. The design spec is committed in Task 1's PR (docs commit) as agreed with the user.
4. README updated in Task 2 (the task whose deliverable is the user-visible behavior).
