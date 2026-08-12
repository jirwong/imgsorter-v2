export type PhaseName = 'scan' | 'resync' | 'records';

export type RunSummary = {
  // Phases actually executed this run, in order, with elapsed time in ms.
  phases: { name: PhaseName; elapsedMs: number }[];
  // Files matching the configured extensions encountered during the scan phase.
  filesScanned: number;
  // Rows inserted or updated in `entries` during the scan phase.
  entriesWritten: number;
  // Duplicate groups in `records`: rows with count > 1, i.e. the same filename,
  // size and hash verified in more than one directory. Files with identical
  // content but different names form separate groups and are not counted here.
  duplicateGroups: number;
  // Sum of (count - 1) over the duplicate groups in `records`.
  duplicateFiles: number;
  // Entries deleted during the resync phase.
  staleRemoved: number;
  // Per-directory failures, non-fatal (the run continues past them).
  errors: string[];
};
