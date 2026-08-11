# Post-Migration Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the six in-scope items from issue #25 — DB write transactions + dead-code removal (PR 1), single-stat hashing + centralized `errorMessage` (PR 2), and the `entriesUpserted`→`entriesWritten` rename + consolidated test helpers (PR 3).

**Architecture:** Three PRs, one per task, under the repo's one-PR-per-task operating rules. PR 1 keeps behavior identical (transactions are transparent; dead code is removed). PR 2 changes `getHashEdges` to accept a known size (one stat per file instead of two) and centralizes `errorMessage` into a utility. PR 3 renames the scan counter field and the CLI summary string, and consolidates four phase-test config factories into a shared `makeConfig` in `test-helpers.ts`.

**Tech Stack:** Node.js 24, TypeScript 7 (strict, NodeNext/CJS), Vitest 4, oxlint, Prettier, better-sqlite3. No new runtime dependencies.

## Global Constraints

- TypeScript strict mode, named exports only. Files in `src/` with `.ts` extension.
- Prettier: 2-space indent, single quotes, semicolons, print width 120, trailing commas `all`, arrow parens `always`. Run `pnpm format:check` before commit.
- Only `CliReporter` calls `console`. No new `console` calls.
- No changes to: hashing algorithm, DB schema, config schema, `RunConfiguration` shape.
- Behavior identical except: (a) PR 1 drops the per-file `--verbose` debug line in the scan insert loop (verbose-only, not part of the info/warn/error contract); (b) PR 3 changes the scan summary string "entries upserted" → "entries written".
- Exit codes unchanged (`0`/`1`/`2`/`130`).
- Coverage thresholds (80%) enforced by `pnpm test:coverage`.
- Per task: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage && pnpm format:check` must all pass.
- Commits follow Conventional Commits; one logical change per commit.
- **Workflow (per user's operating rules):** each task is exactly one PR. Per task: `git checkout main && git pull`, create branch → implement → verify → commit → push (`git push -u gh <branch>`) → `gh pr create` → **STOP AND WAIT** for review/merge before starting the next task. (Push to the `gh` remote — it uses HTTPS; `origin` uses SSH and may not have a working key.)

---

### Task 1 (PR 1): DbService transactions + dead-code removal

Wrap all multi-statement DB writes in transactions and remove the dead `DbService` methods.

**Files:**

- Modify: `src/services/db-service.ts`
- Modify: `src/services/db-service.test.ts`
- Modify: `src/phases/scan-phase.ts`
- Modify: `src/phases/scan-phase.test.ts`

**Interfaces:**

- Consumes: existing `DbService`, `ScanPhase`, `PhaseContext`.
- Produces (used by Task 3, which renames the field):
  - `DbService.insertFileInfos(files: FileEntry[]): { inserted: number; updated: number }` — inserts all entries in one SQLite transaction, returning how many were inserted vs updated.
  - `DbService.updateFileRecords()` — same signature; now wraps the rebuild in one transaction.
  - Removed: `getFileEntries()`, `deleteFileEntryById()`. `insertFileRecord` becomes `private`.
  - `ScanPhase` calls `insertFileInfos(files)` once per directory instead of looping `insertFileInfo` per file.

- [ ] **Step 1: Write the failing tests** — append to `src/services/db-service.test.ts` (inside `describe('DbService', ...)`):

```ts
it('insertFileInfos inserts multiple entries and reports inserted counts', () => {
  const service = openService();

  const entry1: FileEntry = {
    size: 100,
    directory: '/tmp/a',
    extension: '.png',
    path: '/tmp/a/x.png',
    filename: 'x.png',
    birthtime: new Date('2025-01-01T00:00:00.000Z'),
    hash: 'h1',
  };
  const entry2: FileEntry = {
    size: 200,
    directory: '/tmp/b',
    extension: '.png',
    path: '/tmp/b/y.png',
    filename: 'y.png',
    birthtime: new Date('2025-01-02T00:00:00.000Z'),
    hash: 'h2',
  };

  const counts = service.insertFileInfos([entry1, entry2]);

  expect(counts).toEqual({ inserted: 2, updated: 0 });
});

