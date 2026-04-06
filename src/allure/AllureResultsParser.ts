import * as fs from 'fs';
import * as path from 'path';
import { AllureResult, ParsedFailure } from './types';

/**
 * AllureResultsParser — reads allure-results/*.json and extracts failed
 * scenarios that carry a Jira issue label.
 *
 * Allure result files are generated per-test by:
 *   - allure-cucumberjs  →  tag @allure.label.issue=DEFECT-123 or @issue:DEFECT-123
 *   - allure-playwright  →  allure.label('issue', 'DEFECT-123')
 *
 * This parser is framework-agnostic — it works with any allure-results directory.
 */
export class AllureResultsParser {
  constructor(private readonly resultsDir: string) {}

  parse(): ParsedFailure[] {
    if (!fs.existsSync(this.resultsDir)) {
      throw new Error(`allure-results directory not found: ${this.resultsDir}`);
    }

    const resultFiles = fs
      .readdirSync(this.resultsDir)
      .filter((f) => f.endsWith('-result.json'));

    if (resultFiles.length === 0) {
      console.warn(`[Parser] No result files found in: ${this.resultsDir}`);
      return [];
    }

    console.log(`[Parser] Found ${resultFiles.length} result file(s)`);

    const failures: ParsedFailure[] = [];

    for (const file of resultFiles) {
      const filePath = path.join(this.resultsDir, file);
      const result = this.readResult(filePath);
      if (!result) continue;

      // Only process failed or broken tests
      if (result.status !== 'failed' && result.status !== 'broken') continue;

      // Resolve Jira ticket key — checks two sources in order:
      //   1. links[]  type:'issue'  → explicit URL, works without allure.properties
      //      e.g. { name: 'DEFECT-123', url: '...atlassian.net/browse/DEFECT-123', type: 'issue' }
      //   2. labels[] name:'issue'  → requires allure.properties URL pattern
      //      e.g. @allure.label.issue=DEFECT-123 or @issue:DEFECT-123 tags in Cucumber/Playwright
      const issueLink  = result.links?.find((l) => l.type === 'issue');
      const issueLabel = result.labels.find((l) => l.name === 'issue');
      const ticketKey  = issueLink?.name ?? issueLabel?.value;
      if (!ticketKey) continue;

      const screenshotPath = this.findScreenshot(result, this.resultsDir);

      const duration =
        result.start && result.stop
          ? Math.round((result.stop - result.start) / 1000)
          : undefined;

      failures.push({
        uuid: result.uuid,
        scenarioName: result.name,
        fullName: result.fullName,
        errorMessage: result.statusDetails?.message ?? 'No error message captured',
        errorTrace: result.statusDetails?.trace,
        jiraTicket: ticketKey,
        screenshotPath,
        duration,
      });
    }

    console.log(`[Parser] ${failures.length} failure(s) linked to Jira tickets`);
    return failures;
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private readResult(filePath: string): AllureResult | null {
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as AllureResult;
    } catch {
      console.warn(`[Parser] Could not read result file: ${filePath}`);
      return null;
    }
  }

  private findScreenshot(result: AllureResult, resultsDir: string): string | undefined {
    const screenshot = result.attachments.find(
      (a) =>
        a.type === 'image/png' ||
        a.type === 'image/jpeg' ||
        a.name.toLowerCase().includes('screenshot')
    );
    if (!screenshot) return undefined;

    const fullPath = path.join(resultsDir, screenshot.source);
    return fs.existsSync(fullPath) ? fullPath : undefined;
  }
}
