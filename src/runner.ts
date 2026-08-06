import { DbService } from './services/db-service';
import { fileExists, listFilePathsRecursive, listFilesRecursive } from './services/file-service';
import type { Reporter } from './output/reporter';
import type { RunConfiguration } from './types/configuration';
import type { RunSummary } from './types/run-summary';
import { buildIgnoredSet, isIgnored, normalizePath } from './utilities/path-helpers';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class Runner {
  private db: DbService;
  private config: RunConfiguration;
  private reporter: Reporter;

  constructor(config: RunConfiguration, reporter: Reporter) {
    this.config = config;
    this.reporter = reporter;
    this.db = new DbService(config.dbName);
  }

  close() {
    this.db.close();
  }

  async run(): Promise<RunSummary> {
    const phases: RunSummary['phases'] = [];
    const errors: string[] = [];
    let filesScanned = 0;
    let entriesUpserted = 0;
    let duplicateGroups = 0;
    let duplicateFiles = 0;
    let staleRemoved = 0;

    if (this.config.process_directories) {
      const result = await this.processDirectories(errors);
      phases.push({ name: 'scan', elapsedMs: result.elapsedMs });
      filesScanned = result.filesScanned;
      entriesUpserted = result.entriesUpserted;
    }

    if (this.config.resync_directories) {
      const result = await this.resyncDirectories(this.config.resync_check_actual_file, errors);
      phases.push({ name: 'resync', elapsedMs: result.elapsedMs });
      staleRemoved = result.staleRemoved;
    }

    if (this.config.update_records) {
      const result = this.updateRecords();
      phases.push({ name: 'records', elapsedMs: result.elapsedMs });
      duplicateGroups = result.duplicateGroups;
      duplicateFiles = result.duplicateFiles;
    }

    return { phases, filesScanned, entriesUpserted, duplicateGroups, duplicateFiles, staleRemoved, errors };
  }

  private async processDirectories(
    errors: string[],
  ): Promise<{ elapsedMs: number; filesScanned: number; entriesUpserted: number }> {
    const { directories, extensions, ignore_directories } = this.config;
    const ignored = buildIgnoredSet(ignore_directories);
    const start = performance.now();

    this.reporter.info('[1/3] Scanning…');
    this.reporter.progress('[1/3] Scanning…');

    let filesScanned = 0;
    let entriesUpserted = 0;

    for (const directory of directories) {
      if (isIgnored(directory, ignored)) {
        this.reporter.info(`Ignoring directory: ${directory}`);
        continue;
      }

      this.reporter.progress(`Scanning ${directory}`);

      try {
        const files = await listFilesRecursive(directory, extensions, true, ignore_directories);
        filesScanned += files.length;
        for (const file of files) {
          const status = this.db.insertFileInfo(file);
          this.reporter.debug(`Upserted (${status}) ${file.path}`);
          entriesUpserted += 1;
        }
      } catch (err) {
        errors.push(`Scan ${directory}: ${errorMessage(err)}`);
        this.reporter.warn(`Failed to scan directory: ${directory} (${errorMessage(err)})`);
      }
    }

    return { elapsedMs: Math.round(performance.now() - start), filesScanned, entriesUpserted };
  }

  private async resyncDirectories(
    checkActualFile: boolean,
    errors: string[],
  ): Promise<{ elapsedMs: number; staleRemoved: number }> {
    const { directories, ignore_directories } = this.config;
    const ignored = buildIgnoredSet(ignore_directories);
    const start = performance.now();

    this.reporter.info('[2/3] Resyncing…');
    this.reporter.progress('[2/3] Resyncing…');

    let staleRemoved = 0;

    for (const directory of directories) {
      if (isIgnored(directory, ignored)) {
        this.reporter.info(`Ignoring directory: ${directory}`);
        continue;
      }

      this.reporter.progress(`Resyncing ${directory}`);

      try {
        const entries = this.db.getFileEntriesByDirectory(directory);

        if (checkActualFile) {
          for (const entry of entries) {
            this.reporter.debug(`Checking file existence: ${entry.path}`);
            const exists = await fileExists(entry.path);
            if (!exists) {
              this.db.deleteFileEntryByPath(entry.path);
              staleRemoved += 1;
            }
          }
        } else {
          const files = await listFilePathsRecursive(directory, ignore_directories);
          const currentPaths = new Set(files.map(normalizePath));
          for (const entry of entries) {
            this.reporter.debug(`Verifying file entry: ${entry.path}`);
            if (!currentPaths.has(normalizePath(entry.path))) {
              this.db.deleteFileEntryByPath(entry.path);
              staleRemoved += 1;
            }
          }
        }
      } catch (err) {
        errors.push(`Resync ${directory}: ${errorMessage(err)}`);
        this.reporter.warn(`Failed to resync directory: ${directory} (${errorMessage(err)})`);
      }
    }

    return { elapsedMs: Math.round(performance.now() - start), staleRemoved };
  }

  private updateRecords(): { elapsedMs: number; duplicateGroups: number; duplicateFiles: number } {
    const start = performance.now();

    this.reporter.info('[3/3] Rebuilding records…');
    this.reporter.progress('[3/3] Rebuilding records…');

    this.db.updateFileRecords();
    const stats = this.db.getDuplicateStats();

    return {
      elapsedMs: Math.round(performance.now() - start),
      duplicateGroups: stats.duplicateGroups,
      duplicateFiles: stats.duplicateFiles,
    };
  }
}
