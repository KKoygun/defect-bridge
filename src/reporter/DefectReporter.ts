import { AllureResultsParser } from '../allure/AllureResultsParser';
import { JiraClient } from '../jira/JiraClient';
import { CommentBuilder } from '../jira/CommentBuilder';
import { config } from '../config';

/**
 * DefectReporter — orchestrates the full reporting pipeline:
 *
 *   1. Parse allure-results → find failures with @issue tags
 *   2. Verify each Jira ticket exists
 *   3. Post a structured ADF comment with failure details
 *   4. Attach screenshot if present
 *   5. Print a summary
 */
export class DefectReporter {
  private readonly parser: AllureResultsParser;
  private readonly jira: JiraClient;
  private readonly commentBuilder: CommentBuilder;

  constructor() {
    this.parser = new AllureResultsParser(config.allure.resultsDir);
    this.jira = new JiraClient(config.jira.baseUrl, config.jira.email, config.jira.apiToken);
    this.commentBuilder = new CommentBuilder();
  }

  async run(): Promise<void> {
    console.log('\n── defect-bridge ──────────────────────────────────────');
    console.log(`Allure results: ${config.allure.resultsDir}`);
    console.log(`Jira instance:  ${config.jira.baseUrl}`);
    console.log(`Environment:    ${config.run.env}`);
    if (config.run.runId) console.log(`CI Run ID:      ${config.run.runId}`);
    console.log('────────────────────────────────────────────────────────\n');

    const failures = this.parser.parse();

    if (failures.length === 0) {
      console.log('✅ No failures with @issue tags found. Nothing to report.');
      return;
    }

    let reported = 0;
    let skipped = 0;
    let errored = 0;

    for (const failure of failures) {
      console.log(`\n[${failure.jiraTicket}] ${failure.scenarioName}`);

      // Verify ticket exists before attempting to comment
      const issue = await this.jira.getIssue(failure.jiraTicket);
      if (!issue) {
        console.warn(`  ⚠️  Ticket not found: ${failure.jiraTicket} — skipping`);
        skipped++;
        continue;
      }

      console.log(`  Ticket: ${issue.key} — ${issue.summary}`);

      try {
        // Post comment
        const commentBody = this.commentBuilder.build(
          failure,
          config.run.env,
          config.run.runId
        );
        await this.jira.addComment(failure.jiraTicket, commentBody);
        console.log(`  ✅ Comment posted`);

        // Attach screenshot if available
        if (failure.screenshotPath) {
          await this.jira.addAttachment(failure.jiraTicket, failure.screenshotPath);
          console.log(`  📎 Screenshot attached`);
        }

        reported++;
      } catch (err) {
        console.error(`  ❌ Failed to report: ${err instanceof Error ? err.message : err}`);
        errored++;
      }
    }

    // Summary
    console.log('\n────────────────────────────────────────────────────────');
    console.log(`defect-bridge summary`);
    console.log(`  Reported : ${reported}`);
    if (skipped) console.log(`  Skipped  : ${skipped} (ticket not found)`);
    if (errored) console.log(`  Errors   : ${errored}`);
    console.log('────────────────────────────────────────────────────────\n');

    if (errored > 0) process.exit(1);
  }
}
