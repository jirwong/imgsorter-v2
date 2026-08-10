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
