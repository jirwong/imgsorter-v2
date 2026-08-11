import { buildIgnoredSet, isIgnored } from '../utilities/path-helpers';
import { throwIfAborted } from './abort';
import type { Reporter } from '../output/reporter';
import type { RunConfiguration } from '../types/configuration';
import type { PhaseName } from '../types/run-summary';
import type { ProgressSink } from '../types/progress';

type IterateDirectoriesDeps = {
  config: RunConfiguration;
  reporter: Reporter;
  progress: ProgressSink;
  signal: AbortSignal;
};

export async function iterateDirectories(
  phase: PhaseName,
  deps: IterateDirectoriesDeps,
  body: (directory: string) => Promise<void>,
): Promise<void> {
  const { config, reporter, progress, signal } = deps;
  const ignored = buildIgnoredSet(config.ignore_directories);

  for (const directory of config.directories) {
    throwIfAborted(signal);

    if (isIgnored(directory, ignored)) {
      reporter.info(`Ignoring directory: ${directory}`);
      continue;
    }

    progress.emitProgress({ type: 'directoryStart', phase, directory });
    await body(directory);
  }
}
