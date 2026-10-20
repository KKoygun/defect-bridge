import * as dotenv from 'dotenv';
import { ConfigError, loadConfig } from '../src/config';
import { DefectReporter } from '../src/reporter/DefectReporter';

dotenv.config();

/**
 *   npm run report
 *   npm run report -- --dry-run                       print the comments, send nothing
 *   npm run report -- --results-dir=path/to/results   instead of ALLURE_RESULTS_DIR
 *
 * Exit codes:
 *   0  done — including tickets that could not be updated, unless FAIL_ON_REPORT_ERROR=true
 *   1  some tickets could not be updated and FAIL_ON_REPORT_ERROR=true
 *   2  bad configuration or unreadable results directory — nothing was reported
 */
const args = process.argv.slice(2);

async function main(): Promise<void> {
  const config = loadConfig(process.env, {
    dryRun: args.includes('--dry-run'),
    resultsDir: args.find((a) => a.startsWith('--results-dir='))?.split('=')[1],
  });

  const summary = await new DefectReporter(config).run();

  if (summary.errored > 0) {
    if (config.run.failOnReportError) {
      process.exitCode = 1;
    } else {
      console.warn(`[defect-bridge] ${summary.errored} update(s) failed. Set FAIL_ON_REPORT_ERROR=true to fail the build on this.`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof ConfigError ? err.message : `[defect-bridge] ${err instanceof Error ? err.message : err}`);
  process.exit(2);
});
