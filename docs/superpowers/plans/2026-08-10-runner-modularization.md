# Runner Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure `src/runner.ts` from a god-class into a thin orchestrator over per-phase classes, decouple progress from the console via a typed event emitter, add progress counters and `AbortSignal` cancellation, and keep every CLI console string byte-for-byte identical.

**Architecture:** Introduce `src/phases/` (a `Phase` interface with `ScanPhase`, `ResyncPhase`, `RecordsPhase` singletons, a shared `iterateDirectories` helper, and an `abort.ts` primitive) plus a typed `ProgressEmitter`/`ProgressSink` progress channel. The `Runner` becomes a 60-line orchestrator that filters `PHASES` by `enabled(config)`, computes `[n/total]` markers, and folds each `PhaseResult` into `RunSummary`. `CliReporter.subscribe(progress)` reproduces the exact current CLI strings from events; the `Reporter` interface slims to output-only. `cli.ts` wires an `AbortController` (SIGINT → abort, exit 130).

**Tech Stack:** Node.js 24, TypeScript 7 (strict, NodeNext/CJS), esbuild, tsx, Vitest 4, oxlint, Prettier. No new runtime dependencies.

## Global Constraints

- TypeScript strict mode, named exports only (no default exports). Files in `src/` with `.ts` extension.
- Prettier: 2-space indent, single quotes, semicolons, print width 120, trailing commas `all`, arrow parens `always`.
- Only `CliReporter` calls `console` directly. `runner.ts`, phases, services, and `cli.ts` never call `console`.
- No changes to: hashing algorithm, DB schema, config schema, `RunSummary` shape, or error semantics.
- Every console message string is byte-for-byte unchanged from today's output (all current `cli.test.ts`, `reporter.test.ts`, and `runner.test.ts` assertions that are preserved keep passing).
- Coverage thresholds (80% lines/functions/branches/statements) enforced by `pnpm test:coverage`. `src/index.ts` and `src/types/**` are excluded from coverage (see `vitest.config.ts`).
- Per task: `pnpm typecheck && pnpm lint && pnpm test` must all pass, and `pnpm format:check` before commit.
- Commits follow Conventional Commits; one logical change per commit.
- **Workflow (per user's operating rules):** each task is exactly one PR. Per task: `git checkout main && git pull`, create branch → implement → verify → commit → push → `gh pr create` → **STOP AND WAIT** for review/merge before starting the next task.

---

### Task 1: Progress event types and `ProgressEmitter`

Add the typed progress contract and its emitter implementation. Nothing consumes them yet — purely additive.

**Files:**

- Create: `src/types/progress.ts`
- Create: `src/output/progress.ts`
- Test: `src/output/progress.test.ts`

**Interfaces:**

- Consumes: `PhaseName` from `./types/run-summary` (exists).
- Produces (used by all later tasks):
  - `type ProgressEvent` — discriminated union: `phaseStart`, `directoryStart`, `file` (with `filesProcessed: number`, `totalFiles: number | null`), `counts`.
  - `interface ProgressSink { emitProgress(event: ProgressEvent): void }` — emit-only view; phases depend on this and nothing else.
  - `class ProgressEmitter implements ProgressSink` — adds `on(listener): () => void` over `node:events`.

- [ ] **Step 1: Write the failing tests** — create `src/output/progress.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { ProgressEmitter } from './progress';
import type { ProgressEvent, ProgressSink } from '../types/progress';

describe('ProgressEmitter', () => {
  it('delivers events to a subscribed listener', () => {
    const emitter = new ProgressEmitter();
    const listener = vi.fn();
    emitter.on(listener);

    const event: ProgressEvent = { type: 'phaseStart', phase: 'scan', marker: '[1/2]' };
    emitter.emitProgress(event);

    expect(listener).toHaveBeenCalledWith(event);
  });

  it('supports unsubscribing', () => {
    const emitter = new ProgressEmitter();
    const listener = vi.fn();
    const off = emitter.on(listener);
    off();

    emitter.emitProgress({ type: 'directoryStart', phase: 'scan', directory: '/tmp/pics' });
    expect(listener).not.toHaveBeenCalled();
  });

  it('is usable through the ProgressSink emit-only view', () => {
    const emitter = new ProgressEmitter();
    const listener = vi.fn();
    emitter.on(listener);

    const sink: ProgressSink = emitter;
    sink.emitProgress({
      type: 'file',
      phase: 'scan',
      directory: '/tmp/pics',
      currentFile: '/tmp/pics/a.jpg',
      filesProcessed: 1,
      totalFiles: null,
    });
    sink.emitProgress({ type: 'counts', phase: 'scan', filesProcessed: 1, totalFiles: 1 });

    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('notifies every subscribed listener', () => {
    const emitter = new ProgressEmitter();
    const a = vi.fn();
    const b = vi.fn();
    emitter.on(a);
    emitter.on(b);

    emitter.emitProgress({ type: 'phaseStart', phase: 'records', marker: '[3/3]' });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/output/progress.test.ts`
Expected: FAIL — module `./progress` cannot be found.

- [ ] **Step 3: Write the implementation** — create `src/types/progress.ts`:

```ts
import type { PhaseName } from './run-summary';

export type ProgressEvent =
  | { type: 'phaseStart'; phase: PhaseName; marker: string }
  | { type: 'directoryStart'; phase: PhaseName; directory: string }
  | {
      type: 'file';
      phase: PhaseName;
      directory: string;
      currentFile: string;
      filesProcessed: number; // cumulative across the phase so far
      totalFiles: number | null; // null while the total is still unknown
    }
  | { type: 'counts'; phase: PhaseName; filesProcessed: number; totalFiles: number };

// emit-only view; phases depend on this and nothing else
export interface ProgressSink {
  emitProgress(event: ProgressEvent): void;
}
```

And create `src/output/progress.ts`:

```ts
import { EventEmitter } from 'node:events';
import type { ProgressEvent, ProgressSink } from '../types/progress';

export type ProgressListener = (event: ProgressEvent) => void;

export class ProgressEmitter implements ProgressSink {
  private readonly emitter = new EventEmitter();

  emitProgress(event: ProgressEvent): void {
    this.emitter.emit('progress', event);
  }

  on(listener: ProgressListener): () => void {
    this.emitter.on('progress', listener);
    return () => this.emitter.off('progress', listener);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/output/progress.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage`
Expected: all pass; coverage ≥ 80% (new files fully covered).

- [ ] **Step 6: Commit, push, open PR, STOP**

```bash
git checkout -b feat/progress-emitter
git add src/types/progress.ts src/output/progress.ts src/output/progress.test.ts
git commit -m "feat: add typed progress event emitter"
git push -u origin feat/progress-emitter
gh pr create --title "feat: add typed progress event emitter" --body "Adds the ProgressEvent union and ProgressSink emit-only interface plus a ProgressEmitter implementation over node:events. Phases will emit through ProgressSink while CliReporter/Electron subscribe via on(). Purely additive with tests."
```

**STOP AND WAIT.** Do not start Task 2 until this PR is reviewed and merged. Then run `git checkout main && git pull`.

---

### Task 2: Abort primitive

Add the `RunAbortedError` type and the `throwIfAborted` check used by phases and `cli.ts`. Purely additive.

**Files:**

- Create: `src/phases/abort.ts`
- Test: `src/phases/abort.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces (used by Tasks 3-8):
  - `class RunAbortedError extends Error` — distinct from ordinary `Error`s so `cli.ts` can map it to exit 130 and Electron can show a distinct cancelled state.
  - `function throwIfAborted(signal: AbortSignal): void` — throws `RunAbortedError` when `signal.aborted`.

- [ ] **Step 1: Write the failing tests** — create `src/phases/abort.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RunAbortedError, throwIfAborted } from './abort';

