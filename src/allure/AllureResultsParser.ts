import * as fs from 'fs';
import * as path from 'path';
import { stripCategoryPrefix } from './AllureCategories';
import { AllureResult, ParsedResult } from './types';

/**
 * AllureResultsParser — reads allure-results/*.json and extracts failing and passing
 * scenarios that carry a Jira or GitHub issue label.
 *
 * Allure result files are generated per-test by:
 *   - allure-cucumberjs  →  @allure.label.issue=DEFECT-123 or @allure.label.github_issue=42
 *   - allure-playwright  →  allure.label('issue', 'DEFECT-123')
 *
 * This parser is framework-agnostic — it works with any allure-results directory.
 */
export class AllureResultsParser {
  constructor(private readonly resultsDir: string) {}

  parse(): ParsedResult[] {
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

    // Keyed by test id: when Allure records retries, only the last attempt counts
    const latest = new Map<string, ParsedResult>();

    for (const file of resultFiles) {
      const filePath = path.join(this.resultsDir, file);
      const result = this.readResult(filePath);
      if (!result) continue;

      // Passing tests matter too: a known defect whose test passes again may be fixed
      if (result.status !== 'failed' && result.status !== 'broken' && result.status !== 'passed') continue;

      // Resolve Jira ticket key — checks two sources in order:
      //   1. links[]  type:'issue'  → explicit URL, works without allure.properties
      //      e.g. { name: 'DEFECT-123', url: '...atlassian.net/browse/DEFECT-123', type: 'issue' }
      //   2. labels[] name:'issue'  → requires allure.properties URL pattern
      //      e.g. @allure.label.issue=DEFECT-123 or @issue:DEFECT-123 tags in Cucumber/Playwright
      const issueLink  = result.links?.find((l) => l.type === 'issue');
      const issueLabel = result.labels.find((l) => l.name === 'issue');
      const jiraTicket = issueLink?.name ?? issueLabel?.value;

      // Resolve GitHub Issue number — tag @allure.label.github_issue=42
      const githubLabel = result.labels.find((l) => l.name === 'github_issue');
      const githubIssue = githubLabel ? parseInt(githubLabel.value, 10) : undefined;

      // Skip entirely if neither destination is tagged
      if (!jiraTicket && !githubIssue) continue;

      const screenshotPath = this.findScreenshot(result, this.resultsDir);

      const duration =
        result.start && result.stop
          ? Math.round((result.stop - result.start) / 1000)
          : undefined;

      const testId = result.historyId ?? result.uuid;
      const previous = latest.get(testId);
      if (previous && (previous.stop ?? 0) > (result.stop ?? 0)) continue;

      latest.set(testId, {
        uuid: result.uuid,
        testId,
        status: result.status,
        file: filePath,
        stop: result.stop,
        scenarioName: result.name,
        fullName: result.fullName,
        // A results dir reported on before carries category prefixes in the message
        errorMessage: stripCategoryPrefix(result.statusDetails?.message ?? '') || 'No error message captured',
        errorTrace: result.statusDetails?.trace,
        jiraTicket,
        githubIssue,
        screenshotPath,
        duration,
      });
    }

    const results = [...latest.values()];
    const failing = results.filter((r) => r.status !== 'passed').length;
    console.log(`[Parser] ${results.length} tagged result(s): ${failing} failing, ${results.length - failing} passing`);
    return results;
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
