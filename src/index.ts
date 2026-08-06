import { Runner } from './runner';
import { loadRunConfiguration } from './utilities/load-config';

(async () => {
  const config = await loadRunConfiguration('config.yaml');

  const runner = new Runner(config);
  try {
    await runner.run();
  } finally {
    runner.close();
  }
})();