it('insertFileInfos reports updated counts for paths that already exist', () => {
  const service = openService();

  const original: FileEntry = {
    size: 100,
    directory: '/tmp/a',
    extension: '.png',
    path: '/tmp/a/x.png',
    filename: 'x.png',
    birthtime: new Date('2025-01-01T00:00:00.000Z'),
    hash: 'h1',
  };
  service.insertFileInfo(original);

  const updated: FileEntry = { ...original, size: 456, hash: 'h2' };
  const counts = service.insertFileInfos([updated]);

  expect(counts).toEqual({ inserted: 0, updated: 1 });
});

it('insertFileInfos rolls back all entries when one insert fails', () => {
  const service = openService();

  const good: FileEntry = {
    size: 100,
    directory: '/tmp/a',
    extension: '.png',
    path: '/tmp/a/good.png',
    filename: 'good.png',
    birthtime: new Date('2025-01-01T00:00:00.000Z'),
    hash: 'g',
  };

  // A duplicate `path` is not a natural failure here — `insertFileInfo` uses
  // `ON CONFLICT(path) DO UPDATE`, so it upserts. Add a unique index on `hash`
  // (test-only, not part of the schema) so a second row sharing `good`'s hash
  // throws a UNIQUE constraint that the `path` conflict target does not cover.
  const db = new Database(dbPath);
  db.prepare('CREATE UNIQUE INDEX idx_hash ON entries (hash)').run();
  db.close();

  const bad: FileEntry = {
    size: 200,
    directory: '/tmp/b',
    extension: '.png',
    path: '/tmp/b/bad.png', // different path (so ON CONFLICT(path) doesn't fire), same hash as `good`
    filename: 'bad.png',
    birthtime: new Date('2025-01-02T00:00:00.000Z'),
    hash: 'g',
  };

  expect(() => service.insertFileInfos([good, bad])).toThrow();

  const rows = new Database(dbPath).prepare('SELECT path FROM entries').all() as { path: string }[];
  expect(rows).toEqual([]); // the whole transaction rolled back
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/services/db-service.test.ts`
Expected: all three FAIL — `insertFileInfos` does not exist on `DbService`. (The rollback test also fails because without a transaction, `good` stays inserted after the `bad` insert throws.)

- [ ] **Step 3: Implement `insertFileInfos` + transaction in `updateFileRecords`** — edit `src/services/db-service.ts`:

Replace the `updateFileRecords` method body (currently `db-service.ts:181-209`) with:

```ts
updateFileRecords() {
  // Rebuild in a single transaction so a failure leaves the previous records
  // table intact rather than half-deleted.
  const rebuild = this.db.transaction(() => {
    this.deleteAllRecordsStmt.run();

    const rows = this.dedupStmt.all() as {
      hash: string;
      filename: string;
      directories: string;
      extension: string;
      row_count: number;
      size: number;
    }[];

    for (const row of rows) {
      // json_group_array returns a JSON array; round-trip through JSON.parse normalizes
      // escaping (e.g. Windows backslashes) without corrupting real double backslashes.
      const directories = JSON.stringify(JSON.parse(row.directories));

      this.insertFileRecord({
        filename: row.filename,
        hash: row.hash,
        count: row.row_count,
        extension: row.extension,
        directories,
        size: row.size,
      });
    }
  });
  rebuild();
}
```

Add `insertFileInfos` immediately after `insertFileInfo` (after `db-service.ts:168`):

```ts
insertFileInfos(files: FileEntry[]): { inserted: number; updated: number } {
  const insertAll = this.db.transaction((entries: FileEntry[]) => {
    let inserted = 0;
    let updated = 0;
    for (const file of entries) {
      if (this.insertFileInfo(file) === 'inserted') {
        inserted += 1;
      } else {
        updated += 1;
      }
    }
    return { inserted, updated };
  });
  return insertAll(files);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/services/db-service.test.ts`
Expected: PASS — the two count tests and the rollback test, plus all existing db-service tests.

- [ ] **Step 5: Update `ScanPhase` to batch-insert** — edit `src/phases/scan-phase.ts`:

Replace the insert loop (currently `scan-phase.ts:66-71`):

```ts
filesScanned += files.length;
for (const file of files) {
  throwIfAborted(ctx.signal);
  const status = ctx.db.insertFileInfo(file);
  ctx.reporter.debug(`Upserted (${status}) ${file.path}`);
  entriesUpserted += 1;
}
```

with:

```ts
filesScanned += files.length;
const { inserted, updated } = ctx.db.insertFileInfos(files);
entriesUpserted += inserted + updated;
```

Behavior notes:

- The per-file `throwIfAborted` is removed — it was a no-op: better-sqlite3 is synchronous, so the abort signal cannot change mid-batch. Abort still lands at the top of each directory iteration in `iterate-directories.ts`.
- The per-file `--verbose` debug line `Upserted (status) path` is dropped (verbose-only; no test asserts it). This is the one intentional verbose-output change in PR 1.

- [ ] **Step 6: Update `src/phases/scan-phase.test.ts`** — the db mock now provides `insertFileInfos`:

(a) Replace the mock in "lists matching files, writes entries, and reports counters and events" (currently `scan-phase.test.ts:60`):

```ts
const db = { insertFileInfo: vi.fn(() => 'inserted') };
```

with:

```ts
const db = { insertFileInfos: vi.fn(() => ({ inserted: 2, updated: 0 })) };
```

And replace the assertion at `scan-phase.test.ts:80`:

```ts
expect(db.insertFileInfo).toHaveBeenCalledTimes(2);
```

with:

```ts
expect(db.insertFileInfos).toHaveBeenCalledTimes(1);
```

(b) Replace the db mock in "collects a directory listing error..." (currently `scan-phase.test.ts:116`):

```ts
      db: { insertFileInfo: vi.fn(() => 'inserted') } as unknown as DbService,
```

with:

```ts
      db: { insertFileInfos: vi.fn(() => ({ inserted: 1, updated: 0 })) } as unknown as DbService,
```

(c) Replace the db mock in "throws RunAbortedError when the signal is already aborted..." (currently `scan-phase.test.ts:136`) and its assertion (`:148`):

```ts
    const db = { insertFileInfo: vi.fn(() => 'inserted') };

    await expect(...)...
    expect(db.insertFileInfo).not.toHaveBeenCalled();
```

becomes:

```ts
    const db = { insertFileInfos: vi.fn(() => ({ inserted: 0, updated: 0 })) };

    await expect(...)...
    expect(db.insertFileInfos).not.toHaveBeenCalled();
```

(d) Replace the mid-write abort test ("stops writing entries when the signal aborts between the walk and the insert loop", currently `scan-phase.test.ts:151-175`) with a test that a DB error from the batch propagates and fails the run:

```ts
it('propagates a DbService error from insertFileInfos', async () => {
  await createFile(rootDir, 'src/a.txt', 'hello');

  const db = {
    insertFileInfos: vi.fn(() => {
      throw new Error('db write failed');
    }),
  };

  await expect(
    new ScanPhase().run({
      config: makeConfig(join(rootDir, 'src')),
      db: db as unknown as DbService,
      reporter: asReporter(makeMockReporter()),
      progress: asProgress(makeMockProgress()),
      marker: '[1/1]',
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('db write failed');
});
```

- [ ] **Step 7: Remove dead code from `src/services/db-service.ts`:**

(a) Remove the `selectAllEntriesStmt` and `deleteEntryByIdStmt` field declarations (currently `db-service.ts:28,30`).

(b) Remove their `prepare` calls in `prepareStatements` (currently `db-service.ts:118-120` and `db-service.ts:128`).

(c) Make `insertFileRecord` private (currently `db-service.ts:170`):

```ts
  private insertFileRecord(fileRecord: FileRecord) {
```

(d) Remove the `getFileEntries()` method (currently `db-service.ts:234-237`).

(e) Remove the `deleteFileEntryById` method (currently `db-service.ts:248-250`).

- [ ] **Step 8: Update `src/services/db-service.test.ts` for the removals:**

(a) In "creates entries and records tables on construction" (currently `db-service.test.ts:45`), replace:

```ts
expect(service.getFileEntries()).toEqual([]);
```

with a raw empty-table check using the already-opened `db` connection — move the assertion after `const db = new Database(dbPath);` (line 47) and add:

```ts
const entriesCount = db.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number };
expect(entriesCount.c).toBe(0);
```

(b) Remove the entire test "inserts a FileRecord into records table" (currently `db-service.test.ts:118-148`).

(c) Remove the entire test "upserts a FileRecord when called with the same filename and hash" (currently `db-service.test.ts:200-237`).

(d) Remove the entire test "returns all file entries from the entries table via getFileEntries" (currently `db-service.test.ts:239-287`).

(e) Remove the entire test "deletes a file entry by id" (currently `db-service.test.ts:289-314`).

- [ ] **Step 9: Run the full suite**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage && pnpm format:check`
Expected: all pass; coverage ≥ 80%. `scan-phase.ts` and `db-service.ts` fully covered.

- [ ] **Step 10: Commit, push, open PR, STOP**

```bash
git checkout -b refactor/db-transactions-and-cleanup
git add src/services/db-service.ts src/services/db-service.test.ts src/phases/scan-phase.ts src/phases/scan-phase.test.ts
git commit -m "refactor: batch DB writes in transactions and drop dead DbService methods"
git push -u gh refactor/db-transactions-and-cleanup
gh pr create --title "refactor: batch DB writes in transactions and drop dead DbService methods" --body "Wraps updateFileRecords() and the scan insert loop in better-sqlite3 transactions (one commit per rebuild / per directory instead of per statement). Adds DbService.insertFileInfos() returning inserted/updated counts; ScanPhase consumes it. Removes the test-only getFileEntries()/deleteFileEntryById() methods and makes insertFileRecord private. Per-file verbose debug line in the scan insert loop is dropped (no test asserted it). Behavior otherwise identical."
```

**STOP AND WAIT.** Do not start Task 2 until this PR is reviewed and merged. Then run `git checkout main && git pull`.

---

### Task 2 (PR 2): single-stat hashing + centralized `errorMessage`

Eliminate the redundant `fd.stat()` in `getHashEdges` (one stat per file instead of two) and centralize the duplicated `errorMessage()` helper.

**Files:**

- Modify: `src/services/file-service.ts`
- Modify: `src/services/file-service.test.ts`
- Create: `src/utilities/error-message.ts`
- Create: `src/utilities/error-message.test.ts`
- Modify: `src/cli.ts`, `src/phases/scan-phase.ts`, `src/phases/resync-phase.ts`

**Interfaces:**

- Consumes: existing `readFileInfo`, `getHashEdges`, `errorMessage` call sites.
- Produces (used by all later tasks):
  - `readFileInfo(path, getHash?)` — same signature and return; now opens the file once, stats via the open fd, and passes the known size to hashing.
  - `getHashEdges(path: string, size: number, algorithm?: string): Promise<string>` — `size` is now a required second parameter; it no longer stats the file itself.
  - `errorMessage(err: unknown): string` in `src/utilities/error-message.ts`.

- [ ] **Step 1: Update the tests first** — `src/services/file-service.test.ts` `getHashEdges` tests must pass the file size:

(a) "produces a deterministic hash for a small file (<16KB)" (currently `file-service.test.ts:95-101`):

```ts
it('produces a deterministic hash for a small file (<16KB)', async () => {
  const content = 'small file content';
  const filePath = await createFile(rootDir, 'files/small.txt', content);
  const size = (await fs.stat(filePath)).size;

  const hash = await getHashEdges(filePath, size);
  expect(hash).toBe(computeExpectedEdgeHash(content, 16 * 1024));
});
```

(b) "produces different hashes for files with different content" (currently `file-service.test.ts:103-113`):

```ts
it('produces different hashes for files with different content', async () => {
  const contentA = 'AAA'.repeat(1000);
  const contentB = 'BBB'.repeat(1000);
  const fileA = await createFile(rootDir, 'files/a.bin', contentA);
  const fileB = await createFile(rootDir, 'files/b.bin', contentB);

  const hashA = await getHashEdges(fileA, (await fs.stat(fileA)).size);
  const hashB = await getHashEdges(fileB, (await fs.stat(fileB)).size);

  expect(hashA).not.toBe(hashB);
});
```

(c) "handles large files by hashing only the first and last 16KB" (currently `file-service.test.ts:115-136`), replace the call at `:134`:

```ts
const actual = await getHashEdges(filePath, totalSize);
```

(d) "throws when file does not exist" (currently `file-service.test.ts:138-141`):

```ts
it('throws when file does not exist', async () => {
  const nonExistent = join(rootDir, 'missing.bin');
  await expect(getHashEdges(nonExistent, 0)).rejects.toThrow();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/services/file-service.test.ts`
Expected: FAIL — TS compile error: expected 2 arguments, got 1.

- [ ] **Step 3: Write the implementation** — `src/services/file-service.ts`:

Replace `readFileInfo` (currently `file-service.ts:18-37`) and `getHashEdges` (currently `file-service.ts:39-69`) with:

```ts
export async function readFileInfo(path: string, getHash: boolean = true): Promise<FileEntry> {
  const fd = await fs.open(path, 'r');
  try {
    const stats = await fd.stat();

    const size = stats.size;
    const directory = dirname(path);
    const extension = extname(path);
    const filename = basename(path);
    const birthtime = stats.birthtime;
    const hash = getHash ? await getHashEdges(path, size) : undefined;

    return {
      size,
      directory,
      extension,
      path,
      filename,
      birthtime,
      hash,
    };
  } finally {
    await fd.close();
  }
}

export async function getHashEdges(path: string, size: number, algorithm: string = 'sha256'): Promise<string> {
  const fd = await fs.open(path, 'r');
  try {
    const firstLen = Math.min(EDGE_CHUNK_SIZE, size);
    const lastLen = Math.min(EDGE_CHUNK_SIZE, Math.max(0, size - firstLen));

    const hash = createHash(algorithm);

    // Read first chunk
    if (firstLen > 0) {
      const firstBuf = Buffer.allocUnsafe(firstLen);
      await fd.read(firstBuf, 0, firstLen, 0);
      hash.update(firstBuf);
    }

    // Read last chunk (avoid double-reading if file smaller than 2 * EDGE_CHUNK_SIZE)
    if (lastLen > 0) {
      const lastBuf = Buffer.allocUnsafe(lastLen);
      const lastPos = size - lastLen;
      await fd.read(lastBuf, 0, lastLen, lastPos);
      hash.update(lastBuf);
    }

    return hash.digest('hex');
  } finally {
    await fd.close();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/services/file-service.test.ts`
Expected: PASS — all file-service tests (hash values unchanged because the same edge bytes are read).

- [ ] **Step 5: Centralize `errorMessage`** — create `src/utilities/error-message.ts`:

```ts
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 6: Add its test** — create `src/utilities/error-message.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { errorMessage } from './error-message';

describe('errorMessage', () => {
  it('returns the message for an Error instance', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('stringifies non-Error values', () => {
    expect(errorMessage('oops')).toBe('oops');
    expect(errorMessage(42)).toBe('42');
  });
});
```

- [ ] **Step 7: Replace the three local copies:**

(a) `src/cli.ts` — delete the local `errorMessage` (currently `cli.ts:9-11`) and add the import:

```ts
import { errorMessage } from './utilities/error-message';
```

(b) `src/phases/scan-phase.ts` — delete the local `errorMessage` (currently `scan-phase.ts:8-10`) and add:

```ts
import { errorMessage } from '../utilities/error-message';
```

(c) `src/phases/resync-phase.ts` — delete the local `errorMessage` (currently `resync-phase.ts:8-10`) and add:

```ts
import { errorMessage } from '../utilities/error-message';
```

- [ ] **Step 8: Run the full suite**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage && pnpm format:check`
Expected: all pass; coverage ≥ 80% (new `error-message.ts` fully covered by its test).

- [ ] **Step 9: Commit, push, open PR, STOP**

```bash
git checkout -b refactor/file-service-stats-and-error-message
git add src/services/file-service.ts src/services/file-service.test.ts src/utilities/error-message.ts src/utilities/error-message.test.ts src/cli.ts src/phases/scan-phase.ts src/phases/resync-phase.ts
git commit -m "refactor: single-stat hashing and centralize errorMessage helper"
git push -u gh refactor/file-service-stats-and-error-message
gh pr create --title "refactor: single-stat hashing and centralize errorMessage helper" --body "readFileInfo now opens the file once, stats via the open fd, and passes the known size to getHashEdges — one stat per file instead of two (the second fd.stat() is gone). getHashEdges gains a required size parameter; hash values are unchanged. errorMessage() is extracted to src/utilities/error-message.ts and the three duplicated copies in cli.ts, scan-phase.ts, and resync-phase.ts are removed."
```

**STOP AND WAIT.** Do not start Task 3 until this PR is reviewed and merged. Then run `git checkout main && git pull`.

---

### Task 3 (PR 3): rename `entriesUpserted` → `entriesWritten` + consolidate test helpers

Rename the scan counter field to reflect that it counts both inserts and updates, and consolidate the four phase-test config factories into `test-helpers.ts`.

**Files:**

- Modify: `src/types/run-summary.ts`, `src/phases/types.ts`, `src/phases/scan-phase.ts`, `src/runner.ts`, `src/output/reporter.ts`
- Modify: `src/runner.test.ts`, `src/phases/scan-phase.test.ts`, `src/output/reporter.test.ts`
- Modify: `src/phases/test-helpers.ts`
- Modify: `src/phases/iterate-directories.test.ts`, `src/phases/records-phase.test.ts`, `src/phases/scan-phase.test.ts`, `src/phases/resync-phase.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 1-2.
- Produces:
  - `RunSummary.entriesWritten: number` (replaces `entriesUpserted`).
  - `PhaseResult` scan member `entriesWritten` (replaces `entriesUpserted`).
  - `CliReporter` summary string: `Scan: N files scanned, M entries written (...)` (replaces "entries upserted").
  - `test-helpers.makeConfig(overrides?: Partial<RunConfiguration>): RunConfiguration` — shared config factory.

- [ ] **Step 1: Rename in the type definitions** — `src/types/run-summary.ts`:

```ts
// Rows inserted or updated in `entries` during the scan phase.
entriesWritten: number;
```

And `src/phases/types.ts`:

```ts
  | { name: 'scan'; elapsedMs: number; errors: string[]; filesScanned: number; entriesWritten: number }
```

- [ ] **Step 2: Rename in the implementation** — `src/phases/scan-phase.ts`:

```ts
let filesWritten = 0;
```

```ts
filesScanned += files.length;
const { inserted, updated } = ctx.db.insertFileInfos(files);
filesWritten += inserted + updated;
```

```ts
return {
  name: 'scan',
  elapsedMs: Math.round(performance.now() - start),
  errors,
  filesScanned,
  entriesWritten: filesWritten,
};
```

And `src/runner.ts`:

```ts
      entriesWritten: 0,
```

```ts
        case 'scan':
          summary.filesScanned = result.filesScanned;
          summary.entriesWritten = result.entriesWritten;
          break;
```

And `src/output/reporter.ts`:

```ts
        case 'scan':
          this.info(
            `Scan: ${summary.filesScanned} files scanned, ${summary.entriesWritten} entries written (${phase.elapsedMs} ms)`,
          );
          break;
```

- [ ] **Step 3: Update the tests asserting the name:**

(a) `src/runner.test.ts:113`:

```ts
expect(summary.entriesWritten).toBe(4);
```

(b) `src/phases/scan-phase.test.ts:78`:

```ts
expect(result.entriesWritten).toBe(2);
```

(c) `src/output/reporter.test.ts:22` — in `makeSummary`:

```ts
    entriesWritten: 3,
```

(d) `src/output/reporter.test.ts` — the summary-line assertion:

```ts
expect(consoleLog).toHaveBeenCalledWith('Scan: 4 files scanned, 3 entries written (12 ms)');
```

- [ ] **Step 4: Run tests to verify the rename is consistent**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS — no `entriesUpserted` references remain anywhere.

- [ ] **Step 5: Add the shared `makeConfig`** — `src/phases/test-helpers.ts`:

Add the import and factory:

```ts
import type { RunConfiguration } from '../types/configuration';
```

```ts
export function makeConfig(overrides: Partial<RunConfiguration> = {}): RunConfiguration {
  return {
    dbName: 'test.db',
    extensions: ['.txt'],
    directories: [],
    ignore_directories: [],
    update_records: false,
    process_directories: true,
    resync_directories: false,
    resync_check_actual_file: false,
    ...overrides,
  };
}
```

- [ ] **Step 6: Migrate `src/phases/iterate-directories.test.ts`:**

Remove the local `makeConfig` and `makeReporter` functions (currently `iterate-directories.test.ts:10-30`). Update the import (currently `iterate-directories.test.ts:2-5`) to:

```ts
import { makeConfig, makeMockReporter, asReporter } from './test-helpers';
```

Remove the now-unused imports (`Reporter` type, `RunConfiguration` type) if they become unused. Replace every call site:

- `makeConfig(['/a', '/b'])` → `makeConfig({ directories: ['/a', '/b'] })`
- `makeConfig(['/a', '/ignored', '/b'], ['/ignored'])` → `makeConfig({ directories: ['/a', '/ignored', '/b'], ignore_directories: ['/ignored'] })`
- `makeConfig(['/a'])` → `makeConfig({ directories: ['/a'] })`
- `reporter: makeReporter()` → `reporter: asReporter(makeMockReporter())` (each occurrence)

- [ ] **Step 7: Migrate `src/phases/records-phase.test.ts`:**

Remove the local `makeConfig` and `makeReporter` functions (currently `records-phase.test.ts:10-30`). Update the import to:

```ts
import { makeConfig, makeMockReporter, asReporter } from './test-helpers';
```

Replace every call site:

- `makeConfig(true)` → `makeConfig({ update_records: true })`
- `makeConfig(false)` → `makeConfig({ update_records: false })`
- `makeConfig()` → `makeConfig({ update_records: true })`
- `reporter: makeReporter()` → `reporter: asReporter(makeMockReporter())` (each occurrence)

- [ ] **Step 8: Migrate `src/phases/scan-phase.test.ts`:**

Remove the local `makeConfig` (currently `scan-phase.test.ts:26-37`). Update the import (currently `scan-phase.test.ts:7`) to include `makeConfig`:

```ts
import { makeConfig, makeMockReporter, makeMockProgress, asReporter, asProgress } from './test-helpers';
```

Replace every call site (`makeConfig(join(rootDir, 'src'))` and the `{ ...makeConfig(...) }` spreads) with the shared factory:

- `makeConfig(join(rootDir, 'src'))` → `makeConfig({ directories: [join(rootDir, 'src')] })`
- `{ ...makeConfig(join(rootDir, 'src')), process_directories: false }` → `{ ...makeConfig({ directories: [join(rootDir, 'src')] }), process_directories: false }`
- `{ ...makeConfig(join(rootDir, 'src')), directories: [join(rootDir, 'missing'), join(rootDir, 'src')] }` → `{ ...makeConfig({ directories: [join(rootDir, 'src')] }), directories: [join(rootDir, 'missing'), join(rootDir, 'src')] }`

- [ ] **Step 9: Migrate `src/phases/resync-phase.test.ts`:**

Remove the local `makeConfig` (currently `resync-phase.test.ts:15-25`). Update the import (currently `resync-phase.test.ts:7`) to include `makeConfig`:

```ts
import { makeConfig, makeMockReporter, makeMockProgress, asReporter, asProgress } from './test-helpers';
```

Replace every call site:

- `makeConfig(src, true)` → `makeConfig({ directories: [src], resync_directories: true, resync_check_actual_file: true })`
- `makeConfig(src, false)` → `makeConfig({ directories: [src], resync_directories: true, resync_check_actual_file: false })`
- `makeConfig(join(rootDir, 'missing'), false)` → `makeConfig({ directories: [join(rootDir, 'missing')], resync_directories: true, resync_check_actual_file: false })`
- `makeConfig(join(rootDir, 'src'), false)` (in the enabled test) → `makeConfig({ directories: [join(rootDir, 'src')], resync_directories: true, resync_check_actual_file: false })`
- `{ ...makeConfig(join(rootDir, 'src'), false), resync_directories: false }` → `{ ...makeConfig({ directories: [join(rootDir, 'src')], resync_directories: true, resync_check_actual_file: false }), resync_directories: false }`

- [ ] **Step 10: Run the full suite**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage && pnpm format:check`
Expected: all pass; coverage ≥ 80%.

- [ ] **Step 11: Verify no stale references**

Run: `rg "entriesUpserted" src docs/superpowers/specs/2026-08-12-post-migration-improvements-design.md`
Expected: only the design-spec's own mention of the rename (line 11, 40, 102, 181, 184) remains; no `src/` hits.

- [ ] **Step 12: Commit, push, open PR, STOP**

```bash
git checkout -b refactor/entries-written-and-test-helpers
git add src/types/run-summary.ts src/phases/types.ts src/phases/scan-phase.ts src/runner.ts src/output/reporter.ts src/runner.test.ts src/phases/scan-phase.test.ts src/output/reporter.test.ts src/phases/test-helpers.ts src/phases/iterate-directories.test.ts src/phases/records-phase.test.ts src/phases/resync-phase.test.ts
git commit -m "refactor: rename entriesUpserted to entriesWritten and share phase test config"
git push -u gh refactor/entries-written-and-test-helpers
gh pr create --title "refactor: rename entriesUpserted to entriesWritten and share phase test config" --body "Renames RunSummary.entriesUpserted to entriesWritten (it counts both inserts and updates) across the type, PhaseResult, ScanPhase, Runner, and CliReporter — the scan summary line now reads 'entries written'. Consolidates the four phase-test config factories into a shared makeConfig(overrides) in src/phases/test-helpers.ts and migrates all four phase test files to it."
```

**STOP AND WAIT.** This is the final task. No further tasks in this plan.

---

## Out of Scope

- Item 5 (Electron native-module rebuild), item 6 (progress counts redesign), item 9 (streaming file enumeration) — deferred by decision.
- Any DB schema or config schema change.
- Any new runtime dependencies.
