import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import type { FileEntry, FileRecord } from '../types/file-types';

type EntryRow = {
  size: number;
  directory: string;
  extension: string;
  filename: string;
  birthtime: string;
  hash: string | null;
  path: string;
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export class DbService {
  private db: DatabaseType;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.createTables();
  }

  close() {
    this.db.close();
  }

  private createTables() {
    // formatter: off
    this.db
      .prepare(
        `
    CREATE TABLE IF NOT EXISTS entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        size INTEGER,
        directory TEXT,
        extension TEXT,
        filename TEXT,
        birthtime TEXT,
        hash TEXT,
        path TEXT,
        UNIQUE(path)
    )`,
      )
      .run();
    // formatter: on

    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_entries_filename ON entries (filename)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_entries_hash ON entries (hash)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_entries_directory ON entries (directory)`).run();

    // formatter: off
    this.db
      .prepare(
        `
    CREATE TABLE IF NOT EXISTS records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT,
        hash TEXT,
        count INTEGER,
        directories TEXT,
        extension TEXT,
        size INTEGER,
        UNIQUE(filename, hash)
    )`,
      )
      .run();
    // formatter: on

    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_records_filename ON records (filename)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_records_hash ON records (hash)`).run();
  }

  insertFileInfo(fileInfo: FileEntry) {
    const insertSql = this.db.prepare(
      `INSERT INTO entries (size, directory, extension, filename, birthtime, hash, path)
       VALUES (@size, @directory, @extension, @filename, @birthtime, @hash, @path)
       ON CONFLICT(path) DO UPDATE SET
         size = excluded.size,
         extension = excluded.extension,
         birthtime = excluded.birthtime,
         hash = excluded.hash,
         filename = excluded.filename,
         directory = excluded.directory`,
    );
    insertSql.run({
      size: fileInfo.size,
      directory: fileInfo.directory,
      extension: fileInfo.extension,
      filename: fileInfo.filename,
      birthtime: fileInfo.birthtime.toISOString(),
      hash: fileInfo.hash ?? null,
      path: fileInfo.path,
    });
  }

  insertFileRecord(fileRecord: FileRecord) {
    const insertSql = this.db.prepare(
      `INSERT INTO records (filename, hash, count, directories, size, extension)
       VALUES (@filename, @hash, @count, @directories, @size, @extension)
       ON CONFLICT(filename, hash) DO UPDATE SET
         count = excluded.count,
         directories = excluded.directories,
         size = excluded.size,
         extension = excluded.extension`,
    );
    insertSql.run({
      filename: fileRecord.filename,
      hash: fileRecord.hash,
      count: fileRecord.count,
      directories: fileRecord.directories,
      size: fileRecord.size,
      extension: fileRecord.extension,
    });
  }

  updateFileRecords() {
    // Rebuild from scratch so records whose (filename, hash) no longer exists in
    // entries (e.g. after a resync removed the underlying files) are dropped.
    this.db.prepare('DELETE FROM records').run();

    const dedupSql = `select hash,
              filename,
              size,
              extension,
              cast(json_group_array(distinct directory) as varchar) as directories,
              count(*)                             as row_count
       from entries
       group by hash, filename, size, extension
       order by filename;
      `;

    const rows = this.db.prepare(dedupSql).all() as {
      hash: string;
      filename: string;
      directories: string;
      extension: string;
      row_count: number;
      size: number;
    }[];

    for (const row of rows) {
      // json_group_array returns a JSON array; round-trip through JSON.parse normalizes
      // escaping (e.g. Windows backslashes) without corrupting real double backslashes.
      const directories = JSON.stringify(JSON.parse(row.directories));

      this.insertFileRecord({
        filename: row.filename,
        hash: row.hash,
        count: row.row_count,
        extension: row.extension,
        directories,
        size: row.size,
      });
    }
  }

  getFileEntries() {
    const selectSql = `SELECT size, directory, extension, filename, birthtime, hash, path FROM entries`;
    const rows = this.db.prepare(selectSql).all() as EntryRow[];
    return rows.map((row) => this.mapEntry(row));
  }

  getFileEntriesByDirectory(directory: string) {
    // Match the directory itself and any directory beneath it, bounded by a path
    // separator. Wildcard characters in the directory name are escaped so they are
    // not treated as LIKE patterns. Both '/' and '\' separators are handled.
    const escaped = escapeLike(directory);
    const selectSql = `SELECT size, directory, extension, filename, birthtime, hash, path
       FROM entries
       WHERE directory = ? OR directory LIKE ? ESCAPE '\\' OR directory LIKE ? ESCAPE '\\'`;
    const rows = this.db.prepare(selectSql).all(directory, `${escaped}/%`, `${escaped}\\${'\\'}%`) as EntryRow[];
    return rows.map((row) => this.mapEntry(row));
  }

  deleteFileEntryById(id: number) {
    const deleteSql = `DELETE FROM entries WHERE id = ?`;
    this.db.prepare(deleteSql).run(id);
  }

  deleteFileEntryByPath(path: string) {
    const deleteSql = `DELETE FROM entries WHERE path = ?`;
    this.db.prepare(deleteSql).run(path);
  }

  private mapEntry(row: EntryRow): FileEntry {
    return {
      size: row.size,
      directory: row.directory,
      extension: row.extension,
      filename: row.filename,
      birthtime: new Date(row.birthtime),
      hash: row.hash ?? undefined,
      path: row.path,
    };
  }
}
