import * as dotenv from 'dotenv';
import { ConfigError, loadConfig } from '../src/config';
import { DefectReporter } from '../src/reporter/DefectReporter';

dotenv.config();

/**
 *   npm run report
 *   npm run report -- --dry-run                       print the comments, send nothing
 *   npm run report -- --results-dir=path/to/results   instead of ALLURE_RESULTS_DIR
 */
const args = process.argv.slice(2);

async function main(): Promise<void> {
  const config = loadConfig(process.env, {
    dryRun: args.includes('--dry-run'),
    resultsDir: args.find((a) => a.startsWith('--results-dir='))?.split('=')[1],
  });

  const summary = await new DefectReporter(config).run();
  if (summary.errored > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? err.message : `[defect-bridge] Fatal error: ${err}`);
  process.exit(1);
});
