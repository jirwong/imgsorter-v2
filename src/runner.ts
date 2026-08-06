import { DbService } from './services/db-service';
import { fileExists, listFilePathsRecursive, listFilesRecursive } from './services/file-service';
import type { RunConfiguration } from './types/configuration';

// Normalize paths for comparison: trim trailing separators and ignore case
// (filesystems on Windows are case-insensitive).
function normalizePath(path: string): string {
  return path.replace(/[\\/]+$/, '').toLowerCase();
}

export class Runner {
  private db: DbService;
  private config: RunConfiguration;

  constructor(config: RunConfiguration) {
    this.config = config;
    this.db = new DbService(config.dbName);
  }

  close() {
    this.db.close();
  }

  async run(): Promise<void> {
    console.log('Starting run...');

    if (this.config.process_directories) {
      await this.processDirectories();
    }

    if (this.config.resync_directories) {
      await this.resyncDirectories(this.config.resync_check_actual_file);
    }

    if (this.config.update_records) {
      this.updateRecords();
    }

    console.log('Run completed.');
  }

  private async processDirectories(): Promise<void> {
    const { directories, extensions, ignore_directories } = this.config;

    console.log('Processing directories:', directories);

    const ignored = new Set(ignore_directories.map(normalizePath));

    for (const directory of directories) {
      if (ignored.has(normalizePath(directory))) {
        console.log(`Ignoring directory: ${directory}`);
        continue;
      }

      try {
        const files = await listFilesRecursive(directory, extensions, true, ignore_directories);

        for (const file of files) {
          this.db.insertFileInfo(file);
        }
      } catch (err) {
        console.warn(`Failed to scan directory: ${directory} (${err instanceof Error ? err.message : String(err)})`);
      }
    }

    console.log('Processed all directories.');
  }

  private async resyncDirectories(checkActualFile: boolean = false): Promise<void> {
    const { directories, ignore_directories } = this.config;

    console.log('Resyncing directories:', directories);

    const ignored = new Set(ignore_directories.map(normalizePath));

    for (const directory of directories) {
      if (ignored.has(normalizePath(directory))) {
        console.log(`Ignoring directory: ${directory}`);
        continue;
      }

      try {
        const entries = this.db.getFileEntriesByDirectory(directory);

        if (checkActualFile) {
          console.log('Checking actual file existence for entries...');
          for (const entry of entries) {
            console.log(`Checking file existence: ${entry.path}`);
            const exists = await fileExists(entry.path);
            if (!exists) {
              this.db.deleteFileEntryByPath(entry.path);
              console.log(`Deleted missing file entry: ${entry.path}`);
            }
          }
        } else {
          console.log('Checking file entries against current directory listing...');
          const files = await listFilePathsRecursive(directory, ignore_directories);
          const currentPaths = new Set(files.map(normalizePath));
          for (const entry of entries) {
            console.log(`Verifying file entry: ${entry.path}`);
            if (!currentPaths.has(normalizePath(entry.path))) {
              this.db.deleteFileEntryByPath(entry.path);
              console.log(`Deleted missing file entry: ${entry.path}`);
            }
          }
        }
      } catch (err) {
        console.warn(`Failed to resync directory: ${directory} (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }

  private updateRecords() {
    console.log('Updating database record...');
    this.db.updateFileRecords();
  }
}
