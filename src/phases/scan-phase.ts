import { listFilesRecursive } from '../services/file-service';
import { iterateDirectories } from './iterate-directories';
import { RunAbortedError, throwIfAborted } from './abort';
import type { Phase, PhaseContext, PhaseResult } from './types';
import type { RunConfiguration } from '../types/configuration';
import type { FileEntry } from '../types/file-types';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ScanPhase implements Phase {
  readonly name = 'scan' as const;

  enabled(config: RunConfiguration): boolean {
    return config.process_directories;
  }

  async run(ctx: PhaseContext): Promise<PhaseResult> {
    throwIfAborted(ctx.signal);

    const start = performance.now();
    ctx.progress.emitProgress({ type: 'phaseStart', phase: 'scan', marker: ctx.marker });

    let filesScanned = 0;
    let entriesUpserted = 0;
    let filesProcessed = 0;
    const errors: string[] = [];

    await iterateDirectories(
      'scan',
      { config: ctx.config, reporter: ctx.reporter, progress: ctx.progress, signal: ctx.signal },
      async (directory) => {
        let files: FileEntry[];
        try {
          files = await listFilesRecursive(
            directory,
            ctx.config.extensions,
            true,
            ctx.config.ignore_directories,
            (filePath) => {
              throwIfAborted(ctx.signal);
              filesProcessed += 1;
              ctx.progress.emitProgress({
                type: 'file',
                phase: 'scan',
                directory,
                currentFile: filePath,
                filesProcessed,
                totalFiles: null,
              });
            },
          );
        } catch (err) {
          if (err instanceof RunAbortedError) {
            throw err;
          }
          errors.push(`Scan ${directory}: ${errorMessage(err)}`);
          ctx.reporter.warn(`Failed to scan directory: ${directory} (${errorMessage(err)})`);
          return;
        }

        ctx.progress.emitProgress({ type: 'counts', phase: 'scan', filesProcessed, totalFiles: filesProcessed });

        filesScanned += files.length;
        const { inserted, updated } = ctx.db.insertFileEntries(files);
        entriesUpserted += inserted + updated;
      },
    );

    return {
      name: 'scan',
      elapsedMs: Math.round(performance.now() - start),
      errors,
      filesScanned,
      entriesUpserted,
    };
  }
}
