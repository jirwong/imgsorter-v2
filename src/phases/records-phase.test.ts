import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { RecordsPhase } from './records-phase';
import { RunAbortedError } from './abort';
import { makeConfig, makeMockReporter, asReporter } from './test-helpers';
import type { DbService } from '../services/db-service';
import type { ProgressSink } from '../types/progress';

describe('RecordsPhase', () => {
  it('is enabled only when update_records is true', () => {
    const phase = new RecordsPhase();
    expect(phase.enabled(makeConfig({ update_records: true }))).toBe(true);
    expect(phase.enabled(makeConfig({ update_records: false }))).toBe(false);
  });

  it('rebuilds records and returns the duplicate stats', async () => {
    const phase = new RecordsPhase();
    const db = {
      updateFileRecords: vi.fn(),
      getDuplicateStats: vi.fn(() => ({ duplicateGroups: 2, duplicateFiles: 3 })),
    };
    const progress = { emitProgress: vi.fn() } as ProgressSink;

    const result = await phase.run({
      config: makeConfig({ update_records: true }),
      db: db as unknown as DbService,
      reporter: asReporter(makeMockReporter()),
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
        config: makeConfig({ update_records: true }),
        db: db as unknown as DbService,
        reporter: asReporter(makeMockReporter()),
        progress: { emitProgress: vi.fn() },
        marker: '[1/1]',
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RunAbortedError);
    expect(db.updateFileRecords as Mock).not.toHaveBeenCalled();
    expect(db.getDuplicateStats as Mock).not.toHaveBeenCalled();
  });
});
