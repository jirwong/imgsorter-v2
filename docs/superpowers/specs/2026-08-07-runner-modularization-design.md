# Runner Modularization Design

Date: 2026-08-07

## Objective

Restructure `src/runner.ts` into a modular, readable architecture and prepare the
codebase for use inside an Electron app. Concretely:

1. Make `Runner` a thin orchestrator instead of a god-class holding three large
   phase methods plus all counter aggregation.
2. Decouple progress reporting from the console by introducing a typed progress
   event emitter that any UI (CLI spinner today, Electron renderer later) can
   subscribe to.

Behavior must remain identical: all existing tests pass, and every console
message string is byte-for-byte unchanged.

## Context

### Current state

`src/runner.ts` (206 lines) contains:

- `Runner` class holding `db`, `config`, `reporter`.
- `run()` — builds the enabled-phase list, tracks `[n/total]` markers, runs the
  three phases, and accumulates five numeric counters plus the `phases` and a
  shared `errors[]` array into `RunSummary`.
- `processDirectories()` (scan), `resyncDirectories()` (resync),
  `updateRecords()` (records) — each phase method mixes directory iteration,
  ignore-set checks, per-directory error collection, progress reporting, and DB
  writes.

Problems:

- `run()` is a mutable-accumulator soup: five numeric counters (`filesScanned`,
  `entriesUpserted`, `duplicateGroups`, `duplicateFiles`, `staleRemoved`) plus the
  `phases` and `errors` arrays.
- `errors: string[]` is passed by reference and mutated inside phases (subtle).
- `processDirectories` and `resyncDirectories` duplicate the same directory
  iteration / ignore / per-directory-error shape.
- Progress is fire-and-forget `reporter.progress(msg)` with pre-formatted
  strings — unusable for an Electron progress bar.
- Directory-level failures are collected and non-fatal; DB failures propagate.
  This rule is implicit inside the phase methods.

### Electron considerations

- `Runner` already injects a `Reporter` interface and returns a structured
  `RunSummary` — good seams to preserve.
- Progress must become structured events so a renderer can render a real progress
  bar; the CLI keeps its spinner via an adapter over the same events.
- DB lifecycle stays owned by `Runner` (constructed with a path, closed via
  `close()`); an Electron main process drives it the same way.

## Chosen Approach

**Phase classes implementing a shared `Phase` interface + a typed `ProgressEmitter`.**

Rejected alternatives:

- **Phase functions in a descriptor registry** — equally modular but the contract
  is looser (no interface to implement) and less discoverable.
- **Minimal refactor (helpers + emitter only)** — leaves `Runner` as a large
  file; does not address the core "Runner is messy" problem.

## Architecture

### File layout

```
src/
├── runner.ts                        # thin orchestrator
├── types/
│   └── progress.ts                  # ProgressEvent + ProgressSink (emit-only contract)
├── phases/
│   ├── types.ts                     # Phase, PhaseContext, PhaseResult
│   ├── iterate-directories.ts       # shared dir-iteration + ignore + directoryStart helper
│   ├── scan-phase.ts                # ScanPhase
│   ├── resync-phase.ts              # ResyncPhase
│   ├── records-phase.ts             # RecordsPhase
│   └── index.ts                     # PHASES = [ScanPhase, ResyncPhase, RecordsPhase] (singletons)
└── output/
    ├── progress.ts                  # ProgressEmitter (implements ProgressSink, adds listener side)
    └── reporter.ts                  # Reporter (output-only) + CliReporter (subscribes to emitter)
```

### Phase contract (`phases/types.ts`)

```ts
interface Phase {
  name: PhaseName;
  enabled(config: RunConfiguration): boolean;
  run(ctx: PhaseContext): Promise<PhaseResult>;
}

type PhaseContext = {
  config: RunConfiguration;
  db: DbService;
  reporter: Reporter; // output only: debug/info/warn
  progress: ProgressSink; // emit-only view of the progress channel
  marker: string; // "[n/total]" computed by the Runner
};

type PhaseResult =
  | { name: 'scan'; elapsedMs: number; errors: string[]; filesScanned: number; entriesUpserted: number }
  | { name: 'resync'; elapsedMs: number; errors: string[]; staleRemoved: number }
  | { name: 'records'; elapsedMs: number; errors: string[]; duplicateGroups: number; duplicateFiles: number };
```

- Config-gate mapping moves into each phase's `enabled()`:
  - `scan` ↔ `config.process_directories`
  - `resync` ↔ `config.resync_directories`
  - `records` ↔ `config.update_records`
- Each phase owns and returns its `errors: string[]`; no shared mutable array.
- Note: `records` is synchronous today (`runner.ts:73`); `Phase.run` returns a
  Promise, so `RecordsPhase.run` wraps its synchronous body in an async function.

### Shared directory iteration (`phases/iterate-directories.ts`)

```ts
async function iterateDirectories(
  phase: PhaseName,
  deps: { config: RunConfiguration; reporter: Reporter; progress: ProgressSink },
  body: (directory: string) => Promise<void>,
): Promise<void>;
```

- Owns the loop over `config.directories`, the `isIgnored` check (emitting
  `reporter.info("Ignoring directory: …")` and skipping), and emitting
  `{ type: 'directoryStart', phase, directory }` **before** calling `body` —
  matching the current `progress()` ordering (`runner.ts:104` before the listing
  at `:108`).
