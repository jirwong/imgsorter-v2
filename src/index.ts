import { Runner } from './runner';
import { CliReporter } from './output/reporter';
import { loadRunConfiguration } from './utilities/load-config';

(async () => {
  const reporter = new CliReporter({ quiet: false, verbose: false, progress: process.stdout.isTTY === true });

  try {
    const config = await loadRunConfiguration('config.yaml');
    const runner = new Runner(config, reporter);
    try {
      const summary = await runner.run();
      reporter.stopProgress();
      reporter.printSummary(summary);
    } finally {
      runner.close();
    }
  } catch (err) {
    reporter.error(`Run failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
})();
