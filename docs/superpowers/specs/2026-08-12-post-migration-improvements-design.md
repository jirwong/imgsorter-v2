# Post-Migration Improvements Design

Date: 2026-08-12

## Objective

Address issue #25 (code review suggestions) by implementing six of its nine items across three PRs:

- **PR 1 (DbService perf + cleanup):** wrap DB writes in transactions (item 1) and remove dead code (item 2).
- **PR 2 (file-service + shared utils):** eliminate the redundant stat call in hashing (item 4) and centralize `errorMessage()` (item 3).
- **PR 3 (naming + test hygiene):** rename `entriesUpserted` → `entriesWritten` (item 7) and consolidate phase test helpers (item 8).

Explicitly **out of scope** (deferred by decision):

- Item 5 (better-sqlite3 native-module rebuild for Electron) — planning only, no code value today.
- Item 6 (progress `counts` semantics redesign) — revisit when the Electron UI is built.
- Item 9 (streaming `FileEntry[]` instead of buffering) — revisit if libraries grow large.

Behavior must remain identical: all existing tests pass, exit codes unchanged, and the DB schema/config schema untouched. The one intentional user-visible string change is the scan summary line ("entries upserted" → "entries written", PR 3).

## Context

### Item 1 — Transactions

`DbService.updateFileRecords()` (`src/services/db-service.ts:181`) runs `deleteAllRecords` then an insert loop; each statement autocommits in better-sqlite3. `ScanPhase` also inserts entries one-by-one (`src/phases/scan-phase.ts:66-71`). On large libraries this means thousands of small commits per run.

### Item 2 — Dead code

`getFileEntries()` (`db-service.ts:234`) and `deleteFileEntryById()` (`db-service.ts:248`) — plus their prepared statements `selectAllEntriesStmt` / `deleteEntryByIdStmt` — are referenced **only** in `db-service.test.ts`, never in production. `insertFileRecord()` is called only internally (`updateFileRecords`) and by tests; it should be private. `getFileEntriesByDirectory` and `deleteFileEntryByPath` stay (resync uses them).

### Item 4 — Redundant stat in hashing

`readFileInfo` (`file-service.ts:18`) does `fs.stat(path)` then calls `getHashEdges(path)` which reopens the file and does `fd.stat()` again (`file-service.ts:43`) — two stat syscalls per file.

### Item 3 — Duplicated `errorMessage()`

Identical `function errorMessage(err)` exists in `cli.ts:9`, `scan-phase.ts:8`, `resync-phase.ts:8`.

### Item 7 — Misleading name

`RunSummary.entriesUpserted` counts both inserted and updated rows, but the name implies only inserts. The value is incremented once per file regardless of the `'inserted' | 'updated'` status returned by `insertFileInfo`.

### Item 8 — Test helper fragmentation

`iterate-directories.test.ts` and `records-phase.test.ts` define their own local `makeReporter`/`makeConfig`; `scan-phase.test.ts` and `resync-phase.test.ts` use `test-helpers.ts` but keep their own `makeConfig`. Four near-identical config factories.

## Chosen Approach

**Three PRs under the one-PR-per-task operating rules.**

Rejected alternatives:

- **One item per PR (6 PRs)** — maximum isolation, but items 2/7/8 are near-trivial and would each get a tiny PR.
- **Two PRs (perf + cleanup)** — fewer PRs but mixes unrelated concerns (DbService vs file-service; dead code vs naming).

---

## PR 1: DbService performance + cleanup

### Files

- Modify: `src/services/db-service.ts`
- Test: `src/services/db-service.test.ts`
- Modify: `src/phases/scan-phase.ts`
- Test: `src/phases/scan-phase.test.ts`

### Transactions

`updateFileRecords()` wraps its rebuild in a transaction:

```ts
updateFileRecords() {
  const rebuild = this.db.transaction(() => {
    this.deleteAllRecordsStmt.run();
    const rows = this.dedupStmt.all() as {...}[];
    for (const row of rows) {
      this.insertFileRecord({ /* as today */ });
    }
  });
  rebuild();
}
```

A new batch insert method commits a whole directory's entries in one transaction:

```ts
insertFileInfos(files: FileEntry[]): { inserted: number; updated: number } {
  const insertAll = this.db.transaction((entries: FileEntry[]) => {
    let inserted = 0;
    let updated = 0;
    for (const file of entries) {
      if (this.insertFileInfo(file) === 'inserted') inserted += 1;
      else updated += 1;
    }
    return { inserted, updated };
  });
  return insertAll(files);
}
```

`ScanPhase` replaces its per-file insert loop with one `insertFileInfos(files)` call per directory:

```ts
const { inserted, updated } = ctx.db.insertFileInfos(files);
entriesUpserted += inserted + updated;
```

**Abort behavior:** the per-file `throwIfAborted(ctx.signal)` inside the old insert loop is removed. This is a no-op change — better-sqlite3 is synchronous, so the signal cannot change mid-batch; the abort check at the top of each directory iteration (`iterate-directories.ts`) already covers cancel-before-batch. Abort semantics are preserved.

### Dead code removal

- Remove `getFileEntries()` and `deleteFileEntryById()` methods and their `selectAllEntriesStmt` / `deleteEntryByIdStmt` prepared statements.
- Make `insertFileRecord` `private`.
- Remove the two direct `FileRecord` tests (`inserts a FileRecord into records table`, `upserts a FileRecord when called with the same filename and hash`) — the upsert path they covered remains exercised by the `updates file records based on entries` integration test.
- Remove the `getFileEntries` test (`returns all file entries ... via getFileEntries`) and the `deleteFileEntryById` test (`deletes a file entry by id`).
- Keep `getFileEntriesByDirectory`, `deleteFileEntryByPath`, `insertFileInfo`, `getDuplicateStats`, `updateFileRecords` public.
- `insertFileInfos` is public (ScanPhase consumes it).