- Does **not** catch exceptions. Each phase `body` wraps only its own directory
  _listing_ call in try/catch (push to its `errors[]`, `reporter.warn`, return)
  and lets DB errors propagate. In `resync_check_actual_file` mode the body has
  no listing call and therefore no try/catch at all — any DB error propagates and
  fails the run, preserving current semantics.

### Runner (`runner.ts`)

```ts
export class Runner {
  constructor(config, reporter, progress) { ... }
  async run(): Promise<RunSummary> {
    const enabled = PHASES.filter((p) => p.enabled(this.config));
    // for each: marker = `[${i + 1}/${enabled.length}]`, await phase.run(ctx),
    // switch on result.name to fold counters into RunSummary
  }
  close() { this.db.close(); }
}
```

- `PHASES` from `phases/index.ts` holds **singleton instances** (phases are
  stateless — all deps arrive via `ctx`), replacing the manual
  `enabledPhases.push(...)` block.
- Marker computation is derived from the enabled list, preserving the existing
  dynamic numbering behavior.

### Progress contract (`types/progress.ts`, `output/progress.ts`)

```ts
type ProgressEvent =
  | { type: 'phaseStart'; phase: PhaseName; marker: string }
  | { type: 'directoryStart'; phase: PhaseName; directory: string }
  | { type: 'file'; phase: PhaseName; directory: string; currentFile: string };

// emit-only view; phases depend on this and nothing else
interface ProgressSink {
  emitProgress(event: ProgressEvent): void;
}
```

`ProgressEmitter` (`output/progress.ts`) implements `ProgressSink` and adds the
listener side — a typed `on(listener)` over `node:events` — so phases emit via
`ProgressSink` while `CliReporter`/Electron subscribe via `on`. This keeps
`phases/` free of any dependency on `output/`; tests and Electron can substitute
a fake `ProgressSink` freely. Event shapes cannot be typo'd.

Phases emit these instead of calling `reporter.progress(...)`. `currentFile` is
the absolute path — useful to Electron; display formatting stays in the adapter.

### Reporter split (`output/reporter.ts`)

- `Reporter` interface slims to output-only:
  `debug | info | warn | error | printSummary` (no `progress`/`stopProgress`).
- `CliReporter` implements `Reporter` and gains `subscribe(progress)` which
  registers event handlers that reproduce the exact current strings:
  - `phaseStart` → `info("${marker} ${label}")` (label: `Scanning…`, `Resyncing…`,
    `Rebuilding records…`), **then** `progress(...)` with the same text. The
    info-then-progress ordering (`runner.ts:92-93`) is a contract: the marker
    line prints before the spinner restarts. A reporter test asserts it.
  - `directoryStart` → `progress("${verb} ${directory}")` (verb: `Scanning` /
    `Resyncing`, derived from `event.phase`).
  - `file` → `progress("${verb} ${directory} → ${relative(directory, currentFile)}")`.
- `stopProgress` remains a public method on `CliReporter` (still called by
  `cli.ts` after a run) but is removed from the `Reporter` interface.

### CLI wiring (`cli.ts`)

```ts
const progress = new ProgressEmitter();
const reporter = new CliReporter(opts);
reporter.subscribe(progress);
const runner = new Runner(config, reporter, progress);
```

## Data Flow

1. `cli.ts` constructs `ProgressEmitter`, `CliReporter`, subscribes the reporter,
   and passes both (plus config) to `Runner`.
2. `Runner.run()` filters `PHASES` by `enabled(config)`, then for each enabled
   phase computes `marker` and calls `phase.run(ctx)`.
3. Each phase iterates directories (via `iterateDirectories`), reads/writes the
   DB, emits progress events, and returns a typed `PhaseResult` (counters +
   errors + elapsed).
4. `Runner` folds each result into `RunSummary` (switch on `result.name`).
5. `cli.ts` prints the summary via `reporter.printSummary(summary)`.

## Error Handling

- Directory-level failures (unreadable root listing) are non-fatal: the phase
  `body` wraps only its listing call, pushes to its own `errors[]`, calls
  `reporter.warn`, and returns so iteration continues. `iterateDirectories` owns
  the loop but never catches.
- DB failures propagate and fail the run — no `try/catch` around DB calls. This
  holds in both resync modes: the `resync_check_actual_file` body has no listing
  call and therefore no try/catch at all.

## Testing

- **New per-phase unit tests** (`src/phases/*.test.ts`) using mock config,
  reporter, and emitter — phase behavior is currently only exercised through the
  full `Runner`.
- **`src/runner.test.ts` updated:**
  - `MockReporter` drops `progress`/`stopProgress` (interface slims).
  - The five progress assertions (markers, current-file during scan/resync) switch
    to asserting emitted events, e.g.
    `expect(progress.emitProgress).toHaveBeenCalledWith({ type: 'file', phase: 'scan', directory, currentFile })`.
  - Counter values, summary shape, info/warn messages, and error collection pass
    unchanged.
- **`src/output/reporter.test.ts`** gains coverage for `subscribe()` event →
  string formatting (verifying CLI text is preserved), including an assertion
  that `phaseStart` calls `info()` before `progress()` (spinner-restart
  ordering).
- Coverage thresholds (80%) remain enforced.

## Out of Scope

- Electron implementation itself (no Electron dependency added).
- Run cancellation / abort (deferred to the future "full Electron-ready" phase).
- Changes to `RunSummary` shape or error semantics.
