import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import Database from 'better-sqlite3';
import { Runner } from './runner';
import type { RunConfiguration } from './types/configuration';

async function makeTempDir(prefix = 'runner-test-'): Promise<string> {
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

function makeConfig(dbName: string, directory: string): RunConfiguration {
  return {
    dbName,
    extensions: ['.txt'],
    directories: [directory],
    ignore_directories: [],
    update_records: true,
    process_directories: true,
    resync_directories: false,
    resync_check_actual_file: false,
  };
}

type MockReporter = {
  debug: Mock;
  info: Mock;
  warn: Mock;
  error: Mock;
  progress: Mock;
  stopProgress: Mock;
  printSummary: Mock;
};

function makeMockReporter(): MockReporter {
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

describe('Runner', () => {
  let rootDir: string;
  let dbPath: string;

  beforeEach(async () => {
    rootDir = await makeTempDir();
    dbPath = join(rootDir, 'test.db');
  });

  afterEach(async () => {
    await removeDirRecursive(rootDir);
  });

  it('indexes files and updates records', async () => {
    await createFile(rootDir, 'src/a.txt', 'unique');
    await createFile(rootDir, 'src/sub/b.txt', 'same content');
    await createFile(rootDir, 'src2/b.txt', 'same content');
    await createFile(rootDir, 'src/c.txt', 'another');

    const runner = new Runner(makeConfig(dbPath, rootDir), makeMockReporter());
    const summary = await runner.run();
    runner.close();

    const db = new Database(dbPath);
    const entries = db.prepare('SELECT filename, size FROM entries ORDER BY filename').all() as {
      filename: string;
      size: number;
    }[];
    const records = db.prepare('SELECT filename, count FROM records ORDER BY filename').all() as {
      filename: string;
      count: number;
    }[];
    db.close();

    expect(entries.map((e) => e.filename)).toEqual(['a.txt', 'b.txt', 'b.txt', 'c.txt']);
    expect(records.find((r) => r.filename === 'a.txt')!.count).toBe(1);
    expect(records.find((r) => r.filename === 'c.txt')!.count).toBe(1);
    // b.txt appears in two directories with identical content -> same hash -> grouped
    expect(records.find((r) => r.filename === 'b.txt')!.count).toBe(2);

    expect(summary.phases.map((p) => p.name)).toEqual(['scan', 'records']);
    expect(summary.filesScanned).toBe(4);
    expect(summary.entriesUpserted).toBe(4);
    expect(summary.duplicateGroups).toBe(1);
    expect(summary.duplicateFiles).toBe(1);
    expect(summary.staleRemoved).toBe(0);
    expect(summary.errors).toEqual([]);
  });

  it('skips directory scanning when process_directories is false', async () => {
    await createFile(rootDir, 'src/a.txt', 'hello');

    const config = { ...makeConfig(dbPath, join(rootDir, 'src')), process_directories: false };
    const runner = new Runner(config, makeMockReporter());
    const summary = await runner.run();
    runner.close();

    const db = new Database(dbPath);
    const count = db.prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number };
    db.close();
    expect(count.c).toBe(0);
    expect(summary.phases.map((p) => p.name)).toEqual(['records']);
    expect(summary.filesScanned).toBe(0);
  });

  it('skips record updating when update_records is false', async () => {
    await createFile(rootDir, 'src/a.txt', 'hello');

    const config = { ...makeConfig(dbPath, join(rootDir, 'src')), update_records: false };
    const runner = new Runner(config, makeMockReporter());
    const summary = await runner.run();
    runner.close();

    const db = new Database(dbPath);
    const entries = db.prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number };
    const records = db.prepare('SELECT COUNT(*) as c FROM records').get() as { c: number };
    db.close();
    expect(entries.c).toBe(1);
    expect(records.c).toBe(0);
    expect(summary.phases.map((p) => p.name)).toEqual(['scan']);
    expect(summary.duplicateGroups).toBe(0);
    expect(summary.duplicateFiles).toBe(0);
  });

  it('ignores directories listed in ignore_directories', async () => {
    await createFile(rootDir, 'src/keep.txt', 'keep');
    await createFile(rootDir, 'src/ignored/skip.txt', 'skip');

    const config: RunConfiguration = {
      ...makeConfig(dbPath, join(rootDir, 'src')),
      ignore_directories: [join(rootDir, 'src', 'ignored')],
    };
    const runner = new Runner(config, makeMockReporter());
    const summary = await runner.run();
    runner.close();

    const db = new Database(dbPath);
    const rows = db.prepare('SELECT filename FROM entries').all() as { filename: string }[];
    db.close();
    expect(rows.map((r) => r.filename)).toEqual(['keep.txt']);
    expect(summary.filesScanned).toBe(1);
  });

  it('skips a directory when it matches an ignore_directories entry', async () => {
    const ignored = await createFile(rootDir, 'src/ignored.txt', 'ignored');

    const config: RunConfiguration = {
      ...makeConfig(dbPath, join(rootDir, 'src')),
      ignore_directories: [dirname(ignored)],
    };
    const runner = new Runner(config, makeMockReporter());
    await runner.run();
    runner.close();

    const db = new Database(dbPath);
    const count = db.prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number };
    db.close();
    expect(count.c).toBe(0);
  });

  it('resyncs by removing entries for files that no longer exist', async () => {
    const fileToDelete = await createFile(rootDir, 'src/a.txt', 'alpha');
    await createFile(rootDir, 'src/b.txt', 'bravo');

    // Index both files first
    const runner = new Runner(makeConfig(dbPath, join(rootDir, 'src')), makeMockReporter());
    await runner.run();
    runner.close();

    // Delete one file, then resync against the actual filesystem
    await fs.unlink(fileToDelete);
    const resyncConfig: RunConfiguration = {
      ...makeConfig(dbPath, join(rootDir, 'src')),
      process_directories: false,
      resync_directories: true,
      resync_check_actual_file: true,
    };
    const reporter = makeMockReporter();
    const resyncRunner = new Runner(resyncConfig, reporter);
    const summary = await resyncRunner.run();
    resyncRunner.close();

    const db = new Database(dbPath);
    const rows = db.prepare('SELECT filename FROM entries ORDER BY filename').all() as {
      filename: string;
    }[];
    db.close();
    expect(rows.map((r) => r.filename)).toEqual(['b.txt']);
    expect(summary.staleRemoved).toBe(1);
    expect(summary.phases.map((p) => p.name)).toEqual(['resync', 'records']);
    // resync + records enabled -> resync marker is [1/2]
    expect(reporter.progress).toHaveBeenCalledWith(expect.stringContaining('[1/2]'));
  });

  it('resyncs against the current directory listing when checkActualFile is false', async () => {
    const fileToDelete = await createFile(rootDir, 'src/a.txt', 'alpha');
    await createFile(rootDir, 'src/b.txt', 'bravo');

    const runner = new Runner(makeConfig(dbPath, join(rootDir, 'src')), makeMockReporter());
    await runner.run();
    runner.close();

    await fs.unlink(fileToDelete);
    const resyncConfig: RunConfiguration = {
      ...makeConfig(dbPath, join(rootDir, 'src')),
      process_directories: false,
      resync_directories: true,
      resync_check_actual_file: false,
    };
    const reporter = makeMockReporter();
    const resyncRunner = new Runner(resyncConfig, reporter);
    const summary = await resyncRunner.run();
    resyncRunner.close();

    const db = new Database(dbPath);
    const rows = db.prepare('SELECT filename FROM entries ORDER BY filename').all() as {
      filename: string;
    }[];
    db.close();
    expect(rows.map((r) => r.filename)).toEqual(['b.txt']);
    expect(summary.staleRemoved).toBe(1);
    expect(summary.phases.map((p) => p.name)).toEqual(['resync', 'records']);
  });

  it('collects per-directory errors and continues with remaining directories', async () => {
    await createFile(rootDir, 'src/a.txt', 'hello');

    const config: RunConfiguration = {
      ...makeConfig(dbPath, join(rootDir, 'src')),
      directories: [join(rootDir, 'missing'), join(rootDir, 'src')],
    };
    const reporter = makeMockReporter();
    const runner = new Runner(config, reporter);
    const summary = await runner.run();
    runner.close();

    const db = new Database(dbPath);
    const count = db.prepare('SELECT COUNT(*) as c FROM entries').get() as { c: number };
    db.close();

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain(join(rootDir, 'missing'));
    expect(count.c).toBe(1);
    expect(summary.filesScanned).toBe(1);
    expect(summary.phases.map((p) => p.name)).toEqual(['scan', 'records']);
    expect(reporter.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to scan directory'));
  });

  it('collects resync errors and continues with remaining directories', async () => {
    await createFile(rootDir, 'src/a.txt', 'alpha');
    await createFile(rootDir, 'src/b.txt', 'bravo');

    const runner = new Runner(makeConfig(dbPath, join(rootDir, 'src')), makeMockReporter());
    await runner.run();
    runner.close();

    const resyncConfig: RunConfiguration = {
      ...makeConfig(dbPath, join(rootDir, 'src')),
      process_directories: false,
      resync_directories: true,
      resync_check_actual_file: false,
      directories: [join(rootDir, 'src-missing'), join(rootDir, 'src')],
    };
    const reporter = makeMockReporter();
    const resyncRunner = new Runner(resyncConfig, reporter);
    const summary = await resyncRunner.run();
    resyncRunner.close();

    expect(summary.errors).toHaveLength(1);
    expect(summary.errors[0]).toContain(join(rootDir, 'src-missing'));
    expect(summary.staleRemoved).toBe(0);
    expect(reporter.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to resync directory'));
  });

  it('numbers phase markers by the enabled phases', async () => {
    await createFile(rootDir, 'src/a.txt', 'hello');

    const reporter = makeMockReporter();
    const runner = new Runner(makeConfig(dbPath, join(rootDir, 'src')), reporter);
    await runner.run();
    runner.close();

    // makeConfig enables scan + records (no resync) -> markers are [1/2] and [2/2]
    expect(reporter.info).toHaveBeenCalledWith(expect.stringContaining('[1/2]'));
    expect(reporter.info).toHaveBeenCalledWith(expect.stringContaining('[2/2]'));
    expect(reporter.progress).toHaveBeenCalledWith(expect.stringContaining('[1/2]'));
  });
});
