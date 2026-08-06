# CLI & Architecture Improvements — Design

Date: 2026-08-06
Status: Approved design (pre-implementation)

## Goal

Improve the imgsorter-v2 codebase in two areas:

1. **CLI / UX polish** — real CLI arguments, progress feedback, a final summary, and better error handling with meaningful exit codes.
2. **Code quality / architecture** — an output layer that removes `console` usage from business code, a `RunSummary` returned by the runner, prepared-statement reuse, unified service styles, shared path helpers, and per-directory error continuation.

The tool is run manually, occasionally, by the user.

## Dependencies

Two new runtime dependencies:

- `commander` — CLI argument parsing
- `nanospinner` — live spinner/progress line (zero deps, TTY-aware)

## Approach

Layered refactor (Approach B): keep the existing Runner → services structure, introduce clean boundaries for output and CLI, and apply mechanical fixes in DbService/fileService. No behavior changes to the scanning/hashing/dedup logic itself.

## 1. CLI Entry

New file `src/cli.ts`:

- Exports a pure `main(argv: string[]): Promise<number>` returning the process exit code. No `process.exit()` calls — exit code is returned and applied by `index.ts`. This makes CLI behavior unit-testable without spawning processes.
- `index.ts` becomes a thin shim: `main(process.argv.slice(2))` → set `process.exitCode`.
- Parsing via `commander`:
  - `--config <path>` — override the config file (default `config.yaml`)
  - `--quiet` — show only warnings and errors
  - `--verbose` — enable debug-level output
  - `--no-progress` — disable the live spinner
  - `--version`, `--help` — provided by commander
- Exit codes:
  - `0` — run succeeded (warnings do not fail the run)
  - `1` — config file missing/invalid, or CLI argument errors
  - `2` — run failed (fatal error outside per-directory handling)

## 2. Output Layer

New file `src/output/reporter.ts`:

- `CliReporter` class owns **all** user-facing output. Runner, services, and cli.ts never call `console` directly; only the reporter does.
- Constructor takes an options object: `{ quiet: boolean; verbose: boolean; progress: boolean }` (progress = spinner enabled and stdout is a TTY).
- Methods:
  - `debug(msg)`, `info(msg)`, `warn(msg)`, `error(msg)` — level-gated: `quiet` suppresses `debug`/`info`; `verbose` enables `debug`.
  - `progress(msg)` — updates a `nanospinner` spinner; no-op when progress is disabled.
  - `stopProgress()` — clears the spinner before printing a plain line.
  - `printSummary(summary: RunSummary)` — formatted end-of-run report: per-phase elapsed times, counters, and any collected errors.
- Phase markers: `[1/3] Scanning…`, `[2/3] Resyncing…`, `[3/3] Rebuilding records…`.
- When the spinner is disabled (piped or `--no-progress`), output degrades to plain info lines at phase boundaries — no control characters in captured logs.

## 3. Runner & Shared Helpers

### RunSummary

New type in `src/types/` (or colocated with Runner): returned by `Runner.run()`:

```ts
type RunSummary = {
  phases: { name: 'scan' | 'resync' | 'records'; elapsedMs: number }[];
  filesScanned: number; // files matching extensions encountered during scan
  entriesUpserted: number; // rows inserted or updated in `entries`
  duplicateGroups: number; // groups with count > 1 in `records`
  duplicateFiles: number; // sum of (count - 1) over duplicate groups
  staleRemoved: number; // entries deleted during resync
  errors: string[]; // per-directory failures, non-fatal
};
```

### Runner changes

- Constructor becomes `Runner(config, reporter)`; reporter is injected and used for all output. All `console.log` calls removed.
- `run()` returns `Promise<RunSummary>`.
- Scan and resync phases iterate directories individually in try/catch: one unreadable directory is collected into `errors` and the remaining directories still process. Config-level problems (e.g. missing DB dir) still throw → exit code 2.
- Phase timing collected into `phases`.

### path-helpers

New file `src/utilities/path-helpers.ts`:

- `normalizePath(path)` — trim trailing separators, lowercase (moved from runner.ts).
- `buildIgnoredSet(ignoreDirectories)` — normalized `Set<string>`.
- `isIgnored(path, ignoredSet)` — normalized membership check.
- Replaces the duplicated ignored-set logic in `processDirectories` and `resyncDirectories`.

## 4. DbService & fileService Fixes

### DbService

- Prepare all SQL statements once in the constructor (insert entry, insert record, select entries by directory, delete by path, etc.) and reuse. Currently `insertFileInfo` re-prepares on every call.
- `insertFileInfo` returns `'inserted' | 'updated'` (from `changes` in the upsert result) so the Runner can count real upserts for the summary.
- Public API otherwise unchanged.

### fileService

- Convert the `fileService` object-literal singleton to plain named exports: `fileExists`, `readFileInfo`, `getHashEdges`, `listFilesRecursive`, `listFilePathsRecursive`.
- Same signatures; callers updated in runner.ts and tests.
- Rationale: fileService is stateless (plain functions); DbService is stateful (stays a class). This matches the repo's named-export convention.

## 5. Testing & Docs

- **Runner tests** — inject a mock reporter (no-op with capture), assert `RunSummary` values, error collection, and that phases run conditionally per config flags.
- **cli tests** — `main()` exit codes for: default config, `--config` override, invalid/missing config, bad flag, fatal run error.
- **Reporter tests** — level gating (quiet/verbose), spinner usage disabled when progress is off, summary formatting.
- **path-helpers tests** — normalize/ignore behavior (trailing separators, case).
- **DbService tests** — upsert return value; existing behavior preserved.
- **fileService tests** — updated imports only.
- Coverage threshold stays at 80% (`pnpm test:coverage`).
- **README** — document the new flags, exit codes, and output behavior.
- **config.yaml** — no schema changes (flags are additive); update comments only if needed.

## Out of Scope

- No changes to hashing algorithm, DB schema, or config schema.
- No new duplicate-reporting/export features (future work).
- No parallelization or performance work (future work).
