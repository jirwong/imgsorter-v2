import { createSpinner } from 'nanospinner';
import type { Spinner } from 'nanospinner';
import type { RunSummary } from '../types/run-summary';

export interface Reporter {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  progress(msg: string): void;
  stopProgress(): void;
  printSummary(summary: RunSummary): void;
}

export type ReporterOptions = {
  quiet: boolean;
  verbose: boolean;
  progress: boolean;
};

export class CliReporter implements Reporter {
  private spinner: Spinner | null = null;

  constructor(private readonly options: ReporterOptions) {}

  debug(msg: string): void {
    if (this.options.verbose && !this.options.quiet) {
      this.stopProgress();
      console.log(`[debug] ${msg}`);
    }
  }

  info(msg: string): void {
    if (!this.options.quiet) {
      this.stopProgress();
      console.log(msg);
    }
  }

  warn(msg: string): void {
    this.stopProgress();
    console.warn(msg);
  }

  error(msg: string): void {
    this.stopProgress();
    console.error(msg);
  }

  // Quiet mode means "warnings and errors only", so it suppresses the spinner
  // as well; `--no-progress` disables it for piped output.
  progress(msg: string): void {
    if (!this.options.progress || this.options.quiet) {
      return;
    }
    if (this.spinner === null) {
      this.spinner = createSpinner(msg).start();
    } else {
      this.spinner.update({ text: msg });
    }
  }

  stopProgress(): void {
    if (this.spinner !== null) {
      this.spinner.stop();
      this.spinner = null;
    }
  }

  printSummary(summary: RunSummary): void {
    for (const phase of summary.phases) {
      switch (phase.name) {
        case 'scan':
          this.info(
            `Scan: ${summary.filesScanned} files scanned, ${summary.entriesUpserted} entries upserted (${phase.elapsedMs} ms)`,
          );
          break;
        case 'resync':
          this.info(`Resync: ${summary.staleRemoved} stale entries removed (${phase.elapsedMs} ms)`);
          break;
        case 'records':
          this.info(
            `Records: ${summary.duplicateGroups} duplicate group${summary.duplicateGroups === 1 ? '' : 's'}, ${summary.duplicateFiles} duplicate file${summary.duplicateFiles === 1 ? '' : 's'} (${phase.elapsedMs} ms)`,
          );
          break;
        default: {
          const exhaustiveCheck: never = phase.name;
          throw new Error(`Unhandled phase: ${exhaustiveCheck}`);
        }
      }
    }
    if (summary.errors.length > 0) {
      this.warn(`Encountered ${summary.errors.length} error(s):`);
      for (const error of summary.errors) {
        this.warn(`  - ${error}`);
      }
    }
  }
}
