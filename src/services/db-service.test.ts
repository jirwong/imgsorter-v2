import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import Database from 'better-sqlite3';
import { DbService } from './db-service';
import type { FileEntry } from '../types/file-types';

async function removeFile(path: string) {
  try {
    await fs.unlink(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      console.error('Failed to remove test db file:', err);
    }
  }
}

describe('DbService', () => {
  let dbPath: string;
  let services: DbService[];

  beforeEach(async () => {
    dbPath = join(tmpdir(), `db-service-test-${Date.now()}.sqlite`);
    services = [];
    await removeFile(dbPath);
  });

  afterEach(async () => {
    for (const service of services) {
      service.close();
    }
    await removeFile(dbPath);
  });

  function openService(): DbService {
    const service = new DbService(dbPath);
    services.push(service);
    return service;
  }

  it('creates entries and records tables on construction', () => {
    openService();

    const db = new Database(dbPath);
    const entriesCount = db.prepare('SELECT COUNT(*) AS c FROM entries').get() as { c: number };
    expect(entriesCount.c).toBe(0);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('entries', 'records') ORDER BY name")
      .all() as { name: string }[];

    expect(tables.map((t) => t.name)).toEqual(['entries', 'records']);

    const entriesColumns = db.prepare('PRAGMA table_info(entries)').all() as { name: string }[];
    const recordsColumns = db.prepare('PRAGMA table_info(records)').all() as { name: string }[];

    expect(entriesColumns.map((c) => c.name)).toEqual([
      'id',
      'size',
      'directory',
      'extension',
      'filename',
      'birthtime',
      'hash',
      'path',
    ]);

    expect(recordsColumns.map((c) => c.name)).toEqual([
      'id',
      'filename',
      'hash',
      'count',
      'directories',
      'extension',
      'size',
    ]);

    db.close();
  });

  it('inserts a FileEntry into entries table', () => {
    const service = openService();

    const entry: FileEntry = {
      size: 123,
      directory: '/tmp',
      extension: '.png',
      path: '/tmp/foo.png',
      filename: 'foo.png',
      birthtime: new Date('2025-01-01T00:00:00.000Z'),
      hash: 'abc123',
    };

    service.insertFileInfo(entry);

    const db = new Database(dbPath);
    const rows = db.prepare('SELECT size, directory, extension, filename, birthtime, hash FROM entries').all() as {
      size: number;
      directory: string;
      extension: string;
      filename: string;
      birthtime: string;
      hash: string | null;
    }[];

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.size).toBe(entry.size);
    expect(row.directory).toBe(entry.directory);
    expect(row.extension).toBe(entry.extension);
    expect(row.filename).toBe(entry.filename);
    expect(row.birthtime).toBe(entry.birthtime.toISOString());
    expect(row.hash).toBe(entry.hash);

    db.close();
  });

  it('upserts a FileEntry when called with the same path', () => {
    const service = openService();

    const original: FileEntry = {
      size: 123,
      directory: '/tmp',
      extension: '.png',
      path: '/tmp/foo.png',
      filename: 'foo.png',
      birthtime: new Date('2025-01-01T00:00:00.000Z'),
      hash: 'abc123',
    };

    const updated: FileEntry = {
      ...original,
      size: 456,
      hash: 'updated-hash',
      path: '/tmp/foo.png',
      birthtime: new Date('2026-02-02T00:00:00.000Z'),
    };

    service.insertFileInfo(original);
    service.insertFileInfo(updated);

    const db = new Database(dbPath);
    const rows = db
      .prepare('SELECT size, directory, extension, filename, birthtime, hash, path FROM entries')
      .all() as {
      size: number;
      directory: string;
      extension: string;
      filename: string;
      birthtime: string;
      hash: string | null;
      path: string;
    }[];

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.size).toBe(updated.size);
    expect(row.directory).toBe(updated.directory);
    expect(row.extension).toBe(updated.extension);
    expect(row.filename).toBe(updated.filename);
    expect(row.birthtime).toBe(updated.birthtime.toISOString());
    expect(row.hash).toBe(updated.hash);
    expect(row.path).toBe(updated.path);

    db.close();
  });

  it('updates file records based on entries', () => {
    const service = openService();

    const entry1: FileEntry = {
      size: 100,
      directory: '/tmp/a',
      extension: '.png',
      path: '/tmp/a/foo.png',
      filename: 'foo.png',
      birthtime: new Date('2025-01-01T00:00:00.000Z'),
      hash: 'hash-1',
    };

    const entry2: FileEntry = {
      size: 100,
      directory: '/tmp/b',
      extension: '.png',
      path: '/tmp/b/foo.png',
      filename: 'foo.png',
      birthtime: new Date('2025-01-02T00:00:00.000Z'),
      hash: 'hash-1',
    };

    const otherHash: FileEntry = {
      size: 200,
      directory: '/tmp/c',
      extension: '.png',
      path: '/tmp/c/bar.png',
      filename: 'bar.png',
      birthtime: new Date('2025-01-03T00:00:00.000Z'),
      hash: 'hash-2',
    };

    service.insertFileInfo(entry1);
    service.insertFileInfo(entry2);
    service.insertFileInfo(otherHash);

    service.updateFileRecords();

    const db = new Database(dbPath);
    const rows = db.prepare('SELECT filename, hash, count, directories FROM records ORDER BY filename, hash').all() as {
      filename: string;
      hash: string;
      count: number;
      directories: string;
    }[];

    expect(rows).toHaveLength(2);

    const fooRecord = rows.find((r) => r.filename === 'foo.png' && r.hash === 'hash-1');
    expect(fooRecord).toBeTruthy();
    expect(fooRecord!.count).toBe(2);

    expect(fooRecord!.directories).toEqual(`["/tmp/a","/tmp/b"]`);

    const barRecord = rows.find((r) => r.filename === 'bar.png' && r.hash === 'hash-2');
    expect(barRecord).toBeTruthy();
    expect(barRecord!.count).toBe(1);
    expect(barRecord!.directories).toEqual(`["/tmp/c"]`);

    db.close();
  });

  it('removes stale records when their entries are deleted', () => {
    const service = openService();

    const entry: FileEntry = {
      size: 100,
      directory: '/tmp/a',
      extension: '.png',
      path: '/tmp/a/foo.png',
      filename: 'foo.png',
      birthtime: new Date('2025-01-01T00:00:00.000Z'),
      hash: 'hash-1',
    };

    service.insertFileInfo(entry);
    service.updateFileRecords();

    // Delete the underlying entry, then rebuild records
    service.deleteFileEntryByPath(entry.path);
    service.updateFileRecords();

    const db = new Database(dbPath);
    const rows = db.prepare('SELECT filename, hash FROM records').all() as {
      filename: string;
      hash: string;
    }[];
    db.close();

    expect(rows).toEqual([]);
  });

  it('getFileEntriesByDirectory returns entries whose directory matches the given prefix', () => {
    const service = openService();

    const entry1: FileEntry = {
      size: 100,
      directory: '/tmp/a',
      extension: '.txt',
      path: '/tmp/a/foo.txt',
      filename: 'foo.txt',
      birthtime: new Date('2025-01-01T00:00:00.000Z'),
      hash: undefined,
    };

    const entry2: FileEntry = {
      size: 200,
      directory: '/tmp/a/sub',
      extension: '.log',
      path: '/tmp/a/sub/bar.log',
      filename: 'bar.log',
      birthtime: new Date('2025-02-02T00:00:00.000Z'),
      hash: undefined,
    };

    const entryOtherDir: FileEntry = {
      size: 300,
      directory: '/tmp/b',
      extension: '.log',
      path: '/tmp/b/other.log',
      filename: 'other.log',
      birthtime: new Date('2025-03-03T00:00:00.000Z'),
      hash: undefined,
    };

    service.insertFileInfo(entry1);
    service.insertFileInfo(entry2);
    service.insertFileInfo(entryOtherDir);

    const results = service.getFileEntriesByDirectory('/tmp/a');

    const dirs = results.map((r) => r.directory).sort();
    expect(dirs).toEqual(['/tmp/a', '/tmp/a/sub']);
    const paths = results.map((r) => r.path).sort();
    expect(paths).toEqual([entry1.path, entry2.path].sort());
  });

  it('deleteFileEntryByPath removes the matching entry and is harmless if called again', () => {
    const service = openService();

    const entry: FileEntry = {
      size: 123,
      directory: '/tmp',
      extension: '.png',
      path: '/tmp/foo.png',
      filename: 'foo.png',
      birthtime: new Date('2025-01-01T00:00:00.000Z'),
      hash: 'abc123',
    };

    service.insertFileInfo(entry);

    const db = new Database(dbPath);

    let count = db.prepare('SELECT COUNT(*) as c FROM entries WHERE path = ?').get(entry.path) as { c: number };
    expect(count.c).toBe(1);

    service.deleteFileEntryByPath(entry.path);

    count = db.prepare('SELECT COUNT(*) as c FROM entries WHERE path = ?').get(entry.path) as { c: number };
    expect(count.c).toBe(0);

    // second call should not throw and still result in no rows
    service.deleteFileEntryByPath(entry.path);
    count = db.prepare('SELECT COUNT(*) as c FROM entries WHERE path = ?').get(entry.path) as { c: number };
    expect(count.c).toBe(0);

    db.close();
  });

  it('reports inserted vs updated for upserts', () => {
    const service = openService();

    const original: FileEntry = {
      size: 123,
      directory: '/tmp',
      extension: '.png',
      path: '/tmp/foo.png',
      filename: 'foo.png',
      birthtime: new Date('2025-01-01T00:00:00.000Z'),
      hash: 'abc123',
    };

    expect(service.insertFileInfo(original)).toBe('inserted');

    const updated: FileEntry = {
      ...original,
      size: 456,
      hash: 'new-hash',
    };

    expect(service.insertFileInfo(updated)).toBe('updated');

    // A third call that changes nothing still counts as 'updated'
    expect(service.insertFileInfo(updated)).toBe('updated');
  });

  it('getDuplicateStats counts duplicate groups and duplicate files', () => {
    const service = openService();

    const entry1: FileEntry = {
      size: 100,
      directory: '/tmp/a',
      extension: '.png',
      path: '/tmp/a/foo.png',
      filename: 'foo.png',
      birthtime: new Date('2025-01-01T00:00:00.000Z'),
      hash: 'hash-1',
    };

    const entry2: FileEntry = {
      size: 100,
      directory: '/tmp/b',
      extension: '.png',
      path: '/tmp/b/foo.png',
      filename: 'foo.png',
      birthtime: new Date('2025-01-02T00:00:00.000Z'),
      hash: 'hash-1',
    };

    const entry3: FileEntry = {
      size: 100,
      directory: '/tmp/c',
      extension: '.png',
      path: '/tmp/c/foo.png',
      filename: 'foo.png',
      birthtime: new Date('2025-01-03T00:00:00.000Z'),
      hash: 'hash-1',
    };

    const other: FileEntry = {
      size: 200,
      directory: '/tmp/d',
      extension: '.png',
      path: '/tmp/d/bar.png',
      filename: 'bar.png',
      birthtime: new Date('2025-01-04T00:00:00.000Z'),
      hash: 'hash-2',
    };

    service.insertFileInfo(entry1);
    service.insertFileInfo(entry2);
    service.insertFileInfo(entry3);
    service.insertFileInfo(other);
    service.updateFileRecords();

    expect(service.getDuplicateStats()).toEqual({ duplicateGroups: 1, duplicateFiles: 2 });
  });

  it('getDuplicateStats returns zeroes when there are no duplicate groups', () => {
    const service = openService();

    const entry: FileEntry = {
      size: 100,
      directory: '/tmp/a',
      extension: '.png',
      path: '/tmp/a/solo.png',
      filename: 'solo.png',
      birthtime: new Date('2025-01-01T00:00:00.000Z'),
      hash: 'hash-1',
    };

    service.insertFileInfo(entry);
    service.updateFileRecords();

    expect(service.getDuplicateStats()).toEqual({ duplicateGroups: 0, duplicateFiles: 0 });
  });

  it('insertFileInfos inserts multiple entries and reports inserted counts', () => {
    const service = openService();

    const entry1: FileEntry = {
      size: 100,
      directory: '/tmp/a',
      extension: '.png',
      path: '/tmp/a/x.png',
      filename: 'x.png',
      birthtime: new Date('2025-01-01T00:00:00.000Z'),
      hash: 'h1',
    };
    const entry2: FileEntry = {
      size: 200,
      directory: '/tmp/b',
      extension: '.png',
      path: '/tmp/b/y.png',
      filename: 'y.png',
      birthtime: new Date('2025-01-02T00:00:00.000Z'),
      hash: 'h2',
    };

    const counts = service.insertFileInfos([entry1, entry2]);

    expect(counts).toEqual({ inserted: 2, updated: 0 });
  });

  it('insertFileInfos reports updated counts for paths that already exist', () => {
    const service = openService();

    const original: FileEntry = {
      size: 100,
      directory: '/tmp/a',
      extension: '.png',
      path: '/tmp/a/x.png',
      filename: 'x.png',
      birthtime: new Date('2025-01-01T00:00:00.000Z'),
      hash: 'h1',
    };
    service.insertFileInfo(original);

    const updated: FileEntry = { ...original, size: 456, hash: 'h2' };
    const counts = service.insertFileInfos([updated]);

    expect(counts).toEqual({ inserted: 0, updated: 1 });
  });

  it('insertFileInfos rolls back all entries when one insert fails', () => {
    const service = openService();

    const good: FileEntry = {
      size: 100,
      directory: '/tmp/a',
      extension: '.png',
      path: '/tmp/a/good.png',
      filename: 'good.png',
      birthtime: new Date('2025-01-01T00:00:00.000Z'),
      hash: 'g',
    };

    // A duplicate `path` is not a natural failure here — `insertFileInfo` uses
    // `ON CONFLICT(path) DO UPDATE`, so it upserts. Add a unique index on `hash`
    // (test-only, not part of the schema) so a second row sharing `good`'s hash
    // throws a UNIQUE constraint that the `path` conflict target does not cover.
    const db = new Database(dbPath);
    db.prepare('CREATE UNIQUE INDEX idx_hash ON entries (hash)').run();
    db.close();

    const bad: FileEntry = {
      size: 200,
      directory: '/tmp/b',
      extension: '.png',
      path: '/tmp/b/bad.png', // different path (so ON CONFLICT(path) doesn't fire), same hash as `good`
      filename: 'bad.png',
      birthtime: new Date('2025-01-02T00:00:00.000Z'),
      hash: 'g',
    };

    expect(() => service.insertFileInfos([good, bad])).toThrow();

    const rows = new Database(dbPath).prepare('SELECT path FROM entries').all() as { path: string }[];
    expect(rows).toEqual([]); // the whole transaction rolled back
  });
});
