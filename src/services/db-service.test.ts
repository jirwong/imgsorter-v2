import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promises as fs } from 'node:fs';
import Database from 'better-sqlite3';
import { DbService } from './db-service';
import type { FileEntry, FileRecord } from '../types/file-types';

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
    const service = openService();
    expect(service.getFileEntries()).toEqual([]);

    const db = new Database(dbPath);
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

  it('inserts a FileRecord into records table', () => {
    const service = openService();

    const record: FileRecord = {
      filename: 'bar.png',
      hash: 'def456',
      count: 2,
      directories: `['/tmp/a', '/tmp/b']`,
      size: 200,
      extension: '.png',
    };

    service.insertFileRecord(record);

    const db = new Database(dbPath);
    const rows = db.prepare('SELECT filename, hash, count, directories FROM records').all() as {
      filename: string;
      hash: string;
      count: number;
      directories: string;
    }[];

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.filename).toBe(record.filename);
    expect(row.hash).toBe(record.hash);
    expect(row.count).toBe(record.count);
    expect(row.directories).toEqual(record.directories);

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

  it('upserts a FileRecord when called with the same filename and hash', () => {
    const service = openService();

    const original: FileRecord = {
      filename: 'baz.png',
      hash: 'ghi789',
      count: 1,
      directories: `['/tmp/x']`,
      size: 300,
      extension: '.png',
    };

    const updated: FileRecord = {
      ...original,
      count: 3,
      directories: `['/tmp/x','/tmp/y']`,
    };

    service.insertFileRecord(original);
    service.insertFileRecord(updated);

    const db = new Database(dbPath);
    const rows = db.prepare('SELECT filename, hash, count, directories FROM records').all() as {
      filename: string;
      hash: string;
      count: number;
      directories: string;
    }[];

    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.filename).toBe(updated.filename);
    expect(row.hash).toBe(updated.hash);
    expect(row.count).toBe(updated.count);
    expect(row.directories).toEqual(updated.directories);

    db.close();
  });

  it('returns all file entries from the entries table via getFileEntries', () => {
    const service = openService();

    const entry1: FileEntry = {
      size: 100,
      directory: '/tmp/a',
      extension: '.txt',
      path: '/tmp/a/foo.txt',
      filename: 'foo.txt',
      birthtime: new Date('2025-01-01T00:00:00.000Z'),
      hash: 'hash-1',
    };

    const entry2: FileEntry = {
      size: 200,
      directory: '/tmp/b',
      extension: '.log',
      path: '/tmp/b/bar.log',
      filename: 'bar.log',
      birthtime: new Date('2025-02-02T00:00:00.000Z'),
    };

    service.insertFileInfo(entry1);
    service.insertFileInfo(entry2);

    const entries = service.getFileEntries();

    expect(entries).toHaveLength(2);

    const byPath = new Map(entries.map((e) => [e.path, e]));

    const e1 = byPath.get(entry1.path)!;
    expect(e1.size).toBe(entry1.size);
    expect(e1.directory).toBe(entry1.directory);
    expect(e1.extension).toBe(entry1.extension);
    expect(e1.filename).toBe(entry1.filename);
    expect(e1.birthtime).toEqual(entry1.birthtime);
    expect(e1.hash).toBe(entry1.hash);
    expect(e1.path).toBe(entry1.path);

    const e2 = byPath.get(entry2.path)!;
    expect(e2.size).toBe(entry2.size);
    expect(e2.directory).toBe(entry2.directory);
    expect(e2.extension).toBe(entry2.extension);
    expect(e2.filename).toBe(entry2.filename);
    expect(e2.birthtime).toEqual(entry2.birthtime);
    expect(e2.hash).toBeUndefined();
    expect(e2.path).toBe(entry2.path);
  });

  it('deletes a file entry by id', () => {
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
    const row = db.prepare('SELECT id FROM entries WHERE path = ?').get(entry.path) as { id: number };
    expect(row).toBeTruthy();

    service.deleteFileEntryById(row.id);

    const after = db.prepare('SELECT id FROM entries WHERE id = ?').get(row.id) as { id: number } | undefined;
    expect(after).toBeUndefined();

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
});
