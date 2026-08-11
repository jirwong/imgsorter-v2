import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { ResyncPhase } from './resync-phase';
import { RunAbortedError } from './abort';
import { makeMockReporter, makeMockProgress, asReporter, asProgress } from './test-helpers';
import type { DbService } from '../services/db-service';
import type { RunConfiguration } from '../types/configuration';
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

describe('ResyncPhase', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await makeTempDir();
  });

  afterEach(async () => {
    await removeDirRecursive(rootDir);
  });

  it('is enabled only when resync_directories is true', () => {
    const phase = new ResyncPhase();
    expect(phase.enabled(makeConfig(join(rootDir, 'src'), false))).toBe(true);
    expect(phase.enabled({ ...makeConfig(join(rootDir, 'src'), false), resync_directories: false })).toBe(false);
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
    const progress = makeMockProgress();

    const result = await new ResyncPhase().run({
      config: makeConfig(src, true),
      db: db as unknown as DbService,
      reporter: asReporter(makeMockReporter()),
      progress: asProgress(progress),
      marker: '[1/2]',
      signal: new AbortController().signal,
    });

    expect(result.name).toBe('resync');
    if (result.name !== 'resync') {
      throw new Error('expected a resync result');
    }
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
      reporter: asReporter(makeMockReporter()),
      progress: asProgress(makeMockProgress()),
      marker: '[1/2]',
      signal: new AbortController().signal,
    });

    expect(result.name).toBe('resync');
    if (result.name !== 'resync') {
      throw new Error('expected a resync result');
    }
    expect(result.staleRemoved).toBe(1);
    expect(db.deleteFileEntryByPath).toHaveBeenCalledWith(stale);
    expect(db.deleteFileEntryByPath).not.toHaveBeenCalledWith(join(src, 'a.txt'));
  });

  it('collects a listing error and continues', async () => {
    const reporter = makeMockReporter();

    const result = await new ResyncPhase().run({
      config: makeConfig(join(rootDir, 'missing'), false),
      db: { getFileEntriesByDirectory: vi.fn(() => []), deleteFileEntryByPath: vi.fn() } as unknown as DbService,
      reporter: asReporter(reporter),
      progress: asProgress(makeMockProgress()),
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
        reporter: asReporter(makeMockReporter()),
        progress: asProgress(makeMockProgress()),
        marker: '[1/1]',
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RunAbortedError);
  });
});