---

## PR 2: file-service + shared utils

### Files

- Modify: `src/services/file-service.ts`
- Test: `src/services/file-service.test.ts`
- Create: `src/utilities/error-message.ts`
- Modify: `src/cli.ts`, `src/phases/scan-phase.ts`, `src/phases/resync-phase.ts`

### Item 4 — single stat per file

`readFileInfo` opens the file once, reads metadata from the open fd, and passes the known size to hashing:

```ts
export async function readFileInfo(path: string, getHash: boolean = true): Promise<FileEntry> {
  const fd = await fs.open(path, 'r');
  try {
    const stats = await fd.stat();
    const hash = getHash ? await getHashEdges(path, stats.size) : undefined;
    return {
      size: stats.size,
      directory: dirname(path),
      extension: extname(path),
      filename: basename(path),
      path,
      birthtime: stats.birthtime,
      hash,
    };
  } finally {
    await fd.close();
  }
}
```

`getHashEdges` gains a required `size` parameter and drops its own `fd.stat()`:

```ts
export async function getHashEdges(path: string, size: number, algorithm: string = 'sha256'): Promise<string>;
```

It still opens the file (needed to read the edge bytes) but performs one stat per file instead of two. `fileExists` unchanged. Tests pass the file size into `getHashEdges`.

### Item 3 — centralize `errorMessage()`

Create `src/utilities/error-message.ts`:

```ts
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

`cli.ts`, `scan-phase.ts`, `resync-phase.ts` delete their local copies and import from `../utilities/error-message`. Byte-identical behavior.

---

## PR 3: naming + test hygiene

### Files

- Modify: `src/types/run-summary.ts`, `src/phases/types.ts`, `src/phases/scan-phase.ts`, `src/runner.ts`, `src/output/reporter.ts`
- Test: `src/runner.test.ts`, `src/phases/scan-phase.test.ts`, `src/output/reporter.test.ts`
- Modify: `src/phases/test-helpers.ts`
- Test: `src/phases/iterate-directories.test.ts`, `src/phases/records-phase.test.ts`, `src/phases/scan-phase.test.ts`, `src/phases/resync-phase.test.ts`

### Item 7 — rename `entriesUpserted` → `entriesWritten`

Rename the field everywhere it appears:

- `RunSummary.entriesUpserted` → `entriesWritten` (update the doc comment: "Rows inserted or updated in `entries` during the scan phase.")
- `PhaseResult` scan member (`phases/types.ts`)
- `ScanPhase` local variable and return
- `Runner` fold target
- `CliReporter` summary string: `Scan: N files scanned, M entries upserted (...)` → `... M entries written (...)`
- Tests asserting the field name.

**Intentional user-visible change:** the scan summary line text changes from "entries upserted" to "entries written". The migration's byte-for-byte constraint was scoped to the refactor PRs; this rename is an explicit improvement.

### Item 8 — consolidate test helpers

`test-helpers.ts` gains a shared config factory:

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

- `iterate-directories.test.ts` and `records-phase.test.ts` import `makeMockReporter`/`makeConfig` from `./test-helpers`, deleting their local copies.
- `scan-phase.test.ts` and `resync-phase.test.ts` migrate their local `makeConfig` to the shared one (via `overrides`).
- `asReporter`/`asProgress` and `makeMockProgress` stay as-is.
- No behavior change; all tests pass.

## Data Flow

1. PR 1: `ScanPhase.run` → `iterateDirectories` (per directory) → `insertFileInfos(files)` → one SQLite transaction → returns counts; `RecordsPhase.run` → `updateFileRecords()` → one transaction. `RunSummary` counters unchanged.
2. PR 2: `listFilesRecursive` → `readFileInfo` per file → single `fd.stat()` + `getHashEdges(path, size)`.
3. PR 3: `Runner.run` folds `entriesWritten` into `RunSummary`; `CliReporter.printSummary` prints "entries written".

## Error Handling

- Transactions: a failed `rebuild()`/`insertAll()` rolls back atomically — no partial `records` rebuild or partial directory write. No new error paths; better-sqlite3 transaction errors propagate as before.
- `readFileInfo`: `fd.open` before the try, `fd.close` in `finally` — the close always runs; errors propagate to `listFilesRecursive`'s existing per-file catch. `readFileInfo` for a missing file rejects as it does today.
- No changes to error semantics in PR 3.

## Testing

- PR 1: new `insertFileInfos` unit tests (counts inserted/updated; multiple files commit); `updateFileRecords` still produces correct records/stats; dead-code removals delete the corresponding tests; ScanPhase test mocks `insertFileInfos` and asserts counts.
- PR 2: `readFileInfo`/`getHashEdges` tests updated for the new signature (hash still correct for small files, files ≥ 2× chunk, and differing contents); `errorMessage` covered via existing call sites (or a small direct test).
- PR 3: rename asserted across `runner.test.ts`, `scan-phase.test.ts`, `reporter.test.ts`; shared `makeConfig` exercised by all four phase test files.
- Coverage thresholds (80%) remain enforced.

## Out of Scope

- Item 5 (Electron native-module rebuild), item 6 (progress counts redesign), item 9 (streaming file enumeration).
- Any DB schema or config schema change.
- New runtime dependencies.
