import { DefectReporter } from '../src/reporter/DefectReporter';

// Pass --dry-run to preview reports without making any API calls.
const dryRun = process.argv.includes('--dry-run');

const reporter = new DefectReporter({ dryRun });

reporter.run().catch((err) => {
  console.error('[defect-bridge] Fatal error:', err);
  process.exit(1);
});
