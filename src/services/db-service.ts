import Database from 'better-sqlite3';
import type { Database as DatabaseType, Statement } from 'better-sqlite3';
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

export type DuplicateStats = {
  duplicateGroups: number;
  duplicateFiles: number;
};

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export class DbService {
  private db: DatabaseType;
  private insertEntryStmt!: Statement;
  private insertRecordStmt!: Statement;
  private selectEntriesByDirStmt!: Statement;
  private deleteEntryByPathStmt!: Statement;
  private deleteAllRecordsStmt!: Statement;
  private dedupStmt!: Statement;
  private lastInsertRowidStmt!: Statement;
  private duplicateGroupsStmt!: Statement;
  private duplicateFilesStmt!: Statement;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.createTables();
    this.prepareStatements();
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

  private prepareStatements() {
    this.insertEntryStmt = this.db.prepare(
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

    this.insertRecordStmt = this.db.prepare(
      `INSERT INTO records (filename, hash, count, directories, size, extension)
       VALUES (@filename, @hash, @count, @directories, @size, @extension)
       ON CONFLICT(filename, hash) DO UPDATE SET
         count = excluded.count,
         directories = excluded.directories,
         size = excluded.size,
         extension = excluded.extension`,
    );

    this.selectEntriesByDirStmt = this.db.prepare(
      `SELECT size, directory, extension, filename, birthtime, hash, path
       FROM entries
       WHERE directory = ? OR directory LIKE ? ESCAPE '\\' OR directory LIKE ? ESCAPE '\\'`,
    );

    this.deleteEntryByPathStmt = this.db.prepare(`DELETE FROM entries WHERE path = ?`);
    this.deleteAllRecordsStmt = this.db.prepare(`DELETE FROM records`);

    this.dedupStmt = this.db.prepare(
      `select hash,
              filename,
              size,
              extension,
              cast(json_group_array(distinct directory) as varchar) as directories,
              count(*)                             as row_count
       from entries
       group by hash, filename, size, extension
       order by filename;
      `,
    );

    this.lastInsertRowidStmt = this.db.prepare(`SELECT last_insert_rowid() AS rowid`);
    this.duplicateGroupsStmt = this.db.prepare(`SELECT COUNT(*) AS n FROM records WHERE count > 1`);
    this.duplicateFilesStmt = this.db.prepare(`SELECT COALESCE(SUM(count - 1), 0) AS n FROM records WHERE count > 1`);
  }

  insertFileInfo(fileInfo: FileEntry): 'inserted' | 'updated' {
    // An INSERT sets last_insert_rowid() to the new row id. An ON CONFLICT DO
    // UPDATE — even a no-op one — leaves last_insert_rowid() unchanged, so the
    // before/after comparison distinguishes inserted from updated.
    const before = this.lastInsertRowidStmt.get() as { rowid: number };

    this.insertEntryStmt.run({
      size: fileInfo.size,
      directory: fileInfo.directory,
      extension: fileInfo.extension,
      filename: fileInfo.filename,
      birthtime: fileInfo.birthtime.toISOString(),
      hash: fileInfo.hash ?? null,
      path: fileInfo.path,
    });

    const after = this.lastInsertRowidStmt.get() as { rowid: number };
    return before.rowid === after.rowid ? 'updated' : 'inserted';
  }

  insertFileInfos(files: FileEntry[]): { inserted: number; updated: number } {
    const insertAll = this.db.transaction((entries: FileEntry[]) => {
      let inserted = 0;
      let updated = 0;
      for (const file of entries) {
        if (this.insertFileInfo(file) === 'inserted') {
          inserted += 1;
        } else {
          updated += 1;
        }
      }
      return { inserted, updated };
    });
    return insertAll(files);
  }

  private insertFileRecord(fileRecord: FileRecord) {
    this.insertRecordStmt.run({
      filename: fileRecord.filename,
      hash: fileRecord.hash,
      count: fileRecord.count,
      directories: fileRecord.directories,
      size: fileRecord.size,
      extension: fileRecord.extension,
    });
  }

  updateFileRecords() {
    // Rebuild in a single transaction so a failure leaves the previous records
    // table intact rather than half-deleted.
    const rebuild = this.db.transaction(() => {
      this.deleteAllRecordsStmt.run();

      const rows = this.dedupStmt.all() as {
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
    });
    rebuild();
  }

  /**
   * Duplicate statistics derived from the `records` table.
   *
   * Precondition: call `updateFileRecords()` after any `entries` change so the
   * `records` table reflects current entries; otherwise the results are stale
   * (and `{0, 0}` for a fresh table). The Runner always runs `updateFileRecords`
   * before reading these stats.
   *
   * A "duplicate group" is a `records` row with count > 1 — the same filename,
   * size and hash verified in more than one directory. Files with identical
   * content but different names form separate single-count groups and are not
   * counted (this matches `updateFileRecords` grouping).
   *
   * Entries written with `getHash=false` store a NULL hash and group under NULL;
   * such rows are counted like any other (unverified, same-named, same-sized
   * files).
   */
  getDuplicateStats(): DuplicateStats {
    const groups = this.duplicateGroupsStmt.get() as { n: number };
    const files = this.duplicateFilesStmt.get() as { n: number };
    return { duplicateGroups: groups.n, duplicateFiles: files.n };
  }

  getFileEntriesByDirectory(directory: string) {
    // Match the directory itself and any directory beneath it, bounded by a path
    // separator. Wildcard characters in the directory name are escaped so they are
    // not treated as LIKE patterns. Both '/' and '\' separators are handled.
    const escaped = escapeLike(directory);
    const rows = this.selectEntriesByDirStmt.all(directory, `${escaped}/%`, `${escaped}\\${'\\'}%`) as EntryRow[];
    return rows.map((row) => this.mapEntry(row));
  }

  deleteFileEntryByPath(path: string) {
    this.deleteEntryByPathStmt.run(path);
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
