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
