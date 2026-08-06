# CLI & Architecture Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real commander-based CLI (flags, exit codes, progress spinner, run summary) and improve architecture (output layer, RunSummary, prepared-statement reuse, named-export fileService, shared path helpers, per-directory error continuation).

**Architecture:** Keep the existing Runner → services structure. Introduce a `CliReporter` output layer that is the only console user; make the Runner return a `RunSummary`; make `cli.ts` a pure `main(argv)` returning an exit code; apply mechanical fixes in DbService and fileService. No changes to hashing, DB schema, or config schema.

**Tech Stack:** Node.js 24, TypeScript 7 (strict, NodeNext/CJS), esbuild, tsx, Vitest, oxlint, Prettier. New runtime deps: `commander` (CLI parsing), `nanospinner` (TTY spinner).

**Execution workflow (per user instructions):** Each task is one PR. Per task: create branch → implement → `pnpm typecheck && pnpm lint && pnpm test` → commit (Conventional Commits) → push → open PR → **STOP AND WAIT for review/merge**. Only after the PR is merged: checkout `main`, pull, create the next branch.

## Global Constraints

- Only two new runtime dependencies: `commander`, `nanospinner`. Install each in the task that first needs it (`pnpm add <pkg>`).
- Only `CliReporter` calls `console` directly. `runner.ts`, services, and `cli.ts` never call `console`.
- Exit codes: `0` = success (warnings do not fail a run), `1` = config file missing/invalid or CLI argument errors, `2` = fatal run error (outside per-directory handling).
- No changes to: hashing algorithm, DB schema, config schema. `config.yaml` comments unchanged.
- Coverage threshold stays at 80% for lines/functions/branches/statements (`pnpm test:coverage`). `src/index.ts` and `src/types/**` are excluded from coverage (see `vitest.config.ts`).
- Prettier: 2-space indent, single quotes, semicolons, print width 120, trailing commas `all`, arrow parens `always`. Run `pnpm format:check` before commit.
- Code style: strict TypeScript, named exports only, no default exports except `better-sqlite3`'s.
- Commits follow Conventional Commits, one logical change per commit.

---

### Task 1: Shared path helpers

Add `src/utilities/path-helpers.ts` with the normalize/ignore helpers currently duplicated inside `runner.ts`. Purely additive — nothing consumes it yet; the Runner refactor (Task 5) adopts it.

**Files:**

- Create: `src/utilities/path-helpers.ts`
- Test: `src/utilities/path-helpers.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces (used by Task 5 and all later tasks):
  - `normalizePath(path: string): string`
  - `buildIgnoredSet(ignoreDirectories: string[]): Set<string>`
  - `isIgnored(path: string, ignored: Set<string>): boolean`

- [ ] **Step 1: Write the failing tests** — create `src/utilities/path-helpers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildIgnoredSet, isIgnored, normalizePath } from './path-helpers';

describe('normalizePath', () => {
  it('lowercases the path', () => {
    expect(normalizePath('C:\\Temp\\Pics')).toBe('c:\\temp\\pics');
  });

  it('trims trailing forward slashes', () => {
    expect(normalizePath('/tmp/pics/')).toBe('/tmp/pics');
  });

  it('trims trailing backslashes', () => {
    expect(normalizePath('C:\\Temp\\')).toBe('c:\\temp');
  });

  it('leaves paths without trailing separators unchanged', () => {
    expect(normalizePath('C:\\Temp')).toBe('c:\\temp');
  });
});

describe('buildIgnoredSet', () => {
  it('normalizes every entry', () => {
    const set = buildIgnoredSet(['C:\\Temp\\', '/tmp/pics/']);
    expect(set).toEqual(new Set(['c:\\temp', '/tmp/pics']));
  });

  it('returns an empty set for an empty list', () => {
    expect(buildIgnoredSet([])).toEqual(new Set());
  });
});

