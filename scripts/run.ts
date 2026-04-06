import { DefectReporter } from '../src/reporter/DefectReporter';

const reporter = new DefectReporter();

reporter.run().catch((err) => {
  console.error('[defect-bridge] Fatal error:', err);
  process.exit(1);
});
