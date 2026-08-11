import { Command, CommanderError } from 'commander';
import { version } from '../package.json';
import { Runner } from './runner';
import { CliReporter } from './output/reporter';
import { ProgressEmitter } from './output/progress';
import { RunAbortedError } from './phases/abort';
import { loadRunConfiguration } from './utilities/load-config';

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function main(argv: string[]): Promise<number> {
  // pnpm run forwards the `--` separator literally (e.g. `pnpm start -- --config x`),
  // so drop a single leading separator before commander sees it.
  const args = argv[0] === '--' ? argv.slice(1) : argv;

  const program = new Command();
  program
    .name('imgsorter')
    .description('Index local files and detect duplicates across directories')
    .version(version)
    .option('--config <path>', 'path to the config file', 'config.yaml')
    .option('--quiet', 'only show warnings and errors')
    .option('--verbose', 'enable debug-level output')
    .option('--no-progress', 'disable the live progress spinner');
  program.exitOverride();

  try {
    program.parse(args, { from: 'user' });
  } catch (err) {
    if (err instanceof CommanderError) {
      return err.exitCode;
    }
    return 1;
  }

  const opts = program.opts<{ config: string; quiet: boolean; verbose: boolean; progress: boolean }>();

  const reporter = new CliReporter({
    quiet: opts.quiet,
    verbose: opts.verbose,
    progress: opts.progress && process.stdout.isTTY === true,
  });

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.once('SIGINT', onSigint);

  let config;
  try {
    config = await loadRunConfiguration(opts.config);
  } catch (err) {
    process.removeListener('SIGINT', onSigint);
    reporter.error(`Invalid config: ${errorMessage(err)}`);
    return 1;
  }

  const progress = new ProgressEmitter();
  reporter.subscribe(progress);

  let runner: Runner | undefined;
  try {
    runner = new Runner(config, { reporter, progress, signal: controller.signal });
    const summary = await runner.run();
    reporter.stopProgress();
    reporter.printSummary(summary);
    return 0;
  } catch (err) {
    if (err instanceof RunAbortedError) {
      reporter.error(`Run cancelled`);
      return 130;
    }
    reporter.error(`Run failed: ${errorMessage(err)}`);
    return 2;
  } finally {
    process.removeListener('SIGINT', onSigint);
    runner?.close();
  }
}
