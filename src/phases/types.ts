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
  reporter: Reporter; // output only: debug/info/warn (Reporter slims to this in the final swap)
  progress: ProgressSink; // emit-only view of the progress channel
  marker: string; // "[n/total]" computed by the Runner
  signal: AbortSignal; // checked at safe points; abort throws RunAbortedError
};

export type PhaseResult =
  | { name: 'scan'; elapsedMs: number; errors: string[]; filesScanned: number; entriesWritten: number }
  | { name: 'resync'; elapsedMs: number; errors: string[]; staleRemoved: number }
  | { name: 'records'; elapsedMs: number; errors: string[]; duplicateGroups: number; duplicateFiles: number };
