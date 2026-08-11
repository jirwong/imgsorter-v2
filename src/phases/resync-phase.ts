import { fileExists, listFilePathsRecursive } from '../services/file-service';
import { normalizePath } from '../utilities/path-helpers';
import { iterateDirectories } from './iterate-directories';
import { RunAbortedError, throwIfAborted } from './abort';
import type { Phase, PhaseContext, PhaseResult } from './types';
import type { RunConfiguration } from '../types/configuration';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class ResyncPhase implements Phase {
  readonly name = 'resync' as const;

  enabled(config: RunConfiguration): boolean {
    return config.resync_directories;
  }

  async run(ctx: PhaseContext): Promise<PhaseResult> {
    throwIfAborted(ctx.signal);

    const start = performance.now();
    ctx.progress.emitProgress({ type: 'phaseStart', phase: 'resync', marker: ctx.marker });

    let staleRemoved = 0;
    let filesProcessed = 0;
    const errors: string[] = [];

    await iterateDirectories(
      'resync',
      { config: ctx.config, reporter: ctx.reporter, progress: ctx.progress, signal: ctx.signal },
      async (directory) => {
        const entries = ctx.db.getFileEntriesByDirectory(directory);

        if (ctx.config.resync_check_actual_file) {
          const dirTotal = filesProcessed + entries.length;
          ctx.progress.emitProgress({ type: 'counts', phase: 'resync', filesProcessed, totalFiles: dirTotal });

          for (const entry of entries) {
            throwIfAborted(ctx.signal);
            filesProcessed += 1;
            ctx.progress.emitProgress({
              type: 'file',
              phase: 'resync',
              directory,
              currentFile: entry.path,
              filesProcessed,
              totalFiles: dirTotal,
            });
            ctx.reporter.debug(`Checking file existence: ${entry.path}`);
            const exists = await fileExists(entry.path);
            if (!exists) {
              ctx.db.deleteFileEntryByPath(entry.path);
              staleRemoved += 1;
            }
          }
          return;
        }

        let files: string[];
        try {
          files = await listFilePathsRecursive(directory, ctx.config.ignore_directories, (filePath) => {
            throwIfAborted(ctx.signal);
            filesProcessed += 1;
            ctx.progress.emitProgress({
              type: 'file',
              phase: 'resync',
              directory,
              currentFile: filePath,
              filesProcessed,
              totalFiles: null,
            });
          });
        } catch (err) {
          if (err instanceof RunAbortedError) {
            throw err;
          }
          errors.push(`Resync ${directory}: ${errorMessage(err)}`);
          ctx.reporter.warn(`Failed to resync directory: ${directory} (${errorMessage(err)})`);
          return;
        }

        const dirTotal = filesProcessed + entries.length;
        ctx.progress.emitProgress({ type: 'counts', phase: 'resync', filesProcessed, totalFiles: dirTotal });

        const currentPaths = new Set(files.map(normalizePath));
        for (const entry of entries) {
          throwIfAborted(ctx.signal);
          filesProcessed += 1;
          ctx.progress.emitProgress({
            type: 'file',
            phase: 'resync',
            directory,
            currentFile: entry.path,
            filesProcessed,
            totalFiles: dirTotal,
          });
          ctx.reporter.debug(`Verifying file entry: ${entry.path}`);
          if (!currentPaths.has(normalizePath(entry.path))) {
            ctx.db.deleteFileEntryByPath(entry.path);
            staleRemoved += 1;
          }
        }
      },
    );

    return {
      name: 'resync',
      elapsedMs: Math.round(performance.now() - start),
      errors,
      staleRemoved,
    };
  }
}
