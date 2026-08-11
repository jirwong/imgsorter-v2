import { throwIfAborted } from './abort';
import type { Phase, PhaseContext, PhaseResult } from './types';
import type { RunConfiguration } from '../types/configuration';

export class RecordsPhase implements Phase {
  readonly name = 'records' as const;

  enabled(config: RunConfiguration): boolean {
    return config.update_records;
  }

  async run(ctx: PhaseContext): Promise<PhaseResult> {
    throwIfAborted(ctx.signal);

    const start = performance.now();
    ctx.progress.emitProgress({ type: 'phaseStart', phase: 'records', marker: ctx.marker });

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