describe('isIgnored', () => {
  it('matches case-insensitively', () => {
    const set = buildIgnoredSet(['C:\\Temp']);
    expect(isIgnored('c:\\temp', set)).toBe(true);
  });

  it('matches regardless of trailing separators', () => {
    const set = buildIgnoredSet(['C:\\Temp']);
    expect(isIgnored('C:\\Temp\\', set)).toBe(true);
  });

  it('returns false for paths outside the ignored set', () => {
    const set = buildIgnoredSet(['C:\\Temp']);
    expect(isIgnored('D:\\Other', set)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/utilities/path-helpers.test.ts`
Expected: FAIL — module `./path-helpers` cannot be found.

- [ ] **Step 3: Write the implementation** — create `src/utilities/path-helpers.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/utilities/path-helpers.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage`
Expected: all pass; coverage thresholds met (new file is fully covered).

- [ ] **Step 6: Commit, push, open PR, STOP**

```bash
git checkout -b feat/path-helpers
git add src/utilities/path-helpers.ts src/utilities/path-helpers.test.ts
git commit -m "feat: add shared path helpers utility"
git push -u origin feat/path-helpers
gh pr create --title "feat: add shared path helpers utility" --body "Adds normalizePath/buildIgnoredSet/isIgnored helpers that replace duplicated logic in the Runner (adopted in the Runner refactor PR). Pure additive change with tests."
```

**STOP AND WAIT.** Do not start Task 2 until this PR is reviewed and merged. Then run `git checkout main && git pull`.

---

### Task 2: Convert fileService to named exports, drop console, propagate root-dir errors

Convert the `fileService` object-literal singleton to plain named exports (stateless functions). Remove all `console.*` calls from the service. Root-directory read failures now **rethrow** instead of warn-and-continue so the Runner (Task 5) can collect per-directory errors; sub-directory failures remain silently swallowed (existing "continue walking" behavior preserved). Update the callers in `runner.ts` and the test imports.

**Files:**

- Modify: `src/services/file-service.ts`
- Modify: `src/services/file-service.test.ts`
- Modify: `src/runner.ts` (import site + `fileService.` call sites only)

**Interfaces:**

- Consumes: nothing new.
- Produces (same signatures, new export style — consumed by Task 5 and all later tasks):
  - `fileExists(path: string): Promise<boolean>`
  - `readFileInfo(path: string, getHash?: boolean): Promise<FileEntry>`
  - `getHashEdges(path: string, algorithm?: string): Promise<string>`
  - `listFilesRecursive(rootDir: string, extensions?: string[], getHash?: boolean, ignoreDirectories?: string[]): Promise<FileEntry[]>`
  - `listFilePathsRecursive(rootDir: string, ignoreDirectories?: string[]): Promise<string[]>`
  - Behavior change: both list functions rethrow when reading **rootDir** fails; sub-directory errors are still swallowed.

- [ ] **Step 1: Update the tests first** — rewrite `src/services/file-service.test.ts` imports/usages and add a root-error test:

Change the import (line 5):

```ts
import { fileService } from './file-service';
```

to:

```ts
import { fileExists, getHashEdges, listFilePathsRecursive, listFilesRecursive, readFileInfo } from './file-service';
```

Replace every `fileService.` call with the bare function name:

- `fileService.fileExists(...)` → `fileExists(...)`
- `fileService.readFileInfo(...)` → `readFileInfo(...)`
- `fileService.getHashEdges(...)` → `getHashEdges(...)`
- `fileService.listFilesRecursive(...)` → `listFilesRecursive(...)`
- `fileService.listFilePathsRecursive(...)` → `listFilePathsRecursive(...)`

Add this test at the end of the `describe('listFilesRecursive', ...)` block:

```ts
it('rejects when the root directory cannot be read', async () => {
  const missing = join(rootDir, 'missing-root');
  await expect(listFilesRecursive(missing)).rejects.toThrow();
});
```

And add this test at the end of the `describe('listFilePathsRecursive', ...)` block:

```ts
it('rejects when the root directory cannot be read', async () => {
  const missing = join(rootDir, 'missing-root');
  await expect(listFilePathsRecursive(missing)).rejects.toThrow();
});
```

- [ ] **Step 2: Run tests to verify the new tests fail**

Run: `pnpm test src/services/file-service.test.ts`
Expected: FAIL — the two new tests (root errors are currently swallowed) and every existing test fails to compile/run due to the missing named imports.

- [ ] **Step 3: Rewrite the implementation** — replace the entire contents of `src/services/file-service.ts` with:

```ts
import { promises as fs } from 'node:fs';
import { dirname, extname, basename, join } from 'node:path';
import { createHash } from 'node:crypto';
import type { FileEntry } from '../types/file-types';

const EDGE_CHUNK_SIZE = 16 * 1024; // 16KB

export async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

export async function readFileInfo(path: string, getHash: boolean = true): Promise<FileEntry> {
  const stats = await fs.stat(path);

  const size = stats.size;
  const directory = dirname(path);
  const extension = extname(path);
  const filename = basename(path);
  const birthtime = stats.birthtime;
  const hash = getHash ? await getHashEdges(path) : undefined;

  return {
    size,
    directory,
    extension,
    path,
    filename,
    birthtime,
    hash,
  };
}

export async function getHashEdges(path: string, algorithm: string = 'sha256'): Promise<string> {
  const fd = await fs.open(path, 'r');
  try {
    const stats = await fd.stat();
    const size = stats.size;

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

// Recursively list all files under a directory and return detailed FileEntry objects.
// Unreadable sub-directories are skipped; an unreadable root directory rejects.
export async function listFilesRecursive(
  rootDir: string,
  extensions?: string[],
  getHash: boolean = true,
  ignoreDirectories?: string[],
): Promise<FileEntry[]> {
  const result: FileEntry[] = [];

  // Normalize extensions to lowercase once for case-insensitive matching
  const normalizedExtensions = extensions?.map((ext) => ext.toLowerCase());

  async function walk(dir: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          if (ignoreDirectories && ignoreDirectories.includes(fullPath)) {
            continue;
          }
          await walk(fullPath);
        } else if (entry.isFile()) {
          const info = await readFileInfo(fullPath, getHash);

          if (normalizedExtensions && normalizedExtensions.length > 0) {
            if (!normalizedExtensions.includes(info.extension.toLowerCase())) {
              continue;
            }
          }

          result.push(info);
        }
      }
    } catch (ex) {
      if (dir === rootDir) {
        throw ex;
      }
    }
  }

  await walk(rootDir);

  return result;
}

// Recursively list all file paths under a directory without reading file metadata.
// Unreadable sub-directories are skipped; an unreadable root directory rejects.
export async function listFilePathsRecursive(rootDir: string, ignoreDirectories?: string[]): Promise<string[]> {
  const result: string[] = [];

  async function walk(dir: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = join(dir, entry.name);

        if (entry.isDirectory()) {
          if (ignoreDirectories && ignoreDirectories.includes(fullPath)) {
            continue;
          }
          await walk(fullPath);
        } else if (entry.isFile()) {
          result.push(fullPath);
        }
      }
    } catch (ex) {
      if (dir === rootDir) {
        throw ex;
      }
    }
  }

  await walk(rootDir);

  return result;
}
```

- [ ] **Step 4: Update the caller** — in `src/runner.ts`, change the import (line 2):

```ts
import { fileService } from './services/file-service';
```

to:

```ts
import { fileExists, listFilePathsRecursive, listFilesRecursive } from './services/file-service';
```

Then replace the three call sites:

- `fileService.listFilesRecursive(` → `listFilesRecursive(` (line 55)
- `fileService.fileExists(` → `fileExists(` (line 84)
- `fileService.listFilePathsRecursive(` → `listFilePathsRecursive(` (line 92)

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test src/services/file-service.test.ts src/runner.test.ts`
Expected: PASS — all file-service tests (including the two new root-error tests) and all existing runner tests.

- [ ] **Step 6: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage`
Expected: all pass; coverage ≥ 80%.

- [ ] **Step 7: Commit, push, open PR, STOP**

```bash
git checkout -b refactor/file-service-exports
git add src/services/file-service.ts src/services/file-service.test.ts src/runner.ts
git commit -m "refactor: convert fileService to named exports"
git push -u origin refactor/file-service-exports
gh pr create --title "refactor: convert fileService to named exports" --body "Converts the stateless fileService object literal to plain named exports, removes all console calls from the service, and rethrows root-directory read failures so the Runner can collect per-directory errors. Sub-directory failures are still swallowed (walk continues). Callers in runner.ts and tests updated."
```

**STOP AND WAIT.** Do not start Task 3 until this PR is reviewed and merged. Then run `git checkout main && git pull`.

---

### Task 3: DbService — prepared statements, upsert status, duplicate stats

Prepare all SQL statements once in the constructor (currently `insertFileInfo` re-prepares on every call). `insertFileInfo` now returns `'inserted' | 'updated'` so the Runner can count real upserts. `updateFileRecords()` keeps its `void` signature (public API otherwise unchanged); a new `getDuplicateStats()` reads the rebuilt `records` table.

The insert-vs-update distinction uses SQLite's `last_insert_rowid()`: an `INSERT` always advances it (AUTOINCREMENT ids are strictly increasing), while an `ON CONFLICT DO UPDATE` leaves it unchanged. Verified against SQLite 3.x behavior.

**Files:**

- Modify: `src/services/db-service.ts`
- Test: `src/services/db-service.test.ts` (add tests; existing tests unchanged)

**Interfaces:**

- Consumes: nothing new.
- Produces (used by Task 5):
  - `insertFileInfo(fileInfo: FileEntry): 'inserted' | 'updated'`
  - `getDuplicateStats(): { duplicateGroups: number; duplicateFiles: number }`
  - All other public methods unchanged in name, signature, and behavior.

- [ ] **Step 1: Write the failing tests** — append to `src/services/db-service.test.ts`:

```ts
it('reports inserted vs updated for upserts', () => {
  const service = openService();

  const original: FileEntry = {
    size: 123,
    directory: '/tmp',
    extension: '.png',
    path: '/tmp/foo.png',
    filename: 'foo.png',
    birthtime: new Date('2025-01-01T00:00:00.000Z'),
    hash: 'abc123',
  };

  expect(service.insertFileInfo(original)).toBe('inserted');

  const updated: FileEntry = {
    ...original,
    size: 456,
    hash: 'new-hash',
  };

  expect(service.insertFileInfo(updated)).toBe('updated');

  // A third call that changes nothing still counts as 'updated'
  expect(service.insertFileInfo(updated)).toBe('updated');
});

it('getDuplicateStats counts duplicate groups and duplicate files', () => {
  const service = openService();

  const entry1: FileEntry = {
    size: 100,
    directory: '/tmp/a',
    extension: '.png',
    path: '/tmp/a/foo.png',
    filename: 'foo.png',
    birthtime: new Date('2025-01-01T00:00:00.000Z'),
    hash: 'hash-1',
  };

  const entry2: FileEntry = {
    size: 100,
    directory: '/tmp/b',
    extension: '.png',
    path: '/tmp/b/foo.png',
    filename: 'foo.png',
    birthtime: new Date('2025-01-02T00:00:00.000Z'),
    hash: 'hash-1',
  };

  const entry3: FileEntry = {
    size: 100,
    directory: '/tmp/c',
    extension: '.png',
    path: '/tmp/c/foo.png',
    filename: 'foo.png',
    birthtime: new Date('2025-01-03T00:00:00.000Z'),
    hash: 'hash-1',
  };

  const other: FileEntry = {
    size: 200,
    directory: '/tmp/d',
    extension: '.png',
    path: '/tmp/d/bar.png',
    filename: 'bar.png',
    birthtime: new Date('2025-01-04T00:00:00.000Z'),
    hash: 'hash-2',
  };

  service.insertFileInfo(entry1);
  service.insertFileInfo(entry2);
  service.insertFileInfo(entry3);
  service.insertFileInfo(other);
  service.updateFileRecords();

  expect(service.getDuplicateStats()).toEqual({ duplicateGroups: 1, duplicateFiles: 2 });
});

it('getDuplicateStats returns zeroes when there are no duplicate groups', () => {
  const service = openService();

  const entry: FileEntry = {
    size: 100,
    directory: '/tmp/a',
    extension: '.png',
    path: '/tmp/a/solo.png',
    filename: 'solo.png',
    birthtime: new Date('2025-01-01T00:00:00.000Z'),
    hash: 'hash-1',
  };

  service.insertFileInfo(entry);
  service.updateFileRecords();

  expect(service.getDuplicateStats()).toEqual({ duplicateGroups: 0, duplicateFiles: 0 });
});
```

- [ ] **Step 2: Run tests to verify the new tests fail**

Run: `pnpm test src/services/db-service.test.ts`
Expected: FAIL — `service.insertFileInfo(...)` returns `void`, so `.toBe('inserted')` fails; `getDuplicateStats` does not exist.

- [ ] **Step 3: Rewrite the implementation** — replace the entire contents of `src/services/db-service.ts` with:

```ts
import Database from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';
import type { FileEntry, FileRecord } from '../types/file-types';

type EntryRow = {
  size: number;
  directory: string;
  extension: string;
  filename: string;
  birthtime: string;
  hash: string | null;
  path: string;
};

export type DuplicateStats = {
  duplicateGroups: number;
  duplicateFiles: number;
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export class DbService {
  private db: DatabaseType;
  private insertEntryStmt: Statement;
  private insertRecordStmt: Statement;
  private selectAllEntriesStmt: Statement;
  private selectEntriesByDirStmt: Statement;
  private deleteEntryByIdStmt: Statement;
  private deleteEntryByPathStmt: Statement;
  private deleteAllRecordsStmt: Statement;
  private dedupStmt: Statement;
  private lastInsertRowidStmt: Statement;
  private duplicateGroupsStmt: Statement;
  private duplicateFilesStmt: Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.createTables();
    this.prepareStatements();
  }

  close() {
    this.db.close();
  }

  private createTables() {
    // formatter: off
    this.db
      .prepare(
        `
    CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        size INTEGER,
        directory TEXT,
        extension TEXT,
        filename TEXT,
        birthtime TEXT,
        hash TEXT,
        path TEXT,
        UNIQUE(path)
    )`,
      )
      .run();
    // formatter: on

    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_entries_filename ON entries (filename)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_entries_hash ON entries (hash)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_entries_directory ON entries (directory)`).run();

    // formatter: off
    this.db
      .prepare(
        `
    CREATE TABLE IF NOT EXISTS records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT,
        hash TEXT,
        count INTEGER,
        directories TEXT,
        extension TEXT,
        size INTEGER,
        UNIQUE(filename, hash)
    )`,
      )
      .run();
    // formatter: on

    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_records_filename ON records (filename)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_records_hash ON records (hash)`).run();
  }

  private prepareStatements() {
    this.insertEntryStmt = this.db.prepare(
      `INSERT INTO entries (size, directory, extension, filename, birthtime, hash, path)
       VALUES (@size, @directory, @extension, @filename, @birthtime, @hash, @path)
       ON CONFLICT(path) DO UPDATE SET
         size = excluded.size,
         extension = excluded.extension,
         birthtime = excluded.birthtime,
         hash = excluded.hash,
         filename = excluded.filename,
         directory = excluded.directory`,
    );

    this.insertRecordStmt = this.db.prepare(
      `INSERT INTO records (filename, hash, count, directories, size, extension)
       VALUES (@filename, @hash, @count, @directories, @size, @extension)
       ON CONFLICT(filename, hash) DO UPDATE SET
         count = excluded.count,
         directories = excluded.directories,
         size = excluded.size,
         extension = excluded.extension`,
    );

    this.selectAllEntriesStmt = this.db.prepare(
      `SELECT size, directory, extension, filename, birthtime, hash, path FROM entries`,
    );

    this.selectEntriesByDirStmt = this.db.prepare(
      `SELECT size, directory, extension, filename, birthtime, hash, path
       FROM entries
       WHERE directory = ? OR directory LIKE ? ESCAPE '\\' OR directory LIKE ? ESCAPE '\\'`,
    );

    this.deleteEntryByIdStmt = this.db.prepare(`DELETE FROM entries WHERE id = ?`);
    this.deleteEntryByPathStmt = this.db.prepare(`DELETE FROM entries WHERE path = ?`);
    this.deleteAllRecordsStmt = this.db.prepare(`DELETE FROM records`);

    this.dedupStmt = this.db.prepare(
      `select hash,
              filename,
              size,
              extension,
              cast(json_group_array(distinct directory) as varchar) as directories,
              count(*)                             as row_count
       from entries
       group by hash, filename, size, extension
       order by filename;
      `,
    );

    this.lastInsertRowidStmt = this.db.prepare(`SELECT last_insert_rowid() AS rowid`);
    this.duplicateGroupsStmt = this.db.prepare(`SELECT COUNT(*) AS n FROM records WHERE count > 1`);
    this.duplicateFilesStmt = this.db.prepare(`SELECT COALESCE(SUM(count - 1), 0) AS n FROM records WHERE count > 1`);
  }

  insertFileInfo(fileInfo: FileEntry): 'inserted' | 'updated' {
    // An INSERT advances last_insert_rowid (AUTOINCREMENT ids are strictly
    // increasing); an ON CONFLICT DO UPDATE leaves it unchanged.
    const before = this.lastInsertRowidStmt.get() as { rowid: number };

    this.insertEntryStmt.run({
      size: fileInfo.size,
      directory: fileInfo.directory,
      extension: fileInfo.extension,
      filename: fileInfo.filename,
      birthtime: fileInfo.birthtime.toISOString(),
      hash: fileInfo.hash ?? null,
      path: fileInfo.path,
    });

    const after = this.lastInsertRowidStmt.get() as { rowid: number };
    return before.rowid === after.rowid ? 'updated' : 'inserted';
  }

  insertFileRecord(fileRecord: FileRecord) {
    this.insertRecordStmt.run({
      filename: fileRecord.filename,
      hash: fileRecord.hash,
      count: fileRecord.count,
      directories: fileRecord.directories,
      size: fileRecord.size,
      extension: fileRecord.extension,
    });
  }

  updateFileRecords() {
    // Rebuild from scratch so records whose (filename, hash) no longer exists in
    // entries (e.g. after a resync removed the underlying files) are dropped.
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
  }

  getDuplicateStats(): DuplicateStats {
    const groups = this.duplicateGroupsStmt.get() as { n: number };
    const files = this.duplicateFilesStmt.get() as { n: number };
    return { duplicateGroups: groups.n, duplicateFiles: files.n };
  }

  getFileEntries() {
    const rows = this.selectAllEntriesStmt.all() as EntryRow[];
    return rows.map((row) => this.mapEntry(row));
  }

  getFileEntriesByDirectory(directory: string) {
    // Match the directory itself and any directory beneath it, bounded by a path
    // separator. Wildcard characters in the directory name are escaped so they are
    // not treated as LIKE patterns. Both '/' and '\' separators are handled.
    const escaped = escapeLike(directory);
    const rows = this.selectEntriesByDirStmt.all(directory, `${escaped}/%`, `${escaped}\\${'\\'}%`) as EntryRow[];
    return rows.map((row) => this.mapEntry(row));
  }

  deleteFileEntryById(id: number) {
    this.deleteEntryByIdStmt.run(id);
  }

  deleteFileEntryByPath(path: string) {
    this.deleteEntryByPathStmt.run(path);
  }

  private mapEntry(row: EntryRow): FileEntry {
    return {
      size: row.size,
      directory: row.directory,
      extension: row.extension,
      filename: row.filename,
      birthtime: new Date(row.birthtime),
      hash: row.hash ?? undefined,
      path: row.path,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/services/db-service.test.ts`
Expected: PASS — all existing tests plus the three new ones.

- [ ] **Step 5: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage`
Expected: all pass; coverage ≥ 80%.

- [ ] **Step 6: Commit, push, open PR, STOP**

```bash
git checkout -b refactor/db-service-prepared-statements
git add src/services/db-service.ts src/services/db-service.test.ts
git commit -m "refactor: prepare SQL statements once in DbService"
git push -u origin refactor/db-service-prepared-statements
gh pr create --title "refactor: prepare SQL statements once in DbService" --body "Moves all SQL statement preparation into the DbService constructor. insertFileInfo now returns 'inserted' | 'updated' (via last_insert_rowid comparison) so the Runner can count real upserts. Adds getDuplicateStats() for the future run summary. Public API otherwise unchanged."
```

**STOP AND WAIT.** Do not start Task 4 until this PR is reviewed and merged. Then run `git checkout main && git pull`.

---

### Task 4: RunSummary type and CliReporter output layer

Introduce the `RunSummary` type and the `CliReporter` class that owns all user-facing output. `CliReporter` is the only code that calls `console`. Spinner updates go through `nanospinner`, gated by a `progress` option (the caller decides TTY-ness — nanospinner writes ANSI codes even to pipes, verified). Adds the `nanospinner` runtime dependency.

**Files:**

- Create: `src/types/run-summary.ts`
- Create: `src/output/reporter.ts`
- Test: `src/output/reporter.test.ts`
- Modify: `package.json` + `pnpm-lock.yaml` via `pnpm add nanospinner`

**Interfaces:**

- Consumes: nothing (type-only reference to nothing else).
- Produces (used by Task 5 and Task 6):
  - `type RunSummary` — exact shape from the spec:
    - `phases: { name: 'scan' | 'resync' | 'records'; elapsedMs: number }[]`
    - `filesScanned: number; entriesUpserted: number; duplicateGroups: number; duplicateFiles: number; staleRemoved: number; errors: string[]`
  - `interface Reporter` — `debug(msg)`, `info(msg)`, `warn(msg)`, `error(msg)`, `progress(msg)`, `stopProgress()`, `printSummary(summary)`.
  - `class CliReporter implements Reporter` — constructor takes `{ quiet: boolean; verbose: boolean; progress: boolean }`.
  - `type ReporterOptions` — same shape as the constructor options object.

- [ ] **Step 1: Install the dependency**

Run: `pnpm add nanospinner`
Expected: `nanospinner@^1.2.2` added to `dependencies` in `package.json`.

- [ ] **Step 2: Write the failing tests** — create `src/output/reporter.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { createSpinner } from 'nanospinner';
import { CliReporter } from './reporter';
import type { RunSummary } from '../types/run-summary';

vi.mock('nanospinner', () => {
  const spinner = {
    start: vi.fn(() => spinner),
    update: vi.fn(() => spinner),
    stop: vi.fn(() => spinner),
  };
  return { createSpinner: vi.fn(() => spinner) };
});

function makeSummary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    phases: [{ name: 'scan', elapsedMs: 12 }],
    filesScanned: 4,
    entriesUpserted: 3,
    duplicateGroups: 1,
    duplicateFiles: 2,
    staleRemoved: 5,
    errors: [],
    ...overrides,
  };
}

describe('CliReporter', () => {
  let consoleLog: Mock;
  let consoleWarn: Mock;
  let consoleError: Mock;

  beforeEach(() => {
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('prints info by default and suppresses it in quiet mode', () => {
    const reporter = new CliReporter({ quiet: false, verbose: false, progress: false });
    reporter.info('hello');
    expect(consoleLog).toHaveBeenCalledWith('hello');

    const quiet = new CliReporter({ quiet: true, verbose: false, progress: false });
    quiet.info('hidden');
    expect(consoleLog).not.toHaveBeenCalledWith('hidden');
  });

  it('gates debug output on verbose and suppresses it in quiet mode', () => {
    const reporter = new CliReporter({ quiet: false, verbose: false, progress: false });
    reporter.debug('hidden');
    expect(consoleLog).not.toHaveBeenCalledWith('[debug] hidden');

    const verbose = new CliReporter({ quiet: false, verbose: true, progress: false });
    verbose.debug('shown');
    expect(consoleLog).toHaveBeenCalledWith('[debug] shown');

    const quietVerbose = new CliReporter({ quiet: true, verbose: true, progress: false });
    quietVerbose.debug('hidden again');
    expect(consoleLog).not.toHaveBeenCalledWith('[debug] hidden again');
  });

  it('always prints warnings and errors', () => {
    const reporter = new CliReporter({ quiet: true, verbose: false, progress: false });
    reporter.warn('careful');
    reporter.error('broken');
    expect(consoleWarn).toHaveBeenCalledWith('careful');
    expect(consoleError).toHaveBeenCalledWith('broken');
  });

  it('does not touch the spinner when progress is disabled', () => {
    const reporter = new CliReporter({ quiet: false, verbose: false, progress: false });
    reporter.progress('working');
    reporter.stopProgress();
    expect(createSpinner).not.toHaveBeenCalled();
  });

  it('drives the spinner when progress is enabled', () => {
    const reporter = new CliReporter({ quiet: false, verbose: false, progress: true });
    reporter.progress('starting');
    reporter.progress('next');
    reporter.stopProgress();

    expect(createSpinner).toHaveBeenCalledWith('starting');
    const spinner = vi.mocked(createSpinner).mock.results[0].value as unknown as {
      start: Mock;
      update: Mock;
      stop: Mock;
    };
    expect(spinner.start).toHaveBeenCalledOnce();
    expect(spinner.update).toHaveBeenCalledWith({ text: 'next' });
    expect(spinner.stop).toHaveBeenCalledOnce();
  });

  it('prints a per-phase summary line for each executed phase', () => {
    const reporter = new CliReporter({ quiet: false, verbose: false, progress: false });
    reporter.printSummary(
      makeSummary({
        phases: [
          { name: 'scan', elapsedMs: 12 },
          { name: 'resync', elapsedMs: 4 },
          { name: 'records', elapsedMs: 3 },
        ],
      }),
    );

    expect(consoleLog).toHaveBeenCalledWith('Scan: 4 files scanned, 3 entries upserted (12 ms)');
    expect(consoleLog).toHaveBeenCalledWith('Resync: 5 stale entries removed (4 ms)');
    expect(consoleLog).toHaveBeenCalledWith('Records: 1 duplicate group, 2 duplicate files (3 ms)');
  });

  it('reports collected errors via warn', () => {
    const reporter = new CliReporter({ quiet: false, verbose: false, progress: false });
    reporter.printSummary(makeSummary({ errors: ['Scan C:\\bad: EACCES'] }));

    expect(consoleWarn).toHaveBeenCalledWith('Encountered 1 error(s):');
    expect(consoleWarn).toHaveBeenCalledWith('  - Scan C:\\bad: EACCES');
  });

  it('hides the summary lines but keeps error warnings in quiet mode', () => {
    const reporter = new CliReporter({ quiet: true, verbose: false, progress: false });
    reporter.printSummary(makeSummary({ errors: ['Scan C:\\bad: EACCES'] }));

    expect(consoleLog).not.toHaveBeenCalledWith(expect.stringContaining('files scanned'));
    expect(consoleWarn).toHaveBeenCalledWith('  - Scan C:\\bad: EACCES');
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test src/output/reporter.test.ts`
Expected: FAIL — `./reporter` module cannot be found.

- [ ] **Step 4: Write the implementation** — create `src/types/run-summary.ts`:

```ts
export type PhaseName = 'scan' | 'resync' | 'records';

export type RunSummary = {
  phases: { name: PhaseName; elapsedMs: number }[];
  filesScanned: number; // files matching extensions encountered during scan
  entriesUpserted: number; // rows inserted or updated in `entries`
  duplicateGroups: number; // groups with count > 1 in `records`
  duplicateFiles: number; // sum of (count - 1) over duplicate groups
  staleRemoved: number; // entries deleted during resync
  errors: string[]; // per-directory failures, non-fatal
};
```

- [ ] **Step 5: Create `src/output/reporter.ts`**:

```ts
import { createSpinner } from 'nanospinner';
import type { Spinner } from 'nanospinner';
import type { RunSummary } from '../types/run-summary';

export interface Reporter {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  progress(msg: string): void;
  stopProgress(): void;
  printSummary(summary: RunSummary): void;
}

export type ReporterOptions = {
  quiet: boolean;
  verbose: boolean;
  progress: boolean;
};

export class CliReporter implements Reporter {
  private spinner: Spinner | null = null;

  constructor(private readonly options: ReporterOptions) {}

  debug(msg: string): void {
    if (this.options.verbose && !this.options.quiet) {
      console.log(`[debug] ${msg}`);
    }
  }

  info(msg: string): void {
    if (!this.options.quiet) {
      console.log(msg);
    }
  }

  warn(msg: string): void {
    console.warn(msg);
  }

  error(msg: string): void {
    console.error(msg);
  }

  progress(msg: string): void {
    if (!this.options.progress) {
      return;
    }
    if (this.spinner === null) {
      this.spinner = createSpinner(msg).start();
    } else {
      this.spinner.update({ text: msg });
    }
  }

  stopProgress(): void {
    if (this.spinner !== null) {
      this.spinner.stop();
      this.spinner = null;
    }
  }

  printSummary(summary: RunSummary): void {
    for (const phase of summary.phases) {
      if (phase.name === 'scan') {
        this.info(
          `Scan: ${summary.filesScanned} files scanned, ${summary.entriesUpserted} entries upserted (${phase.elapsedMs} ms)`,
        );
      } else if (phase.name === 'resync') {
        this.info(`Resync: ${summary.staleRemoved} stale entries removed (${phase.elapsedMs} ms)`);
      } else {
        this.info(
          `Records: ${summary.duplicateGroups} duplicate group${summary.duplicateGroups === 1 ? '' : 's'}, ${summary.duplicateFiles} duplicate file${summary.duplicateFiles === 1 ? '' : 's'} (${phase.elapsedMs} ms)`,
        );
      }
    }
    if (summary.errors.length > 0) {
      this.warn(`Encountered ${summary.errors.length} error(s):`);
      for (const error of summary.errors) {
        this.warn(`  - ${error}`);
      }
    }
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test src/output/reporter.test.ts`
Expected: PASS — all 8 reporter tests.

- [ ] **Step 7: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage`
Expected: all pass; coverage ≥ 80%.

- [ ] **Step 8: Commit, push, open PR, STOP**

```bash
git checkout -b feat/output-reporter
git add src/types/run-summary.ts src/output/reporter.ts src/output/reporter.test.ts package.json pnpm-lock.yaml
git commit -m "feat: add CliReporter output layer and RunSummary type"
git push -u origin feat/output-reporter
gh pr create --title "feat: add CliReporter output layer and RunSummary type" --body "Adds the RunSummary type and the CliReporter output layer (level-gated debug/info/warn/error, nanospinner progress, end-of-run summary). CliReporter is the only console user in the app. Adds the nanospinner runtime dependency. Nothing consumes it yet; the Runner refactor follows."
```

**STOP AND WAIT.** Do not start Task 5 until this PR is reviewed and merged. Then run `git checkout main && git pull`.

---

### Task 5: Runner refactor — reporter injection, RunSummary, per-directory errors, phase timing

The Runner now receives a `Reporter`, returns a `RunSummary`, iterates directories with per-directory try/catch (collecting failures into `summary.errors` while continuing), times each phase, counts scanned/upserted/stale/duplicate values, and uses the shared path helpers. All `console` calls removed. `index.ts` is minimally adapted (interim version with `CliReporter`, no console) so the repo stays green; Task 6 replaces it with the thin shim.

**Files:**

- Modify: `src/runner.ts` (rewrite)
- Modify: `src/runner.test.ts` (rewrite — mock reporter + summary assertions)
- Modify: `src/index.ts` (interim adaptation)

**Interfaces:**

- Consumes:
  - `Reporter` from `./output/reporter` (Task 4)
  - `RunSummary` from `./types/run-summary` (Task 4)
  - `buildIgnoredSet`, `isIgnored`, `normalizePath` from `./utilities/path-helpers` (Task 1)
  - Named exports `fileExists`, `listFilePathsRecursive`, `listFilesRecursive` from `./services/file-service` (Task 2)
  - `DbService.insertFileInfo` returning `'inserted' | 'updated'` and `getDuplicateStats()` (Task 3)
- Produces (used by Task 6):
  - `class Runner` — `constructor(config: RunConfiguration, reporter: Reporter)`, `close()`, `run(): Promise<RunSummary>`.
  - Phase markers `[1/3] Scanning…`, `[2/3] Resyncing…`, `[3/3] Rebuilding records…` via `reporter.info` + `reporter.progress`.
  - Phase timing via `performance.now()`, rounded to whole milliseconds.

- [ ] **Step 1: Update the tests first** — replace the entire contents of `src/runner.test.ts` with:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import Database from 'better-sqlite3';
import { Runner } from './runner';
import type { RunConfiguration } from './types/configuration';

async function makeTempDir(prefix = 'runner-test-'): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), prefix));
}

async function removeDirRecursive(path: string): Promise<void> {
  await fs.rm(path, { recursive: true, force: true });
}

async function createFile(root: string, relativePath: string, content: string): Promise<string> {
  const fullPath = join(root, relativePath);
  await fs.mkdir(dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
  return fullPath;
}

function makeConfig(dbName: string, directory: string): RunConfiguration {
  return {
    dbName,
    extensions: ['.txt'],
    directories: [directory],
    ignore_directories: [],
    update_records: true,
    process_directories: true,
    resync_directories: false,
    resync_check_actual_file: false,
  };
}

type MockReporter = {
  debug: Mock;
  info: Mock;
  warn: Mock;
  error: Mock;
  progress: Mock;
  stopProgress: Mock;
  printSummary: Mock;
};

function makeMockReporter(): MockReporter {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    progress: vi.fn(),
    stopProgress: vi.fn(),
    printSummary: vi.fn(),
  };
}

describe('Runner', () => {
  let rootDir: string;
  let dbPath: string;

  beforeEach(async () => {
    rootDir = await makeTempDir();
    dbPath = join(rootDir, 'test.db');
  });

  afterEach(async () => {
    await removeDirRecursive(rootDir);
  });

  it('indexes files and updates records', async () => {
    await createFile(rootDir, 'src/a.txt', 'unique');
    await createFile(rootDir, 'src/sub/b.txt', 'same content');
    await createFile(rootDir, 'src2/b.txt', 'same content');
    await createFile(rootDir, 'src/c.txt', 'another');

    const runner = new Runner(makeConfig(dbPath, rootDir), makeMockReporter());
    const summary = await runner.run();
    runner.close();

    const db = new Database(dbPath);
    const entries = db.prepare('SELECT filename, size FROM entries ORDER BY filename').all() as {
      filename: string;
      size: number;
    }[];
    const records = db.prepare('SELECT filename, count FROM records ORDER BY filename').all() as {
      filename: string;
      count: number;
    }[];
    db.close();

    expect(entries.map((e) => e.filename)).toEqual(['a.txt', 'b.txt', 'b.txt', 'c.txt']);
    expect(records.find((r) => r.filename === 'a.txt')!.count).toBe(1);
    expect(records.find((r) => r.filename === 'c.txt')!.count).toBe(1);
    // b.txt appears in two directories with identical content -> same hash -> grouped
    expect(records.find((r) => r.filename === 'b.txt')!.count).toBe(2);

    expect(summary.phases.map((p) => p.name)).toEqual(['scan', 'records']);
    expect(summary.filesScanned).toBe(4);
    expect(summary.entriesUpserted).toBe(4);
    expect(summary.duplicateGroups).toBe(1);
    expect(summary.duplicateFiles).toBe(1);
    expect(summary.staleRemoved).toBe(0);
    expect(summary.errors).toEqual([]);
  });

  it('skips directory scanning when process_directories is false', async () => {
    await createFile(rootDir, 'src/a.txt', 'hello');

    const config = { ...makeConfig(dbPath, join(rootDir, 'src')), process_directories: false };
    const runner = new Runner(config, makeMockReporter());
    const summary = await runner.run();
    runner.close();

    const db = new Database(dbPath);
    const count = db.prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number };
    db.close();
    expect(count.c).toBe(0);
    expect(summary.phases.map((p) => p.name)).toEqual(['records']);
    expect(summary.filesScanned).toBe(0);
  });

  it('skips record updating when update_records is false', async () => {
    await createFile(rootDir, 'src/a.txt', 'hello');

    const config = { ...makeConfig(dbPath, join(rootDir, 'src')), update_records: false };
    const runner = new Runner(config, makeMockReporter());
    const summary = await runner.run();
    runner.close();

    const db = new Database(dbPath);
    const entries = db.prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number };
    const records = db.prepare('SELECT COUNT(*) as c FROM records').get() as { c: number };
    db.close();
    expect(entries.c).toBe(1);
    expect(records.c).toBe(0);
    expect(summary.phases.map((p) => p.name)).toEqual(['scan']);
    expect(summary.duplicateGroups).toBe(0);
    expect(summary.duplicateFiles).toBe(0);
  });

  it('ignores directories listed in ignore_directories', async () => {
    await createFile(rootDir, 'src/keep.txt', 'keep');
    await createFile(rootDir, 'src/ignored/skip.txt', 'skip');

    const config: RunConfiguration = {
      ...makeConfig(dbPath, join(rootDir, 'src')),
      ignore_directories: [join(rootDir, 'src', 'ignored')],
    };
    const runner = new Runner(config, makeMockReporter());
    const summary = await runner.run();
    runner.close();

    const db = new Database(dbPath);
    const rows = db.prepare('SELECT filename FROM entries').all() as { filename: string }[];
    db.close();
    expect(rows.map((r) => r.filename)).toEqual(['keep.txt']);
    expect(summary.filesScanned).toBe(1);
  });

  it('skips a directory when it matches an ignore_directories entry', async () => {
    const ignored = await createFile(rootDir, 'src/ignored.txt', 'ignored');

    const config: RunConfiguration = {
      ...makeConfig(dbPath, join(rootDir, 'src')),
      ignore_directories: [dirname(ignored)],
    };
    const runner = new Runner(config, makeMockReporter());
    await runner.run();
    runner.close();

    const db = new Database(dbPath);
    const count = db.prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number };
    db.close();
    expect(count.c).toBe(0);
  });

  it('resyncs by removing entries for files that no longer exist', async () => {
    const fileToDelete = await createFile(rootDir, 'src/a.txt', 'alpha');
    await createFile(rootDir, 'src/b.txt', 'bravo');

    // Index both files first
    const runner = new Runner(makeConfig(dbPath, join(rootDir, 'src')), makeMockReporter());
    await runner.run();
    runner.close();

    // Delete one file, then resync against the actual filesystem
    await fs.unlink(fileToDelete);
    const resyncConfig: RunConfiguration = {
      ...makeConfig(dbPath, join(rootDir, 'src')),
      process_directories: false,
      resync_directories: true,
      resync_check_actual_file: true,
    };
    const reporter = makeMockReporter();
    const resyncRunner = new Runner(resyncConfig, reporter);
    const summary = await resyncRunner.run();
    resyncRunner.close();

    const db = new Database(dbPath);
    const rows = db.prepare('SELECT filename FROM entries ORDER BY filename').all() as {
      filename: string;
    }[];
    db.close();
    expect(rows.map((r) => r.filename)).toEqual(['b.txt']);
    expect(summary.staleRemoved).toBe(1);
    expect(summary.phases.map((p) => p.name)).toEqual(['resync', 'records']);
  });

  it('resyncs against the current directory listing when checkActualFile is false', async () => {
    const fileToDelete = await createFile(rootDir, 'src/a.txt', 'alpha');
    await createFile(rootDir, 'src/b.txt', 'bravo');

    const runner = new Runner(makeConfig(dbPath, join(rootDir, 'src')), makeMockReporter());
    await runner.run();
    runner.close();

    await fs.unlink(fileToDelete);
    const resyncConfig: RunConfiguration = {
      ...makeConfig(dbPath, join(rootDir, 'src')),
      process_directories: false,
      resync_directories: true,
      resync_check_actual_file: false,
    };
    const reporter = makeMockReporter();
    const resyncRunner = new Runner(resyncConfig, reporter);
    const summary = await resyncRunner.run();
    resyncRunner.close();

    const db = new Database(dbPath);
    const rows = db.prepare('SELECT filename FROM entries ORDER BY filename').all() as {
      filename: string;
    }[];
    db.close();
    expect(rows.map((r) => r.filename)).toEqual(['b.txt']);
    expect(summary.staleRemoved).toBe(1);
    expect(summary.phases.map((p) => p.name)).toEqual(['resync', 'records']);
  });

  it('collects per-directory errors and continues with remaining directories', async () => {
    await createFile(rootDir, 'src/a.txt', 'hello');

    const config: RunConfiguration = {
      ...makeConfig(dbPath, join(rootDir, 'src')),
      directories: [join(rootDir, 'missing'), join(rootDir, 'src')],
    };
    const reporter = makeMockReporter();
    const runner = new Runner(config, reporter);
    const summary = await runner.run();
    runner.close();

    const db = new Database(dbPath);
    const count = db.prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number };
    db.close();

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain(join(rootDir, 'missing'));
    expect(count.c).toBe(1);
    expect(summary.filesScanned).toBe(1);
    expect(summary.phases.map((p) => p.name)).toEqual(['scan', 'records']);
    expect(reporter.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to scan directory'));
  });

  it('reports phase markers via the reporter', async () => {
    await createFile(rootDir, 'src/a.txt', 'hello');

    const reporter = makeMockReporter();
    const runner = new Runner(makeConfig(dbPath, join(rootDir, 'src')), reporter);
    await runner.run();
    runner.close();

    expect(reporter.info).toHaveBeenCalledWith(expect.stringContaining('[1/3]'));
    expect(reporter.info).toHaveBeenCalledWith(expect.stringContaining('[3/3]'));
    expect(reporter.progress).toHaveBeenCalledWith(expect.stringContaining('[1/3]'));
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/runner.test.ts`
Expected: FAIL — Runner constructor no longer matches (`reporter` argument), `run()` returns `void` not `RunSummary`.

- [ ] **Step 3: Rewrite `src/runner.ts`** — replace the entire file with:

```ts
import { DbService } from './services/db-service';
import { fileExists, listFilePathsRecursive, listFilesRecursive } from './services/file-service';
import type { Reporter } from './output/reporter';
import type { RunConfiguration } from './types/configuration';
import type { RunSummary } from './types/run-summary';
import { buildIgnoredSet, isIgnored, normalizePath } from './utilities/path-helpers';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Runner {
  private db: DbService;
  private config: RunConfiguration;
  private reporter: Reporter;

  constructor(config: RunConfiguration, reporter: Reporter) {
    this.config = config;
    this.reporter = reporter;
    this.db = new DbService(config.dbName);
  }

  close() {
    this.db.close();
  }

  async run(): Promise<RunSummary> {
    const phases: RunSummary['phases'] = [];
    const errors: string[] = [];
    let filesScanned = 0;
    let entriesUpserted = 0;
    let duplicateGroups = 0;
    let duplicateFiles = 0;
    let staleRemoved = 0;

    if (this.config.process_directories) {
      const result = await this.processDirectories(errors);
      phases.push({ name: 'scan', elapsedMs: result.elapsedMs });
      filesScanned = result.filesScanned;
      entriesUpserted = result.entriesUpserted;
    }

    if (this.config.resync_directories) {
      const result = await this.resyncDirectories(this.config.resync_check_actual_file, errors);
      phases.push({ name: 'resync', elapsedMs: result.elapsedMs });
      staleRemoved = result.staleRemoved;
    }

    if (this.config.update_records) {
      const result = this.updateRecords();
      phases.push({ name: 'records', elapsedMs: result.elapsedMs });
      duplicateGroups = result.duplicateGroups;
      duplicateFiles = result.duplicateFiles;
    }

    return { phases, filesScanned, entriesUpserted, duplicateGroups, duplicateFiles, staleRemoved, errors };
  }

  private async processDirectories(
    errors: string[],
  ): Promise<{ elapsedMs: number; filesScanned: number; entriesUpserted: number }> {
    const { directories, extensions, ignore_directories } = this.config;
    const ignored = buildIgnoredSet(ignore_directories);
    const start = performance.now();

    this.reporter.info('[1/3] Scanning…');
    this.reporter.progress('[1/3] Scanning…');

    let filesScanned = 0;
    let entriesUpserted = 0;

    for (const directory of directories) {
      if (isIgnored(directory, ignored)) {
        this.reporter.info(`Ignoring directory: ${directory}`);
        continue;
      }

      this.reporter.progress(`Scanning ${directory}`);

      try {
        const files = await listFilesRecursive(directory, extensions, true, ignore_directories);
        filesScanned += files.length;
        for (const file of files) {
          const status = this.db.insertFileInfo(file);
          this.reporter.debug(`Upserted (${status}) ${file.path}`);
          entriesUpserted += 1;
        }
      } catch (err) {
        errors.push(`Scan ${directory}: ${errorMessage(err)}`);
        this.reporter.warn(`Failed to scan directory: ${directory} (${errorMessage(err)})`);
      }
    }

    return { elapsedMs: Math.round(performance.now() - start), filesScanned, entriesUpserted };
  }

  private async resyncDirectories(
    checkActualFile: boolean,
    errors: string[],
  ): Promise<{ elapsedMs: number; staleRemoved: number }> {
    const { directories, ignore_directories } = this.config;
    const ignored = buildIgnoredSet(ignore_directories);
    const start = performance.now();

    this.reporter.info('[2/3] Resyncing…');
    this.reporter.progress('[2/3] Resyncing…');

    let staleRemoved = 0;

    for (const directory of directories) {
      if (isIgnored(directory, ignored)) {
        this.reporter.info(`Ignoring directory: ${directory}`);
        continue;
      }

      this.reporter.progress(`Resyncing ${directory}`);

      try {
        const entries = this.db.getFileEntriesByDirectory(directory);

        if (checkActualFile) {
          for (const entry of entries) {
            this.reporter.debug(`Checking file existence: ${entry.path}`);
            const exists = await fileExists(entry.path);
            if (!exists) {
              this.db.deleteFileEntryByPath(entry.path);
              staleRemoved += 1;
            }
          }
        } else {
          const files = await listFilePathsRecursive(directory, ignore_directories);
          const currentPaths = new Set(files.map(normalizePath));
          for (const entry of entries) {
            this.reporter.debug(`Verifying file entry: ${entry.path}`);
            if (!currentPaths.has(normalizePath(entry.path))) {
              this.db.deleteFileEntryByPath(entry.path);
              staleRemoved += 1;
            }
          }
        }
      } catch (err) {
        errors.push(`Resync ${directory}: ${errorMessage(err)}`);
        this.reporter.warn(`Failed to resync directory: ${directory} (${errorMessage(err)})`);
      }
    }

    return { elapsedMs: Math.round(performance.now() - start), staleRemoved };
  }

  private updateRecords(): { elapsedMs: number; duplicateGroups: number; duplicateFiles: number } {
    const start = performance.now();

    this.reporter.info('[3/3] Rebuilding records…');
    this.reporter.progress('[3/3] Rebuilding records…');

    this.db.updateFileRecords();
    const stats = this.db.getDuplicateStats();

    return {
      elapsedMs: Math.round(performance.now() - start),
      duplicateGroups: stats.duplicateGroups,
      duplicateFiles: stats.duplicateFiles,
    };
  }
}
```

- [ ] **Step 4: Adapt `src/index.ts`** — replace the entire file with this interim version (Task 6 replaces it with the shim):

```ts
import { Runner } from './runner';
import { CliReporter } from './output/reporter';
import { loadRunConfiguration } from './utilities/load-config';

(async () => {
  const reporter = new CliReporter({ quiet: false, verbose: false, progress: process.stdout.isTTY === true });

  try {
    const config = await loadRunConfiguration('config.yaml');
    const runner = new Runner(config, reporter);
    try {
      const summary = await runner.run();
      reporter.stopProgress();
      reporter.printSummary(summary);
    } finally {
      runner.close();
    }
  } catch (err) {
    reporter.error(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
})();
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm test src/runner.test.ts`
Expected: PASS — all 9 runner tests (7 pre-existing behaviors + error collection + phase markers).

- [ ] **Step 6: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage`
Expected: all pass; coverage ≥ 80% (runner.ts is fully exercised).

- [ ] **Step 7: Commit, push, open PR, STOP**

```bash
git checkout -b refactor/runner-summary
git add src/runner.ts src/runner.test.ts src/index.ts
git commit -m "feat: inject reporter into Runner and return RunSummary"
git push -u origin refactor/runner-summary
gh pr create --title "feat: inject reporter into Runner and return RunSummary" --body "Runner now takes a Reporter, returns a RunSummary (phases with elapsed times, scanned/upserted/duplicate/stale counters, collected errors), catches per-directory failures and continues, uses shared path helpers, and no longer calls console. index.ts adapted on an interim basis; the CLI PR replaces it with a thin shim."
```

**STOP AND WAIT.** Do not start Task 6 until this PR is reviewed and merged. Then run `git checkout main && git pull`.

---

### Task 6: Commander-based CLI entry and documentation

Add `src/cli.ts` with a pure `main(argv): Promise<number>` (commander, exit codes, reporter wiring), turn `index.ts` into a thin shim, add CLI tests, and document flags/exit codes/output in the README (plus the AGENTS.md structure block). Adds the `commander` runtime dependency.

Verified: `program.parse(argv, { from: 'user' })` parses user args correctly; with `exitOverride()`, `--help`/`--version` throw a `CommanderError` with `exitCode: 0` and argument errors throw with `exitCode: 1`. `program.opts<T>()` is generic. `import { version } from '../package.json'` typechecks (tsconfig has `resolveJsonModule: true`), runs under tsx, and is inlined by esbuild (verified).

**Files:**

- Create: `src/cli.ts`
- Create: `src/cli.test.ts`
- Modify: `src/index.ts`
- Modify: `README.md`
- Modify: `AGENTS.md`
- Modify: `package.json` + `pnpm-lock.yaml` via `pnpm add commander`

**Interfaces:**

- Consumes:
  - `Runner` (Task 5): `constructor(config, reporter)`, `close()`, `run(): Promise<RunSummary>`
  - `CliReporter` + `ReporterOptions` (Task 4)
  - `loadRunConfiguration(fileName): Promise<RunConfiguration>` (existing)
- Produces:
  - `main(argv: string[]): Promise<number>` — exit code `0` (success), `1` (config missing/invalid or CLI argument errors, including commander's own argument errors), `2` (fatal run failure).
  - Flags: `--config <path>` (default `config.yaml`), `--quiet`, `--verbose`, `--no-progress`, `--version`, `--help`.

- [ ] **Step 1: Install the dependency**

Run: `pnpm add commander`
Expected: `commander@^14.x` added to `dependencies` in `package.json`.

- [ ] **Step 2: Write the failing tests** — create `src/cli.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import Database from 'better-sqlite3';
import { main } from './cli';

async function makeTempDir(prefix = 'cli-test-'): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), prefix));
}

async function removeDirRecursive(path: string): Promise<void> {
  await fs.rm(path, { recursive: true, force: true });
}

async function createFile(root: string, relativePath: string, content: string): Promise<string> {
  const fullPath = join(root, relativePath);
  await fs.mkdir(dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content);
  return fullPath;
}

function toYaml(config: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(config)) {
    if (Array.isArray(value)) {
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${item}`);
      }
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.join('\n');
}

function makeConfigYaml(dir: string): string {
  return toYaml({
    dbName: join(dir, 'test.db'),
    extensions: 'txt',
    directories: [join(dir, 'pics')],
    ignore_directories: [],
    process_directories: true,
    update_records: true,
    resync_directories: false,
    resync_check_actual_file: false,
  });
}

describe('main', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await makeTempDir();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    await removeDirRecursive(rootDir);
    vi.restoreAllMocks();
  });

  it('runs with a config file passed via --config', async () => {
    await createFile(rootDir, 'pics/a.txt', 'hello');
    await fs.writeFile(join(rootDir, 'config.yaml'), makeConfigYaml(rootDir));

    const code = await main(['--config', join(rootDir, 'config.yaml')]);

    expect(code).toBe(0);
    const db = new Database(join(rootDir, 'test.db'));
    const count = db.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number };
    db.close();
    expect(count.c).toBe(1);
  });

  it('uses the default config.yaml path when no --config is given', async () => {
    await createFile(rootDir, 'pics/a.txt', 'hello');
    await fs.writeFile(join(rootDir, 'config.yaml'), makeConfigYaml(rootDir));

    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(rootDir);
    try {
      const code = await main([]);
      expect(code).toBe(0);
    } finally {
      cwdSpy.mockRestore();
    }

    const db = new Database(join(rootDir, 'test.db'));
    const count = db.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number };
    db.close();
    expect(count.c).toBe(1);
  });

  it('returns 1 when the config file is missing', async () => {
    const code = await main(['--config', join(rootDir, 'missing.yaml')]);
    expect(code).toBe(1);
  });

  it('returns 1 when the config file is invalid', async () => {
    await fs.writeFile(join(rootDir, 'config.yaml'), 'dbName: 123');
    const code = await main(['--config', join(rootDir, 'config.yaml')]);
    expect(code).toBe(1);
  });

  it('returns 1 for an unknown CLI flag', async () => {
    const code = await main(['--bogus']);
    expect(code).toBe(1);
  });

  it('returns 2 when the run fails fatally', async () => {
    await fs.writeFile(
      join(rootDir, 'config.yaml'),
      toYaml({
        dbName: join(rootDir, 'missing', 'sub', 'test.db'),
        extensions: 'txt',
        directories: [],
        ignore_directories: [],
        process_directories: false,
        update_records: false,
        resync_directories: false,
        resync_check_actual_file: false,
      }),
    );

    const code = await main(['--config', join(rootDir, 'config.yaml')]);
    expect(code).toBe(2);
  });

  it('returns 0 for --help', async () => {
    const code = await main(['--help']);
    expect(code).toBe(0);
  });

  it('returns 0 for --version', async () => {
    const code = await main(['--version']);
    expect(code).toBe(0);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm test src/cli.test.ts`
Expected: FAIL — `./cli` module cannot be found.

- [ ] **Step 4: Write `src/cli.ts`**:

```ts
import { Command, CommanderError } from 'commander';
import { version } from '../package.json';
import { Runner } from './runner';
import { CliReporter } from './output/reporter';
import { loadRunConfiguration } from './utilities/load-config';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function main(argv: string[]): Promise<number> {
  const program = new Command();
  program
    .name('imgsorter')
    .description('Index local files and detect duplicates across directories')
    .version(version)
    .option('--config <path>', 'path to the config file', 'config.yaml')
    .option('--quiet', 'only show warnings and errors')
    .option('--verbose', 'enable debug-level output')
    .option('--no-progress', 'disable the live progress spinner');
  program.exitOverride();

  try {
    program.parse(argv, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode;
    }
    return 1;
  }

  const opts = program.opts<{ config: string; quiet: boolean; verbose: boolean; progress: boolean }>();

  const reporter = new CliReporter({
    quiet: opts.quiet,
    verbose: opts.verbose,
    progress: opts.progress && process.stdout.isTTY === true,
  });

  let config;
  try {
    config = await loadRunConfiguration(opts.config);
  } catch (err) {
    reporter.error(`Invalid config: ${errorMessage(err)}`);
    return 1;
  }

  const runner = new Runner(config, reporter);
  try {
    const summary = await runner.run();
    reporter.stopProgress();
    reporter.printSummary(summary);
    return 0;
  } catch (err) {
    reporter.stopProgress();
    reporter.error(`Run failed: ${errorMessage(err)}`);
    return 2;
  } finally {
    runner.close();
  }
}
```

- [ ] **Step 5: Replace `src/index.ts`** with the thin shim:

```ts
import { main } from './cli';

main(process.argv.slice(2)).then((exitCode) => {
  process.exitCode = exitCode;
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test src/cli.test.ts`
Expected: PASS — all 8 cli tests.

- [ ] **Step 7: Update `README.md`**

Make these edits to `README.md`:

1. In the `### Run` section, after the existing `pnpm start` block, append:

````markdown
The CLI accepts the following options:

```bash
pnpm start -- --config config.yaml   # use a specific config file
pnpm start -- --quiet                # only warnings and errors
pnpm start -- --verbose              # debug-level output
pnpm start -- --no-progress          # disable the live spinner (e.g. for piping)
pnpm start -- --help                 # show help
pnpm start -- --version              # show the version
```
````

2. After the `### Run` section, add a `### Exit codes` section:

```markdown
### Exit codes

| Code | Meaning                                                 |
| ---- | ------------------------------------------------------- |
| `0`  | Run succeeded (warnings do not fail a run)              |
| `1`  | Config file missing or invalid, or a CLI argument error |
| `2`  | Run failed (fatal error outside per-directory handling) |

Per-directory problems (e.g. an unreadable scan directory) do not fail the run: they are reported as warnings and collected in the end-of-run summary.
```

3. Add a `### Output` paragraph after the exit codes section:

```markdown
### Output

When run in a terminal, a live progress spinner shows the active phase (`[1/3] Scanning…`, `[2/3] Resyncing…`, `[3/3] Rebuilding records…`). When output is piped or `--no-progress` is used, phases are printed as plain lines instead — no control characters in captured logs. A run summary with per-phase timings, counters, and any collected errors is printed at the end.
```

4. In the `## Features` list, change the last bullet from:

```markdown
- `Runner` exported as a class for library/Electron usage
```

to:

```markdown
- `Runner` exported as a class for library/Electron usage (returns a `RunSummary`)
- CLI flags (`--config`, `--quiet`, `--verbose`, `--no-progress`) with meaningful exit codes
- Live progress spinner with a plain-line fallback when piped
```

5. In the `## Project Structure` block, replace the `src/` section with:

```markdown
├── src/ # TypeScript source files
│ ├── index.ts # Thin entry point that calls cli.main()
│ ├── cli.ts # Commander-based CLI (main() returns the exit code)
│ ├── runner.ts # Runner orchestration class (also usable as a library)
│ ├── output/
│ │ └── reporter.ts # CliReporter — the only console user in the app
│ ├── services/
│ │ ├── db-service.ts # SQLite database operations
│ │ └── file-service.ts # File listing, metadata, and hashing
│ ├── types/
│ │ ├── configuration.ts # RunConfiguration type
│ │ ├── file-types.ts # FileEntry and FileRecord types
│ │ └── run-summary.ts # RunSummary type returned by Runner.run()
│ └── utilities/
│ ├── load-config.ts # Zod-validated YAML config loader
│ └── path-helpers.ts # Path normalization and ignore helpers
```

6. In the `## Using the Runner as a library` section, replace the code block with:

````markdown
```ts
import { Runner } from './runner';
import { CliReporter } from './output/reporter';
import { loadRunConfiguration } from './utilities/load-config';

const config = await loadRunConfiguration('config.yaml');
const reporter = new CliReporter({ quiet: false, verbose: false, progress: process.stdout.isTTY === true });
const runner = new Runner(config, reporter);
try {
  const summary = await runner.run();
  reporter.stopProgress();
  reporter.printSummary(summary);
} finally {
  runner.close();
}
```
````

- [ ] **Step 8: Update the `## Project Structure` block in `AGENTS.md`**

Replace the `src/` section in AGENTS.md with the same tree as Step 7.5, and add `commander` and `nanospinner` to the runtime deps bullet in the Technology Stack section:

```markdown
- **Runtime deps:** better-sqlite3 12.x, commander 14.x, nanospinner 1.x, yaml 2.x, zod 4.x
```

- [ ] **Step 9: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage && pnpm format:check`
Expected: all pass; coverage ≥ 80%.

- [ ] **Step 10: Commit, push, open PR, STOP**

```bash
git checkout -b feat/cli-entry
git add src/cli.ts src/cli.test.ts src/index.ts README.md AGENTS.md package.json pnpm-lock.yaml
git commit -m "feat: add commander-based CLI with exit codes"
git push -u origin feat/cli-entry
gh pr create --title "feat: add commander-based CLI with exit codes" --body "Adds a pure main(argv) CLI entry (commander) with --config/--quiet/--verbose/--no-progress flags and 0/1/2 exit codes, converts index.ts into a thin shim, and documents flags, exit codes, and output behavior in the README. Adds the commander runtime dependency."
```

**STOP AND WAIT.** This is the final task. After this PR is merged, the migration is complete.

---

## Self-Review

**Spec coverage:**

| Spec section                                                                                                            | Task      |
| ----------------------------------------------------------------------------------------------------------------------- | --------- |
| §1 CLI Entry (`cli.ts`, `main()`, flags, exit codes, shim)                                                              | Task 6    |
| §2 Output Layer (`CliReporter`, level gating, spinner, summary, markers, degradation)                                   | Task 4    |
| §3 RunSummary type                                                                                                      | Task 4    |
| §3 Runner changes (reporter injection, `run(): Promise<RunSummary>`, per-directory try/catch, phase timing, no console) | Task 5    |
| §3 path-helpers                                                                                                         | Task 1    |
| §4 DbService (prepared statements, `insertFileInfo` return)                                                             | Task 3    |
| §4 fileService (named exports)                                                                                          | Task 2    |
| §5 Runner tests (mock reporter, summary, conditional phases, error collection)                                          | Task 5    |
| §5 cli tests (exit codes: default, override, missing/invalid, bad flag, fatal)                                          | Task 6    |
| §5 Reporter tests (gating, spinner disabled, summary formatting)                                                        | Task 4    |
| §5 path-helpers tests                                                                                                   | Task 1    |
| §5 DbService tests (upsert return)                                                                                      | Task 3    |
| §5 fileService tests (imports updated)                                                                                  | Task 2    |
| §5 README (flags, exit codes, output)                                                                                   | Task 6    |
| §5 Coverage ≥ 80%                                                                                                       | all tasks |

**Design decisions worth flagging to the reviewer:**

1. **fileService root-dir errors now rethrow** (sub-directory errors remain swallowed). Without this, the spec's "one unreadable directory is collected into errors" requirement would be impossible to implement, because the old code warned-and-continued inside the service.
2. **Insert-vs-update detection uses `last_insert_rowid()` comparison** — verified empirically: inserts advance the AUTOINCREMENT rowid, `ON CONFLICT DO UPDATE` leaves it unchanged (even no-op updates).
3. **`updateFileRecords()` keeps its `void` signature** ("public API otherwise unchanged" per spec); duplicate stats come from a new `getDuplicateStats()` that reads the rebuilt `records` table.
4. **`Reporter` interface** added alongside `CliReporter` so the Runner depends on the output boundary and tests can inject a mock without a cast.
5. **Both `info()` and `progress()` receive phase markers** — in TTY mode the marker appears as a log line above the spinner; when progress is disabled the spinner is a no-op and the plain lines remain (the spec's degradation behavior).
6. **quiet + verbose together**: quiet wins for `debug`/`info`; warnings and errors always print (deterministic conflict resolution).
7. **Task 5 carries an interim `index.ts`** using `CliReporter` so every PR keeps the repo green; Task 6 replaces it with the shim.
