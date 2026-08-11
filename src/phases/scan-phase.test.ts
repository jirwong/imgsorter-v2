import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { ScanPhase } from './scan-phase';
import { RunAbortedError } from './abort';
import { makeMockReporter, makeMockProgress, asReporter, asProgress } from './test-helpers';
import type { DbService } from '../services/db-service';
import type { RunConfiguration } from '../types/configuration';

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
    const progress = makeMockProgress();
    const reporter = makeMockReporter();

    const result = await new ScanPhase().run({
      config: makeConfig(join(rootDir, 'src')),
      db: db as unknown as DbService,
      reporter: asReporter(reporter),
      progress: asProgress(progress),
      marker: '[1/2]',
      signal: new AbortController().signal,
    });

    expect(result.name).toBe('scan');
    if (result.name !== 'scan') {
      throw new Error('expected a scan result');
    }
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
    const reporter = makeMockReporter();

    const result = await new ScanPhase().run({
      config,
      db: { insertFileInfo: vi.fn(() => 'inserted') } as unknown as DbService,
      reporter: asReporter(reporter),
      progress: asProgress(makeMockProgress()),
      marker: '[1/1]',
      signal: new AbortController().signal,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain(join(rootDir, 'missing'));
    if (result.name !== 'scan') {
      throw new Error('expected a scan result');
    }
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
        reporter: asReporter(makeMockReporter()),
        progress: asProgress(makeMockProgress()),
        marker: '[1/1]',
        signal: controller.signal,
      }),
    ).rejects.toBeInstanceOf(RunAbortedError);
    expect(db.insertFileInfo).not.toHaveBeenCalled();
  });
});