describe('throwIfAborted', () => {
  it('does nothing when the signal is not aborted', () => {
    const controller = new AbortController();
    expect(() => throwIfAborted(controller.signal)).not.toThrow();
  });

  it('throws RunAbortedError when the signal is aborted', () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(RunAbortedError);
  });

  it('RunAbortedError is a distinct error type', () => {
    const error = new RunAbortedError();
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('RunAbortedError');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/phases/abort.test.ts`
Expected: FAIL — module `./abort` cannot be found.

- [ ] **Step 3: Write the implementation** — create `src/phases/abort.ts`:

```ts
export class RunAbortedError extends Error {
  constructor() {
    super('Run aborted');
    this.name = 'RunAbortedError';
  }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new RunAbortedError();
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/phases/abort.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage`
Expected: all pass; coverage ≥ 80%.

- [ ] **Step 6: Commit, push, open PR, STOP**

```bash
git checkout -b feat/abort-primitive
git add src/phases/abort.ts src/phases/abort.test.ts
git commit -m "feat: add RunAbortedError and throwIfAborted primitive"
git push -u origin feat/abort-primitive
gh pr create --title "feat: add RunAbortedError and throwIfAborted primitive" --body "Adds the cooperative cancellation primitive: a distinct RunAbortedError and a throwIfAborted(signal) helper. Phases check the signal at safe points; cli.ts maps RunAbortedError to exit 130. Purely additive with tests."
```

**STOP AND WAIT.** Do not start Task 3 until this PR is reviewed and merged. Then run `git checkout main && git pull`.

---

### Task 3: Phase contract types and shared directory iteration

Add the `Phase`/`PhaseContext`/`PhaseResult` contract and the `iterateDirectories` helper that owns the directory loop, ignore-set check, `directoryStart` emission, and the between-directories abort check. Both phases (Tasks 5-6) consume this.

**Files:**

- Create: `src/phases/types.ts`
- Create: `src/phases/iterate-directories.ts`
- Test: `src/phases/iterate-directories.test.ts`

**Interfaces:**

- Consumes: `PhaseName` (`./types/run-summary`), `RunConfiguration` (`./types/configuration`), `Reporter` (`./output/reporter`), `ProgressSink` (`./types/progress`), `throwIfAborted` (`./abort`), `buildIgnoredSet`/`isIgnored` (`./utilities/path-helpers`).
- Produces (used by Tasks 4-8):
  - `interface Phase { name: PhaseName; enabled(config: RunConfiguration): boolean; run(ctx: PhaseContext): Promise<PhaseResult> }`
  - `type PhaseContext` — `{ config; db; reporter; progress; marker; signal }`.
  - `type PhaseResult` — discriminated union on `name`: `scan`, `resync`, `records`.
  - `async function iterateDirectories(phase, deps, body)` where `deps = { config; reporter; progress; signal }` and `body: (directory: string) => Promise<void>`.

- [ ] **Step 1: Write the failing tests** — create `src/phases/iterate-directories.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { iterateDirectories } from './iterate-directories';
import { RunAbortedError } from './abort';
import type { RunConfiguration } from '../types/configuration';
import type { Reporter } from '../output/reporter';

function makeConfig(directories: string[], ignoreDirectories: string[] = []): RunConfiguration {
  return {
    dbName: 'test.db',
    extensions: ['.txt'],
    directories,
    ignore_directories: ignoreDirectories,
    update_records: false,
    process_directories: false,
    resync_directories: false,
    resync_check_actual_file: false,
  };
}

function makeReporter(): Reporter {
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

describe('iterateDirectories', () => {
  it('calls the body once per non-ignored directory and emits directoryStart before it', async () => {
    const config = makeConfig(['/a', '/b']);
    const reporter = makeReporter();
    const progress = { emitProgress: vi.fn() };
    const body = vi.fn();

    await iterateDirectories('scan', { config, reporter, progress, signal: new AbortController().signal }, body);

    expect(body).toHaveBeenCalledTimes(2);
    expect(body).toHaveBeenNthCalledWith(1, '/a');
    expect(body).toHaveBeenNthCalledWith(2, '/b');
    expect(progress.emitProgress).toHaveBeenNthCalledWith(1, {
      type: 'directoryStart',
      phase: 'scan',
      directory: '/a',
    });
    expect(progress.emitProgress).toHaveBeenNthCalledWith(2, {
      type: 'directoryStart',
      phase: 'scan',
      directory: '/b',
    });
    expect(reporter.info).not.toHaveBeenCalled();
  });

  it('skips ignored directories with an info message', async () => {
    const config = makeConfig(['/a', '/ignored', '/b'], ['/ignored']);
    const reporter = makeReporter();
    const progress = { emitProgress: vi.fn() };
    const body = vi.fn();

    await iterateDirectories('resync', { config, reporter, progress, signal: new AbortController().signal }, body);

    expect(body).toHaveBeenCalledTimes(2);
    expect(reporter.info).toHaveBeenCalledWith('Ignoring directory: /ignored');
  });

  it('throws RunAbortedError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const body = vi.fn();

    await expect(
      iterateDirectories(
        'scan',
        {
          config: makeConfig(['/a']),
          reporter: makeReporter(),
          progress: { emitProgress: vi.fn() },
          signal: controller.signal,
        },
        body,
      ),
    ).rejects.toBeInstanceOf(RunAbortedError);
    expect(body).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/phases/iterate-directories.test.ts`
Expected: FAIL — module `./iterate-directories` cannot be found.

- [ ] **Step 3: Write the implementation** — create `src/phases/types.ts`:

```ts
import type { DbService } from '../services/db-service';
import type { Reporter } from '../output/reporter';
import type { RunConfiguration } from '../types/configuration';
import type { PhaseName } from '../types/run-summary';
import type { ProgressSink } from '../types/progress';

export interface Phase {
  name: PhaseName;
  enabled(config: RunConfiguration): boolean;
  run(ctx: PhaseContext): Promise<PhaseResult>;
}

export type PhaseContext = {
  config: RunConfiguration;
  db: DbService;
  reporter: Reporter; // output only: debug/info/warn
  progress: ProgressSink; // emit-only view of the progress channel
  marker: string; // "[n/total]" computed by the Runner
  signal: AbortSignal; // checked at safe points; abort throws RunAbortedError
};

export type PhaseResult =
  | { name: 'scan'; elapsedMs: number; errors: string[]; filesScanned: number; entriesUpserted: number }
  | { name: 'resync'; elapsedMs: number; errors: string[]; staleRemoved: number }
  | { name: 'records'; elapsedMs: number; errors: string[]; duplicateGroups: number; duplicateFiles: number };
```

And create `src/phases/iterate-directories.ts`:

```ts
import { buildIgnoredSet, isIgnored } from '../utilities/path-helpers';
import { throwIfAborted } from './abort';
import type { Reporter } from '../output/reporter';
import type { RunConfiguration } from '../types/configuration';
import type { PhaseName } from '../types/run-summary';
import type { ProgressSink } from '../types/progress';

type IterateDirectoriesDeps = {
  config: RunConfiguration;
  reporter: Reporter;
  progress: ProgressSink;
  signal: AbortSignal;
};

export async function iterateDirectories(
  phase: PhaseName,
  deps: IterateDirectoriesDeps,
  body: (directory: string) => Promise<void>,
): Promise<void> {
  const { config, reporter, progress, signal } = deps;
  const ignored = buildIgnoredSet(config.ignore_directories);

  for (const directory of config.directories) {
    throwIfAborted(signal);

    if (isIgnored(directory, ignored)) {
      reporter.info(`Ignoring directory: ${directory}`);
      continue;
    }

    progress.emitProgress({ type: 'directoryStart', phase, directory });
    await body(directory);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/phases/iterate-directories.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage`
Expected: all pass; coverage ≥ 80%.

- [ ] **Step 6: Commit, push, open PR, STOP**

```bash
git checkout -b feat/phase-contract-and-iteration
git add src/phases/types.ts src/phases/iterate-directories.ts src/phases/iterate-directories.test.ts
git commit -m "feat: add phase contract and shared directory iteration helper"
git push -u origin feat/phase-contract-and-iteration
gh pr create --title "feat: add phase contract and shared directory iteration helper" --body "Adds the Phase/PhaseContext/PhaseResult contract and iterateDirectories(), which owns the config.directories loop, ignore-set handling, directoryStart events, and the between-directories abort check. Consumed by the scan/resync phases next. Purely additive with tests."
```

**STOP AND WAIT.** Do not start Task 4 until this PR is reviewed and merged. Then run `git checkout main && git pull`.

---

### Task 4: `RecordsPhase`

Extract the synchronous records-rebuild into a phase class. Simplest phase — no directory iteration.

**Files:**

- Create: `src/phases/records-phase.ts`
- Test: `src/phases/records-phase.test.ts`

**Interfaces:**

- Consumes: `Phase`/`PhaseContext`/`PhaseResult` (`./types`), `throwIfAborted` (`./abort`), `RunConfiguration`, `DbService` methods `updateFileRecords()` and `getDuplicateStats()`.
- Produces (used by Task 7's `phases/index.ts`):
  - `class RecordsPhase implements Phase` — `name = 'records'`, `enabled(config)` returns `config.update_records`, `run(ctx)` returns `{ name: 'records'; elapsedMs; errors: []; duplicateGroups; duplicateFiles }`.
  - Emits only `phaseStart` (no `file`/`counts` events).

- [ ] **Step 1: Write the failing tests** — create `src/phases/records-phase.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { RecordsPhase } from './records-phase';
import { RunAbortedError } from './abort';
import type { DbService } from '../services/db-service';
import type { RunConfiguration } from '../types/configuration';
import type { Reporter } from '../output/reporter';
import type { ProgressSink } from '../types/progress';

function makeConfig(updateRecords = true): RunConfiguration {
  return {
    dbName: 'test.db',
    extensions: [],
    directories: [],
    ignore_directories: [],
    update_records: updateRecords,
    process_directories: false,
    resync_directories: false,
    resync_check_actual_file: false,
  };
}

function makeReporter(): Reporter {
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

describe('RecordsPhase', () => {
  it('is enabled only when update_records is true', () => {
    const phase = new RecordsPhase();
    expect(phase.enabled(makeConfig(true))).toBe(true);
    expect(phase.enabled(makeConfig(false))).toBe(false);
  });

  it('rebuilds records and returns the duplicate stats', async () => {
    const phase = new RecordsPhase();
    const db = {
      updateFileRecords: vi.fn(),
      getDuplicateStats: vi.fn(() => ({ duplicateGroups: 2, duplicateFiles: 3 })),
    };
    const progress = { emitProgress: vi.fn() } as ProgressSink;

    const result = await phase.run({
      config: makeConfig(),
      db: db as unknown as DbService,
      reporter: makeReporter(),
      progress,
      marker: '[3/3]',
      signal: new AbortController().signal,
    });

    expect(db.updateFileRecords).toHaveBeenCalledOnce();
    expect(progress.emitProgress).toHaveBeenCalledWith({
      type: 'phaseStart',
      phase: 'records',
      marker: '[3/3]',
    });
    expect(result).toEqual({
      name: 'records',
      elapsedMs: expect.any(Number),
      errors: [],
      duplicateGroups: 2,
      duplicateFiles: 3,
    });
  });

  it('throws RunAbortedError before rebuilding when the signal is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const db = { updateFileRecords: vi.fn(), getDuplicateStats: vi.fn() };

    await expect(
      new RecordsPhase().run({
        config: makeConfig(),
        db: db as unknown as DbService,
        reporter: makeReporter(),
        progress: { emitProgress: vi.fn() },
        marker: '[1/1]',
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RunAbortedError);
    expect(db.updateFileRecords as Mock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/phases/records-phase.test.ts`
Expected: FAIL — module `./records-phase` cannot be found.

- [ ] **Step 3: Write the implementation** — create `src/phases/records-phase.ts`:

```ts
import { throwIfAborted } from './abort';
import type { Phase, PhaseContext, PhaseResult } from './types';
import type { RunConfiguration } from '../types/configuration';

export class RecordsPhase implements Phase {
  readonly name = 'records' as const;

  enabled(config: RunConfiguration): boolean {
    return config.update_records;
  }

  async run(ctx: PhaseContext): Promise<PhaseResult> {
    const start = performance.now();
    ctx.progress.emitProgress({ type: 'phaseStart', phase: 'records', marker: ctx.marker });

    throwIfAborted(ctx.signal);
    ctx.db.updateFileRecords();
    const stats = ctx.db.getDuplicateStats();

    return {
      name: 'records',
      elapsedMs: Math.round(performance.now() - start),
      errors: [],
      duplicateGroups: stats.duplicateGroups,
      duplicateFiles: stats.duplicateFiles,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/phases/records-phase.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage`
Expected: all pass; coverage ≥ 80%.

- [ ] **Step 6: Commit, push, open PR, STOP**

```bash
git checkout -b feat/records-phase
git add src/phases/records-phase.ts src/phases/records-phase.test.ts
git commit -m "feat: extract records rebuild into RecordsPhase"
git push -u origin feat/records-phase
gh pr create --title "feat: extract records rebuild into RecordsPhase" --body "Extracts the synchronous records rebuild into a Phase implementation. Emits a phaseStart event, checks the abort signal before the rebuild, and returns duplicate stats via PhaseResult. Purely additive with tests."
```

**STOP AND WAIT.** Do not start Task 5 until this PR is reviewed and merged. Then run `git checkout main && git pull`.

---

### Task 5: `ScanPhase`

Extract the scan (process directories) phase into a `Phase` class, preserving the current per-file progress ordering and counter semantics.

**Files:**

- Create: `src/phases/scan-phase.ts`
- Test: `src/phases/scan-phase.test.ts`

**Interfaces:**

- Consumes: `Phase`/`PhaseContext`/`PhaseResult` (`./types`), `iterateDirectories` (`./iterate-directories`), `RunAbortedError`/`throwIfAborted` (`./abort`), `listFilesRecursive` (`./services/file-service`), `DbService.insertFileInfo`, `FileEntry`, `RunConfiguration`, `Reporter`, `ProgressSink`.
- Produces (used by Task 7):
  - `class ScanPhase implements Phase` — `name = 'scan'`, `enabled(config)` returns `config.process_directories`.
  - Returns `{ name: 'scan'; elapsedMs; errors; filesScanned; entriesUpserted }`.
  - Emits `phaseStart`, then per file a `file` event (`totalFiles: null`), then a `counts` event when a directory's walk completes (cumulative `filesProcessed`/`totalFiles`).
  - Directory-level listing failures are collected into `errors[]` with `reporter.warn` and iteration continues; `RunAbortedError` and DB errors propagate.

- [ ] **Step 1: Write the failing tests** — create `src/phases/scan-phase.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ScanPhase } from './scan-phase';
import { RunAbortedError } from './abort';
import type { DbService } from '../services/db-service';
import type { RunConfiguration } from '../types/configuration';
import type { Reporter } from '../output/reporter';

async function makeTempDir(prefix = 'scan-phase-'): Promise<string> {
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

function makeConfig(directory: string): RunConfiguration {
  return {
    dbName: 'test.db',
    extensions: ['.txt'],
    directories: [directory],
    ignore_directories: [],
    update_records: false,
    process_directories: true,
    resync_directories: false,
    resync_check_actual_file: false,
  };
}

function makeReporter(): Reporter {
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

describe('ScanPhase', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await makeTempDir();
  });

  afterEach(async () => {
    await removeDirRecursive(rootDir);
  });

  it('lists matching files, writes entries, and reports counters and events', async () => {
    await createFile(rootDir, 'src/a.txt', 'hello');
    await createFile(rootDir, 'src/sub/b.txt', 'world');

    const db = { insertFileInfo: vi.fn(() => 'inserted') };
    const progress = { emitProgress: vi.fn() };
    const reporter = makeReporter();

    const result = await new ScanPhase().run({
      config: makeConfig(join(rootDir, 'src')),
      db: db as unknown as DbService,
      reporter,
      progress,
      marker: '[1/2]',
      signal: new AbortController().signal,
    });

    expect(result.name).toBe('scan');
    expect(result.filesScanned).toBe(2);
    expect(result.entriesUpserted).toBe(2);
    expect(result.errors).toEqual([]);
    expect(db.insertFileInfo).toHaveBeenCalledTimes(2);

    expect(progress.emitProgress).toHaveBeenCalledWith({
      type: 'phaseStart',
      phase: 'scan',
      marker: '[1/2]',
    });
    expect(progress.emitProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'file',
        phase: 'scan',
        directory: join(rootDir, 'src'),
        currentFile: join(rootDir, 'src', 'a.txt'),
        filesProcessed: expect.any(Number),
        totalFiles: null,
      }),
    );
    expect(progress.emitProgress).toHaveBeenCalledWith({
      type: 'counts',
      phase: 'scan',
      filesProcessed: 2,
      totalFiles: 2,
    });
  });

  it('collects a directory listing error and continues with remaining directories', async () => {
    await createFile(rootDir, 'src/a.txt', 'hello');

    const config: RunConfiguration = {
      ...makeConfig(join(rootDir, 'src')),
      directories: [join(rootDir, 'missing'), join(rootDir, 'src')],
    };
    const reporter = makeReporter();

    const result = await new ScanPhase().run({
      config,
      db: { insertFileInfo: vi.fn(() => 'inserted') } as unknown as DbService,
      reporter,
      progress: { emitProgress: vi.fn() },
      marker: '[1/1]',
      signal: new AbortController().signal,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(join(rootDir, 'missing'));
    expect(result.filesScanned).toBe(1);
    expect(reporter.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to scan directory'));
  });

  it('throws RunAbortedError when the signal is already aborted and writes nothing', async () => {
    await createFile(rootDir, 'src/a.txt', 'hello');
    const controller = new AbortController();
    controller.abort();
    const db = { insertFileInfo: vi.fn(() => 'inserted') };

    await expect(
      new ScanPhase().run({
        config: makeConfig(join(rootDir, 'src')),
        db: db as unknown as DbService,
        reporter: makeReporter(),
        progress: { emitProgress: vi.fn() },
        marker: '[1/1]',
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RunAbortedError);
    expect(db.insertFileInfo).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/phases/scan-phase.test.ts`
Expected: FAIL — module `./scan-phase` cannot be found.

- [ ] **Step 3: Write the implementation** — create `src/phases/scan-phase.ts`:

```ts
import { listFilesRecursive } from '../services/file-service';
import { iterateDirectories } from './iterate-directories';
import { RunAbortedError, throwIfAborted } from './abort';
import type { Phase, PhaseContext, PhaseResult } from './types';
import type { RunConfiguration } from '../types/configuration';
import type { FileEntry } from '../types/file-types';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ScanPhase implements Phase {
  readonly name = 'scan' as const;

  enabled(config: RunConfiguration): boolean {
    return config.process_directories;
  }

  async run(ctx: PhaseContext): Promise<PhaseResult> {
    const start = performance.now();
    ctx.progress.emitProgress({ type: 'phaseStart', phase: 'scan', marker: ctx.marker });

    let filesScanned = 0;
    let entriesUpserted = 0;
    let filesProcessed = 0;
    const errors: string[] = [];

    await iterateDirectories(
      'scan',
      { config: ctx.config, reporter: ctx.reporter, progress: ctx.progress, signal: ctx.signal },
      async (directory) => {
        let files: FileEntry[];
        try {
          files = await listFilesRecursive(
            directory,
            ctx.config.extensions,
            true,
            ctx.config.ignore_directories,
            (filePath) => {
              throwIfAborted(ctx.signal);
              filesProcessed += 1;
              ctx.progress.emitProgress({
                type: 'file',
                phase: 'scan',
                directory,
                currentFile: filePath,
                filesProcessed,
                totalFiles: null,
              });
            },
          );
        } catch (err) {
          if (err instanceof RunAbortedError) {
            throw err;
          }
          errors.push(`Scan ${directory}: ${errorMessage(err)}`);
          ctx.reporter.warn(`Failed to scan directory: ${directory} (${errorMessage(err)})`);
          return;
        }

        ctx.progress.emitProgress({ type: 'counts', phase: 'scan', filesProcessed, totalFiles: filesProcessed });

        filesScanned += files.length;
        for (const file of files) {
          throwIfAborted(ctx.signal);
          const status = ctx.db.insertFileInfo(file);
          ctx.reporter.debug(`Upserted (${status}) ${file.path}`);
          entriesUpserted += 1;
        }
      },
    );

    return {
      name: 'scan',
      elapsedMs: Math.round(performance.now() - start),
      errors,
      filesScanned,
      entriesUpserted,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/phases/scan-phase.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage`
Expected: all pass; coverage ≥ 80%.

- [ ] **Step 6: Commit, push, open PR, STOP**

```bash
git checkout -b feat/scan-phase
git add src/phases/scan-phase.ts src/phases/scan-phase.test.ts
git commit -m "feat: extract directory scan into ScanPhase"
git push -u origin feat/scan-phase
gh pr create --title "feat: extract directory scan into ScanPhase" --body "Extracts the directory-scan phase into a Phase implementation. Emits phaseStart, per-file file events (totalFiles null), and a counts event when each directory walk completes; collects per-directory listing errors; checks the abort signal during the walk and per DB write. Purely additive with tests."
```

**STOP AND WAIT.** Do not start Task 6 until this PR is reviewed and merged. Then run `git checkout main && git pull`.

---

### Task 6: `ResyncPhase`

Extract the resync phase (both `resync_check_actual_file` modes) into a `Phase` class, preserving the current two-pass per-entry progress ordering in listing mode.

**Files:**

- Create: `src/phases/resync-phase.ts`
- Test: `src/phases/resync-phase.test.ts`

**Interfaces:**

- Consumes: `Phase`/`PhaseContext`/`PhaseResult` (`./types`), `iterateDirectories` (`./iterate-directories`), `RunAbortedError`/`throwIfAborted` (`./abort`), `fileExists`/`listFilePathsRecursive` (`./services/file-service`), `normalizePath` (`./utilities/path-helpers`), `DbService` methods `getFileEntriesByDirectory`/`deleteFileEntryByPath`, `RunConfiguration`, `Reporter`, `ProgressSink`.
- Produces (used by Task 7):
  - `class ResyncPhase implements Phase` — `name = 'resync'`, `enabled(config)` returns `config.resync_directories`.
  - Returns `{ name: 'resync'; elapsedMs; errors; staleRemoved }`.
  - `checkActualFile` mode: `counts` at directory start (total = cumulative processed + entries), then one `file` event per entry existence-checked.
  - Listing mode: listing pass emits `file` events (`totalFiles: null`); when the listing completes a `counts` event fires (cumulative totals); the verification pass emits one `file` event per DB entry checked.
  - Directory-level listing failures are collected into `errors[]` with `reporter.warn`; `RunAbortedError` and DB errors propagate.

- [ ] **Step 1: Write the failing tests** — create `src/phases/resync-phase.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { ResyncPhase } from './resync-phase';
import { RunAbortedError } from './abort';
import type { DbService } from '../services/db-service';
import type { RunConfiguration } from '../types/configuration';
import type { Reporter } from '../output/reporter';
import type { FileEntry } from '../types/file-types';

async function makeTempDir(prefix = 'resync-phase-'): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), prefix));
}

async function removeDirRecursive(path: string): Promise<void> {
  await fs.rm(path, { recursive: true, force: true });
}

function makeConfig(directory: string, checkActualFile: boolean): RunConfiguration {
  return {
    dbName: 'test.db',
    extensions: ['.txt'],
    directories: [directory],
    ignore_directories: [],
    update_records: false,
    process_directories: false,
    resync_directories: true,
    resync_check_actual_file: checkActualFile,
  };
}

function makeEntry(path: string): FileEntry {
  return {
    size: 10,
    directory: dirname(path),
    extension: '.txt',
    path,
    filename: basename(path),
    birthtime: new Date('2025-01-01T00:00:00.000Z'),
    hash: 'abc',
  };
}

function makeReporter(): Reporter {
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

describe('ResyncPhase', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await makeTempDir();
  });

  afterEach(async () => {
    await removeDirRecursive(rootDir);
  });

  it('removes stale entries when checkActualFile is true', async () => {
    const src = join(rootDir, 'src');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(join(src, 'a.txt'), 'alpha');
    const gone = join(src, 'gone.txt');

    const db = {
      getFileEntriesByDirectory: vi.fn(() => [makeEntry(join(src, 'a.txt')), makeEntry(gone)]),
      deleteFileEntryByPath: vi.fn(),
    };
    const progress = { emitProgress: vi.fn() };

    const result = await new ResyncPhase().run({
      config: makeConfig(src, true),
      db: db as unknown as DbService,
      reporter: makeReporter(),
      progress,
      marker: '[1/2]',
      signal: new AbortController().signal,
    });

    expect(result.staleRemoved).toBe(1);
    expect(db.deleteFileEntryByPath).toHaveBeenCalledWith(gone);
    expect(progress.emitProgress).toHaveBeenCalledWith({
      type: 'counts',
      phase: 'resync',
      filesProcessed: 0,
      totalFiles: 2,
    });
    expect(progress.emitProgress).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'file', phase: 'resync', currentFile: gone, totalFiles: 2 }),
    );
  });

  it('removes stale entries via a directory listing when checkActualFile is false', async () => {
    const src = join(rootDir, 'src');
    await fs.mkdir(src, { recursive: true });
    await fs.writeFile(join(src, 'a.txt'), 'alpha');
    await fs.writeFile(join(src, 'b.txt'), 'bravo');
    const stale = join(src, 'stale.txt');

    const db = {
      getFileEntriesByDirectory: vi.fn(() => [makeEntry(join(src, 'a.txt')), makeEntry(stale)]),
      deleteFileEntryByPath: vi.fn(),
    };

    const result = await new ResyncPhase().run({
      config: makeConfig(src, false),
      db: db as unknown as DbService,
      reporter: makeReporter(),
      progress: { emitProgress: vi.fn() },
      marker: '[1/2]',
      signal: new AbortController().signal,
    });

    expect(result.staleRemoved).toBe(1);
    expect(db.deleteFileEntryByPath).toHaveBeenCalledWith(stale);
    expect(db.deleteFileEntryByPath).not.toHaveBeenCalledWith(join(src, 'a.txt'));
  });

  it('collects a listing error and continues', async () => {
    const reporter = makeReporter();

    const result = await new ResyncPhase().run({
      config: makeConfig(join(rootDir, 'missing'), false),
      db: { getFileEntriesByDirectory: vi.fn(() => []), deleteFileEntryByPath: vi.fn() } as unknown as DbService,
      reporter,
      progress: { emitProgress: vi.fn() },
      marker: '[1/1]',
      signal: new AbortController().signal,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(join(rootDir, 'missing'));
    expect(reporter.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to resync directory'));
  });

  it('throws RunAbortedError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      new ResyncPhase().run({
        config: makeConfig(join(rootDir, 'src'), true),
        db: { getFileEntriesByDirectory: vi.fn(() => []), deleteFileEntryByPath: vi.fn() } as unknown as DbService,
        reporter: makeReporter(),
        progress: { emitProgress: vi.fn() },
        marker: '[1/1]',
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RunAbortedError);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/phases/resync-phase.test.ts`
Expected: FAIL — module `./resync-phase` cannot be found.

- [ ] **Step 3: Write the implementation** — create `src/phases/resync-phase.ts`:

```ts
import { fileExists, listFilePathsRecursive } from '../services/file-service';
import { normalizePath } from '../utilities/path-helpers';
import { iterateDirectories } from './iterate-directories';
import { RunAbortedError, throwIfAborted } from './abort';
import type { Phase, PhaseContext, PhaseResult } from './types';
import type { RunConfiguration } from '../types/configuration';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ResyncPhase implements Phase {
  readonly name = 'resync' as const;

  enabled(config: RunConfiguration): boolean {
    return config.resync_directories;
  }

  async run(ctx: PhaseContext): Promise<PhaseResult> {
    const start = performance.now();
    ctx.progress.emitProgress({ type: 'phaseStart', phase: 'resync', marker: ctx.marker });

    let staleRemoved = 0;
    let filesProcessed = 0;
    const errors: string[] = [];

    await iterateDirectories(
      'resync',
      { config: ctx.config, reporter: ctx.reporter, progress: ctx.progress, signal: ctx.signal },
      async (directory) => {
        const entries = ctx.db.getFileEntriesByDirectory(directory);

        if (ctx.config.resync_check_actual_file) {
          const dirTotal = filesProcessed + entries.length;
          ctx.progress.emitProgress({ type: 'counts', phase: 'resync', filesProcessed, totalFiles: dirTotal });

          for (const entry of entries) {
            throwIfAborted(ctx.signal);
            filesProcessed += 1;
            ctx.progress.emitProgress({
              type: 'file',
              phase: 'resync',
              directory,
              currentFile: entry.path,
              filesProcessed,
              totalFiles: dirTotal,
            });
            ctx.reporter.debug(`Checking file existence: ${entry.path}`);
            const exists = await fileExists(entry.path);
            if (!exists) {
              ctx.db.deleteFileEntryByPath(entry.path);
              staleRemoved += 1;
            }
          }
          return;
        }

        let files: string[];
        try {
          files = await listFilePathsRecursive(directory, ctx.config.ignore_directories, (filePath) => {
            throwIfAborted(ctx.signal);
            filesProcessed += 1;
            ctx.progress.emitProgress({
              type: 'file',
              phase: 'resync',
              directory,
              currentFile: filePath,
              filesProcessed,
              totalFiles: null,
            });
          });
        } catch (err) {
          if (err instanceof RunAbortedError) {
            throw err;
          }
          errors.push(`Resync ${directory}: ${errorMessage(err)}`);
          ctx.reporter.warn(`Failed to resync directory: ${directory} (${errorMessage(err)})`);
          return;
        }

        const dirTotal = filesProcessed + entries.length;
        ctx.progress.emitProgress({ type: 'counts', phase: 'resync', filesProcessed, totalFiles: dirTotal });

        const currentPaths = new Set(files.map(normalizePath));
        for (const entry of entries) {
          throwIfAborted(ctx.signal);
          filesProcessed += 1;
          ctx.progress.emitProgress({
            type: 'file',
            phase: 'resync',
            directory,
            currentFile: entry.path,
            filesProcessed,
            totalFiles: dirTotal,
          });
          ctx.reporter.debug(`Verifying file entry: ${entry.path}`);
          if (!currentPaths.has(normalizePath(entry.path))) {
            ctx.db.deleteFileEntryByPath(entry.path);
            staleRemoved += 1;
          }
        }
      },
    );

    return {
      name: 'resync',
      elapsedMs: Math.round(performance.now() - start),
      errors,
      staleRemoved,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/phases/resync-phase.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage`
Expected: all pass; coverage ≥ 80%.

- [ ] **Step 6: Commit, push, open PR, STOP**

```bash
git checkout -b feat/resync-phase
git add src/phases/resync-phase.ts src/phases/resync-phase.test.ts
git commit -m "feat: extract resync into ResyncPhase"
git push -u origin feat/resync-phase
gh pr create --title "feat: extract resync into ResyncPhase" --body "Extracts the resync phase into a Phase implementation supporting both checkActualFile modes. Emits phaseStart, counts, and per-entry file events (listing mode keeps the two-pass progress). Collects per-directory listing errors and checks the abort signal. Purely additive with tests."
```

**STOP AND WAIT.** Do not start Task 7 until this PR is reviewed and merged. Then run `git checkout main && git pull`.

---

### Task 7: `CliReporter.subscribe` adapter

Add `subscribe(progress)` to `CliReporter` that reproduces the exact current CLI strings from progress events. The `Reporter` interface is **unchanged** in this task (the slim happens in Task 8). This is the only place that maps events to text.

**Files:**

- Modify: `src/output/reporter.ts`
- Test: `src/output/reporter.test.ts`

**Interfaces:**

- Consumes: `ProgressEmitter` (`./progress`), `ProgressEvent` (`../types/progress`), `PhaseName` (`../types/run-summary`), `relative` (`node:path`).
- Produces (used by Task 8's `cli.ts`):
  - `CliReporter.subscribe(progress: ProgressEmitter): void` — registers handlers reproducing the exact strings:
    - `phaseStart` → `info("${marker} ${label}")` (label `Scanning…`/`Resyncing…`/`Rebuilding records…`), **then** `progress(...)` with the same text (info-then-progress ordering is a contract).
    - `directoryStart` → `progress("${verb} ${directory}")` (verb `Scanning`/`Resyncing`).
    - `file` → `progress("${verb} ${directory} → ${relative(directory, currentFile)}")`.
    - `counts` → ignored.

- [ ] **Step 1: Write the failing tests** — append to `src/output/reporter.test.ts`:

```ts
import { ProgressEmitter } from './progress';
```

(update the existing import block to add `import { ProgressEmitter } from './progress';` and `import { relative } from 'node:path';`) and append these tests inside `describe('CliReporter', ...)`:

```ts
describe('subscribe', () => {
  it('prints the phase marker line then restarts the spinner on phaseStart', () => {
    const reporter = new CliReporter({ quiet: false, verbose: false, progress: true });
    const progress = new ProgressEmitter();
    reporter.subscribe(progress);

    progress.emitProgress({ type: 'phaseStart', phase: 'scan', marker: '[1/3]' });

    expect(consoleLog).toHaveBeenCalledWith('[1/3] Scanning…');
    // info-then-progress ordering is a contract: the marker line prints before the spinner restarts
    expect(consoleLog).toHaveBeenCalledBefore(vi.mocked(createSpinner));
    expect(createSpinner).toHaveBeenCalledWith('[1/3] Scanning…');
  });

  it('maps phaseStart for resync and records labels', () => {
    const reporter = new CliReporter({ quiet: false, verbose: false, progress: false });
    const progress = new ProgressEmitter();
    reporter.subscribe(progress);

    progress.emitProgress({ type: 'phaseStart', phase: 'resync', marker: '[2/3]' });
    progress.emitProgress({ type: 'phaseStart', phase: 'records', marker: '[3/3]' });

    expect(consoleLog).toHaveBeenCalledWith('[2/3] Resyncing…');
    expect(consoleLog).toHaveBeenCalledWith('[3/3] Rebuilding records…');
  });

  it('maps directoryStart to a Scanning progress line', () => {
    const reporter = new CliReporter({ quiet: false, verbose: false, progress: true });
    const progress = new ProgressEmitter();
    reporter.subscribe(progress);

    progress.emitProgress({ type: 'directoryStart', phase: 'scan', directory: 'C:\\Pics' });

    expect(createSpinner).toHaveBeenCalledWith('Scanning C:\\Pics');
  });

  it('maps file events to the relative current-file progress line', () => {
    const reporter = new CliReporter({ quiet: false, verbose: false, progress: true });
    const progress = new ProgressEmitter();
    reporter.subscribe(progress);

    progress.emitProgress({
      type: 'file',
      phase: 'scan',
      directory: 'C:\\Pics',
      currentFile: 'C:\\Pics\\sub\\a.txt',
      filesProcessed: 1,
      totalFiles: null,
    });

    expect(createSpinner).toHaveBeenCalledWith(`Scanning C:\\Pics → ${relative('C:\\Pics', 'C:\\Pics\\sub\\a.txt')}`);
  });

  it('uses the Resyncing verb for resync file events', () => {
    const reporter = new CliReporter({ quiet: false, verbose: false, progress: true });
    const progress = new ProgressEmitter();
    reporter.subscribe(progress);

    progress.emitProgress({
      type: 'file',
      phase: 'resync',
      directory: 'C:\\Pics',
      currentFile: 'C:\\Pics\\a.txt',
      filesProcessed: 1,
      totalFiles: 2,
    });

    expect(createSpinner).toHaveBeenCalledWith(`Resyncing C:\\Pics → ${relative('C:\\Pics', 'C:\\Pics\\a.txt')}`);
  });

  it('ignores counts events', () => {
    const reporter = new CliReporter({ quiet: false, verbose: false, progress: true });
    const progress = new ProgressEmitter();
    reporter.subscribe(progress);

    progress.emitProgress({ type: 'counts', phase: 'scan', filesProcessed: 5, totalFiles: 5 });

    expect(createSpinner).not.toHaveBeenCalled();
    expect(consoleLog).not.toHaveBeenCalled();
  });
});
```

Add `import { relative } from 'node:path';` at the top of `src/output/reporter.test.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/output/reporter.test.ts`
Expected: FAIL — `subscribe` is not a function.

- [ ] **Step 3: Write the implementation** — replace the entire contents of `src/output/reporter.ts`:

```ts
import { relative } from 'node:path';
import { createSpinner } from 'nanospinner';
import type { Spinner } from 'nanospinner';
import type { ProgressEmitter } from './progress';
import type { RunSummary } from '../types/run-summary';
import type { PhaseName } from '../types/run-summary';

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

const PHASE_START_LABELS: Record<PhaseName, string> = {
  scan: 'Scanning…',
  resync: 'Resyncing…',
  records: 'Rebuilding records…',
};

export class CliReporter implements Reporter {
  private spinner: Spinner | null = null;

  constructor(private readonly options: ReporterOptions) {}

  debug(msg: string): void {
    if (this.options.verbose && !this.options.quiet) {
      this.stopProgress();
      console.log(`[debug] ${msg}`);
    }
  }

  info(msg: string): void {
    if (!this.options.quiet) {
      this.stopProgress();
      console.log(msg);
    }
  }

  warn(msg: string): void {
    this.stopProgress();
    console.warn(msg);
  }

  error(msg: string): void {
    this.stopProgress();
    console.error(msg);
  }

  // Quiet mode means "warnings and errors only", so it suppresses the spinner
  // as well; `--no-progress` disables it for piped output.
  progress(msg: string): void {
    if (!this.options.progress || this.options.quiet) {
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

  subscribe(progress: ProgressEmitter): void {
    progress.on((event) => {
      switch (event.type) {
        case 'phaseStart':
          this.info(`${event.marker} ${PHASE_START_LABELS[event.phase]}`);
          this.progress(`${event.marker} ${PHASE_START_LABELS[event.phase]}`);
          break;
        case 'directoryStart':
          this.progress(`${event.phase === 'scan' ? 'Scanning' : 'Resyncing'} ${event.directory}`);
          break;
        case 'file':
          this.progress(
            `${event.phase === 'scan' ? 'Scanning' : 'Resyncing'} ${event.directory} → ${relative(event.directory, event.currentFile)}`,
          );
          break;
        case 'counts':
          break;
      }
    });
  }

  printSummary(summary: RunSummary): void {
    for (const phase of summary.phases) {
      switch (phase.name) {
        case 'scan':
          this.info(
            `Scan: ${summary.filesScanned} files scanned, ${summary.entriesUpserted} entries upserted (${phase.elapsedMs} ms)`,
          );
          break;
        case 'resync':
          this.info(`Resync: ${summary.staleRemoved} stale entries removed (${phase.elapsedMs} ms)`);
          break;
        case 'records':
          this.info(
            `Records: ${summary.duplicateGroups} duplicate group${summary.duplicateGroups === 1 ? '' : 's'}, ${summary.duplicateFiles} duplicate file${summary.duplicateFiles === 1 ? '' : 's'} (${phase.elapsedMs} ms)`,
          );
          break;
        default: {
          const exhaustiveCheck: never = phase.name;
          throw new Error(`Unhandled phase: ${exhaustiveCheck}`);
        }
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

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/output/reporter.test.ts`
Expected: PASS — all existing reporter tests plus the 6 new subscribe tests.

- [ ] **Step 5: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage`
Expected: all pass; coverage ≥ 80%.

- [ ] **Step 6: Commit, push, open PR, STOP**

```bash
git checkout -b feat/reporter-subscribe
git add src/output/reporter.ts src/output/reporter.test.ts
git commit -m "feat: add CliReporter subscribe adapter over progress events"
git push -u origin feat/reporter-subscribe
gh pr create --title "feat: add CliReporter subscribe adapter over progress events" --body "CliReporter gains subscribe(progress), which reproduces the exact current CLI strings (phase markers with info-then-progress ordering, per-directory and per-file progress) from ProgressEmitter events. The Reporter interface is unchanged in this task; the Runner still drives progress directly until the swap."
```

**STOP AND WAIT.** Do not start Task 8 until this PR is reviewed and merged. Then run `git checkout main && git pull`.

---

### Task 8: Runner rewrite, Reporter slim, `phases/index.ts`, CLI wiring — the swap

The core migration. `Runner` becomes a thin orchestrator over `PHASES`; the `Reporter` interface slims to output-only; `cli.ts` wires `ProgressEmitter`, `subscribe`, and the abort controller (SIGINT → abort, exit 130).

**Files:**

- Create: `src/phases/index.ts`
- Rewrite: `src/runner.ts`
- Rewrite: `src/runner.test.ts`
- Modify: `src/output/reporter.ts` (slim interface; keep `progress`/`stopProgress` as public methods on `CliReporter`)
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**

- Consumes:
  - `PHASES` from `./phases` (Task 4-6 classes).
  - `PhaseContext`, `PhaseResult` from `./phases/types`.
  - `ProgressSink` from `./types/progress`.
  - `ProgressEmitter` from `./output/progress` (Task 1).
  - `RunAbortedError` from `./phases/abort` (Task 2).
  - Slimmed `Reporter` from `./output/reporter`.
- Produces:
  - `class Runner` — `constructor(config, deps: { reporter; progress; signal })`, `run(): Promise<RunSummary>`, `close()`.
  - `const PHASES: Phase[]` — `[ScanPhase, ResyncPhase, RecordsPhase]` singletons.
  - `interface Reporter` — `debug | info | warn | error | printSummary` only.
  - `CliReporter` — keeps public `progress()` and `stopProgress()`, gains nothing new (Task 7 added `subscribe`).
  - `main(argv): Promise<number>` — exit codes: `0` success, `1` config/CLI errors, `2` fatal run error, `130` cancelled (via SIGINT → abort).

- [ ] **Step 1: Update the tests first** — rewrite `src/runner.test.ts` with the new constructor, event-based progress assertions, and a new abort test:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import Database from 'better-sqlite3';
import { Runner } from './runner';
import { RunAbortedError } from './phases/abort';
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
  printSummary: Mock;
};

function makeMockReporter(): MockReporter {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    printSummary: vi.fn(),
  };
}

type MockProgress = { emitProgress: Mock };

function makeMockProgress(): MockProgress {
  return { emitProgress: vi.fn() };
}

function makeDeps(
  reporter: MockReporter = makeMockReporter(),
  progress: MockProgress = makeMockProgress(),
  signal: AbortSignal = new AbortController().signal,
): { reporter: MockReporter; progress: MockProgress; signal: AbortSignal } {
  return { reporter, progress, signal };
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

    const runner = new Runner(makeConfig(dbPath, rootDir), makeDeps());
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
    const runner = new Runner(config, makeDeps());
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
    const runner = new Runner(config, makeDeps());
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
    const runner = new Runner(config, makeDeps());
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
    const runner = new Runner(config, makeDeps());
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
    const runner = new Runner(makeConfig(dbPath, join(rootDir, 'src')), makeDeps());
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
    const progress = makeMockProgress();
    const resyncRunner = new Runner(resyncConfig, makeDeps(makeMockReporter(), progress));
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
    // resync + records enabled -> resync marker is [1/2]
    expect(progress.emitProgress).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'phaseStart', phase: 'resync', marker: '[1/2]' }),
    );
  });

  it('resyncs against the current directory listing when checkActualFile is false', async () => {
    const fileToDelete = await createFile(rootDir, 'src/a.txt', 'alpha');
    await createFile(rootDir, 'src/b.txt', 'bravo');

    const runner = new Runner(makeConfig(dbPath, join(rootDir, 'src')), makeDeps());
    await runner.run();
    runner.close();

    await fs.unlink(fileToDelete);
    const resyncConfig: RunConfiguration = {
      ...makeConfig(dbPath, join(rootDir, 'src')),
      process_directories: false,
      resync_directories: true,
      resync_check_actual_file: false,
    };
    const resyncRunner = new Runner(resyncConfig, makeDeps());
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
    const runner = new Runner(config, makeDeps(reporter));
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

  it('collects resync errors and continues with remaining directories', async () => {
    await createFile(rootDir, 'src/a.txt', 'alpha');
    await createFile(rootDir, 'src/b.txt', 'bravo');

    const runner = new Runner(makeConfig(dbPath, join(rootDir, 'src')), makeDeps());
    await runner.run();
    runner.close();

    const resyncConfig: RunConfiguration = {
      ...makeConfig(dbPath, join(rootDir, 'src')),
      process_directories: false,
      resync_directories: true,
      resync_check_actual_file: false,
      directories: [join(rootDir, 'src-missing'), join(rootDir, 'src')],
    };
    const reporter = makeMockReporter();
    const resyncRunner = new Runner(resyncConfig, makeDeps(reporter));
    const summary = await resyncRunner.run();
    resyncRunner.close();

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain(join(rootDir, 'src-missing'));
    expect(summary.staleRemoved).toBe(0);
    expect(reporter.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to resync directory'));
  });

  it('emits phase markers for the enabled phases', async () => {
    await createFile(rootDir, 'src/a.txt', 'hello');

    const progress = makeMockProgress();
    const runner = new Runner(makeConfig(dbPath, join(rootDir, 'src')), makeDeps(makeMockReporter(), progress));
    await runner.run();
    runner.close();

    // makeConfig enables scan + records (no resync) -> markers are [1/2] and [2/2]
    expect(progress.emitProgress).toHaveBeenCalledWith({
      type: 'phaseStart',
      phase: 'scan',
      marker: '[1/2]',
    });
    expect(progress.emitProgress).toHaveBeenCalledWith({
      type: 'phaseStart',
      phase: 'records',
      marker: '[2/2]',
    });
  });

  it('emits file progress with the current file during scanning', async () => {
    await createFile(rootDir, 'src/sub/a.txt', 'hello');

    const progress = makeMockProgress();
    const runner = new Runner(makeConfig(dbPath, join(rootDir, 'src')), makeDeps(makeMockReporter(), progress));
    await runner.run();
    runner.close();

    expect(progress.emitProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'file',
        phase: 'scan',
        directory: join(rootDir, 'src'),
        currentFile: join(rootDir, 'src', 'sub', 'a.txt'),
      }),
    );
  });

  it('emits file progress with the current entry during resync (check actual file)', async () => {
    await createFile(rootDir, 'src/a.txt', 'alpha');

    const runner = new Runner(makeConfig(dbPath, join(rootDir, 'src')), makeDeps());
    await runner.run();
    runner.close();

    const resyncConfig: RunConfiguration = {
      ...makeConfig(dbPath, join(rootDir, 'src')),
      process_directories: false,
      resync_directories: true,
      resync_check_actual_file: true,
    };
    const progress = makeMockProgress();
    const resyncRunner = new Runner(resyncConfig, makeDeps(makeMockReporter(), progress));
    await resyncRunner.run();
    resyncRunner.close();

    expect(progress.emitProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'file',
        phase: 'resync',
        directory: join(rootDir, 'src'),
        currentFile: join(rootDir, 'src', 'a.txt'),
      }),
    );
  });

  it('emits file progress with the current entry during resync (directory listing)', async () => {
    await createFile(rootDir, 'src/a.txt', 'alpha');

    const runner = new Runner(makeConfig(dbPath, join(rootDir, 'src')), makeDeps());
    await runner.run();
    runner.close();

    const resyncConfig: RunConfiguration = {
      ...makeConfig(dbPath, join(rootDir, 'src')),
      process_directories: false,
      resync_directories: true,
      resync_check_actual_file: false,
    };
    const progress = makeMockProgress();
    const resyncRunner = new Runner(resyncConfig, makeDeps(makeMockReporter(), progress));
    await resyncRunner.run();
    resyncRunner.close();

    expect(progress.emitProgress).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'file',
        phase: 'resync',
        directory: join(rootDir, 'src'),
        currentFile: join(rootDir, 'src', 'a.txt'),
      }),
    );
  });

  it('rejects with RunAbortedError when the signal is already aborted and writes nothing', async () => {
    await createFile(rootDir, 'src/a.txt', 'hello');

    const controller = new AbortController();
    controller.abort();
    const runner = new Runner(
      makeConfig(dbPath, join(rootDir, 'src')),
      makeDeps(makeMockReporter(), makeMockProgress(), controller.signal),
    );
    await expect(runner.run()).rejects.toBeInstanceOf(RunAbortedError);
    runner.close();

    const db = new Database(dbPath);
    const count = db.prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number };
    db.close();
    expect(count.c).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/runner.test.ts`
Expected: FAIL — Runner constructor no longer matches, `run()` returns the new summary shape but progress assertions fail.

- [ ] **Step 3: Write the implementation** — create `src/phases/index.ts`:

```ts
import { RecordsPhase } from './records-phase';
import { ResyncPhase } from './resync-phase';
import { ScanPhase } from './scan-phase';
import type { Phase } from './types';

// Phases are stateless singletons — all deps arrive via the PhaseContext.
export const PHASES: Phase[] = [new ScanPhase(), new ResyncPhase(), new RecordsPhase()];
```

Rewrite `src/runner.ts`:

```ts
import { DbService } from './services/db-service';
import { PHASES } from './phases';
import type { Reporter } from './output/reporter';
import type { ProgressSink } from './types/progress';
import type { RunConfiguration } from './types/configuration';
import type { PhaseContext, PhaseResult } from './phases/types';
import type { RunSummary } from './types/run-summary';

type RunnerDeps = {
  reporter: Reporter;
  progress: ProgressSink;
  signal: AbortSignal;
};

export class Runner {
  private db: DbService;
  private config: RunConfiguration;
  private deps: RunnerDeps;

  constructor(config: RunConfiguration, deps: RunnerDeps) {
    this.config = config;
    this.deps = deps;
    this.db = new DbService(config.dbName);
  }

  close() {
    this.db.close();
  }

  async run(): Promise<RunSummary> {
    const summary: RunSummary = {
      phases: [],
      filesScanned: 0,
      entriesUpserted: 0,
      duplicateGroups: 0,
      duplicateFiles: 0,
      staleRemoved: 0,
      errors: [],
    };

    const enabled = PHASES.filter((phase) => phase.enabled(this.config));

    for (let i = 0; i < enabled.length; i += 1) {
      const phase = enabled[i];
      const marker = `[${i + 1}/${enabled.length}]`;
      const ctx: PhaseContext = {
        config: this.config,
        db: this.db,
        reporter: this.deps.reporter,
        progress: this.deps.progress,
        marker,
        signal: this.deps.signal,
      };
      const result: PhaseResult = await phase.run(ctx);
      summary.phases.push({ name: result.name, elapsedMs: result.elapsedMs });
      switch (result.name) {
        case 'scan':
          summary.filesScanned = result.filesScanned;
          summary.entriesUpserted = result.entriesUpserted;
          break;
        case 'resync':
          summary.staleRemoved = result.staleRemoved;
          break;
        case 'records':
          summary.duplicateGroups = result.duplicateGroups;
          summary.duplicateFiles = result.duplicateFiles;
          break;
      }
      summary.errors.push(...result.errors);
    }

    return summary;
  }
}
```

Slim `src/output/reporter.ts` — the only change from the Task 7 version is the `Reporter` interface (drop `progress` and `stopProgress`; `CliReporter` keeps them as public methods):

```ts
export interface Reporter {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  printSummary(summary: RunSummary): void;
}
```

Rewrite `src/cli.ts`:

```ts
import { Command, CommanderError } from 'commander';
import { version } from '../package.json';
import { Runner } from './runner';
import { CliReporter } from './output/reporter';
import { ProgressEmitter } from './output/progress';
import { RunAbortedError } from './phases/abort';
import { loadRunConfiguration } from './utilities/load-config';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function main(argv: string[]): Promise<number> {
  // pnpm run forwards the `--` separator literally (e.g. `pnpm start -- --config x`),
  // so drop a single leading separator before commander sees it.
  const args = argv[0] === '--' ? argv.slice(1) : argv;

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
    program.parse(args, { from: 'user' });
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

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);

  let config;
  try {
    config = await loadRunConfiguration(opts.config);
  } catch (err) {
    process.removeListener('SIGINT', onSigint);
    reporter.error(`Invalid config: ${errorMessage(err)}`);
    return 1;
  }

  const progress = new ProgressEmitter();
  reporter.subscribe(progress);

  let runner: Runner | undefined;
  try {
    runner = new Runner(config, { reporter, progress, signal: controller.signal });
    const summary = await runner.run();
    reporter.stopProgress();
    reporter.printSummary(summary);
    return 0;
  } catch (err) {
    if (err instanceof RunAbortedError) {
      reporter.error(`Run cancelled`);
      return 130;
    }
    reporter.error(`Run failed: ${errorMessage(err)}`);
    return 2;
  } finally {
    process.removeListener('SIGINT', onSigint);
    runner?.close();
  }
}
```

Update `src/cli.test.ts` — the existing tests are unchanged (they call `main()` which still returns the same codes); add the abort test. Append inside `describe('main', ...)`:

```ts
it('returns 130 when the run is cancelled via SIGINT', async () => {
  await createFile(rootDir, 'pics/a.txt', 'hello');
  await fs.writeFile(join(rootDir, 'config.yaml'), makeConfigYaml(rootDir));

  let sigintHandler: (() => void) | undefined;
  const onceSpy = vi.spyOn(process, 'once');
  onceSpy.mockImplementation(((event: string, listener: (...args: unknown[]) => void) => {
    if (event === 'SIGINT') {
      sigintHandler = listener as () => void;
    }
    return process;
  }) as unknown as typeof process.once);

  try {
    const promise = main(['--config', join(rootDir, 'config.yaml')]);
    // main() registers the SIGINT handler synchronously before its first await,
    // so the spy captures it before we abort.
    expect(sigintHandler).toBeDefined();
    sigintHandler!();
    const code = await promise;
    expect(code).toBe(130);
  } finally {
    onceSpy.mockRestore();
  }
});
```

Note: `main()` is async but runs synchronously up to its first `await` (`loadRunConfiguration`), and the SIGINT handler is registered before that — so the spy captures it deterministically.

- [ ] **Step 4: Run the full suite**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:coverage`
Expected: all pass. `cli.test.ts` — all existing tests plus the new 130 test. `runner.test.ts` — all tests. `reporter.test.ts` — all tests (interface slim keeps `CliReporter.progress`/`stopProgress` public so existing direct-call tests still pass). Coverage ≥ 80%.

- [ ] **Step 5: Manual sanity check of CLI output**

Run: `pnpm dev -- --config config.yaml --quiet`
Expected: summary lines identical to before (e.g. `Scan: N files scanned, ...`, `Records: ...`), plus any collected warnings. Abort a run with Ctrl-C and confirm the process exits (code 130).

- [ ] **Step 6: Commit, push, open PR, STOP**

```bash
git add src/phases/index.ts src/runner.ts src/runner.test.ts src/output/reporter.ts src/cli.ts src/cli.test.ts
git commit -m "refactor: swap Runner to phase orchestrator with typed progress and abort"
git push -u origin refactor/runner-phases
gh pr create --title "refactor: swap Runner to phase orchestrator with typed progress and abort" --body "Runner becomes a thin orchestrator over PHASES, folding each PhaseResult into RunSummary. The Reporter interface slims to output-only (progress moves to a typed ProgressEmitter that CliReporter.subscribe renders to the identical CLI strings). cli.ts wires an AbortController (SIGINT → abort) and maps RunAbortedError to exit 130. Progress events now carry filesProcessed/totalFiles counters for a future determinate Electron bar."
```

**STOP AND WAIT.** Do not start any further task until this PR is reviewed and merged. Then run `git checkout main && git pull`. This is the final task.

---

## Out of Scope

- Electron implementation itself (no Electron dependency added).
- Run-resume / partial-run reconciliation.
- Changes to `RunSummary` shape or error semantics.
- Any new runtime dependencies.
