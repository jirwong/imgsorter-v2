import { DbService } from './services/db-service';
import { PHASES } from './phases';
import type { Reporter } from './output/reporter';
import type { ProgressSink } from './types/progress';
import type { RunConfiguration } from './types/configuration';
import type { PhaseContext, PhaseResult } from './phases/types';
import type { RunSummary } from './types/run-summary';

type RunnerDeps = {
  reporter: Reporter;
  progress: ProgressSink;
  signal: AbortSignal;
};

export class Runner {
  private db: DbService;
  private config: RunConfiguration;
  private deps: RunnerDeps;

  constructor(config: RunConfiguration, deps: RunnerDeps) {
    this.config = config;
    this.deps = deps;
    this.db = new DbService(config.dbName);
  }

  close() {
    this.db.close();
  }

  async run(): Promise<RunSummary> {
    const summary: RunSummary = {
      phases: [],
      filesScanned: 0,
      entriesWritten: 0,
      duplicateGroups: 0,
      duplicateFiles: 0,
      staleRemoved: 0,
      errors: [],
    };

    const enabled = PHASES.filter((phase) => phase.enabled(this.config));

    for (let i = 0; i < enabled.length; i += 1) {
      const phase = enabled[i];
      const marker = `[${i + 1}/${enabled.length}]`;
      const ctx: PhaseContext = {
        config: this.config,
        db: this.db,
        reporter: this.deps.reporter,
        progress: this.deps.progress,
        marker,
        signal: this.deps.signal,
      };
      const result: PhaseResult = await phase.run(ctx);
      summary.phases.push({ name: result.name, elapsedMs: result.elapsedMs });
      switch (result.name) {
        case 'scan':
          summary.filesScanned = result.filesScanned;
          summary.entriesWritten = result.entriesWritten;
          break;
        case 'resync':
          summary.staleRemoved = result.staleRemoved;
          break;
        case 'records':
          summary.duplicateGroups = result.duplicateGroups;
          summary.duplicateFiles = result.duplicateFiles;
          break;
      }
      summary.errors.push(...result.errors);
    }

    return summary;
  }
}
