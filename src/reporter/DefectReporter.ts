import * as fs from 'fs';
import { AllureResultsParser } from '../allure/AllureResultsParser';
import { JiraClient, JiraCloudClient, JiraDataCenterClient, previewComment } from '../jira/JiraClient';
import { GitHubClient } from '../github/GitHubClient';
import { GitHubCommentBuilder } from '../github/GitHubCommentBuilder';
import { ParsedFailure } from '../allure/types';
import { RetryOptions } from '../http/retry';
import { Config } from '../config';

export interface ReportSummary {
  reported: number;
  /** Already commented on by an earlier attempt of the same CI run. */
  duplicates: number;
  skipped: number;
  errored: number;
}

/**
 * DefectReporter — orchestrates the full reporting pipeline.
 *
 * For each failed scenario tagged with an issue key:
 *   1. Parse allure-results → find failures with @issue / @github_issue labels
 *   2. Report to Jira (if configured) — verify ticket, post ADF comment, attach screenshot
 *   3. Report to GitHub Issues (if configured) — verify issue, post Markdown comment
 *
 * Each comment carries a marker made of the CI run id and the test id. Before
 * posting, the ticket is checked for that marker, so re-running the same CI run
 * does not post the same comment twice.
 *
 * In a dry run nothing is called: the comment for every tagged failure is printed instead.
 */
export class DefectReporter {
  private readonly parser: AllureResultsParser;
  private readonly dryRun: boolean;

  // Jira
  private readonly jira?: JiraClient;

  // GitHub
  private readonly github?: GitHubClient;
  private readonly githubCommentBuilder = new GitHubCommentBuilder();

  constructor(private readonly config: Config, retry: RetryOptions = {}) {
    this.dryRun = config.run.dryRun;
    this.parser = new AllureResultsParser(config.allure.resultsDir);

    if (config.jira && !this.dryRun) {
      this.jira =
        config.jira.flavor === 'datacenter'
          ? new JiraDataCenterClient(config.jira.baseUrl, config.jira.pat, retry)
          : new JiraCloudClient(config.jira.baseUrl, config.jira.email, config.jira.apiToken, retry);
    }

    if (config.github && !this.dryRun) {
      this.github = new GitHubClient(config.github.token, config.github.repo, config.github.apiUrl, retry);
    }
  }

  async run(): Promise<ReportSummary> {
    const { config } = this;
    const dryTag = this.dryRun ? ' [DRY RUN]' : '';

    console.log(`\n── defect-bridge${dryTag} ────────────────────────────────`);
    console.log(`Allure results : ${config.allure.resultsDir}`);
    if (config.jira)   console.log(`Jira           : ${config.jira.baseUrl} (${config.jira.flavor})`);
    if (config.github) console.log(`GitHub         : ${config.github.repo}`);
    console.log(`Environment    : ${config.run.env}`);
    if (config.run.runId) console.log(`CI Run ID      : ${config.run.runId}`);
    else console.log('CI Run ID      : not set — duplicate check is off');
    if (this.dryRun) console.log('\nDry run — nothing is sent. Each comment is printed instead.');
    console.log('──────────────────────────────────────────────────────\n');

    const failures = this.parser.parse();
    const summary: ReportSummary = { reported: 0, duplicates: 0, skipped: 0, errored: 0 };

    if (failures.length === 0) {
      console.log('✅ No failures with @issue / @github_issue tags found. Nothing to report.');
      this.writeStepSummary(failures, summary);
      return summary;
    }

    for (const failure of failures) {
      const jiraLabel = failure.jiraTicket  ? `[${failure.jiraTicket}] `  : '';
      const ghLabel   = failure.githubIssue ? `[GH#${failure.githubIssue}] ` : '';
      console.log(`\n${jiraLabel}${ghLabel}${failure.scenarioName}`);

      const marker = this.markerFor(failure);

      if (this.dryRun) {
        this.preview(failure, marker, summary);
        continue;
      }

      // ── Jira ─────────────────────────────────────────────────────────────
      if (this.jira && failure.jiraTicket) {
        try {
          const issue = await this.jira.getIssue(failure.jiraTicket);
          if (!issue) {
            console.warn(`  ⚠️  Jira ticket not found: ${failure.jiraTicket} — skipping`);
            summary.skipped++;
          } else if (marker && (await this.jira.hasComment(failure.jiraTicket, marker))) {
            console.log(`  ↩️  ${issue.key} already has this run's comment — skipping`);
            summary.duplicates++;
          } else {
            console.log(`  Jira: ${issue.key} — ${issue.summary}`);

            await this.jira.addComment(failure.jiraTicket, failure, { env: config.run.env, runId: config.run.runId, marker });
            console.log(`  ✅ Jira comment posted`);

            if (failure.screenshotPath) {
              await this.jira.addAttachment(failure.jiraTicket, failure.screenshotPath);
              console.log(`  📎 Screenshot attached to Jira`);
            }

            summary.reported++;
          }
        } catch (err) {
          console.error(`  ❌ Jira error: ${err instanceof Error ? err.message : err}`);
          summary.errored++;
        }
      }

      // ── GitHub Issues ─────────────────────────────────────────────────────
      if (this.github && failure.githubIssue) {
        try {
          const issue = await this.github.getIssue(failure.githubIssue);
          if (!issue) {
            console.warn(`  ⚠️  GitHub Issue #${failure.githubIssue} not found in ${config.github!.repo} — skipping`);
            summary.skipped++;
          } else if (marker && (await this.github.hasComment(failure.githubIssue, marker))) {
            console.log(`  ↩️  #${issue.number} already has this run's comment — skipping`);
            summary.duplicates++;
          } else {
            console.log(`  GitHub: #${issue.number} — ${issue.title}`);

            const body = this.githubCommentBuilder.build(failure, config.run.env, config.run.runId, marker);
            await this.github.addComment(failure.githubIssue, body);
            console.log(`  ✅ GitHub comment posted`);

            summary.reported++;
          }
        } catch (err) {
          console.error(`  ❌ GitHub error: ${err instanceof Error ? err.message : err}`);
          summary.errored++;
        }
      }
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n──────────────────────────────────────────────────────');
    console.log(`defect-bridge summary${dryTag}`);
    console.log(`  ${this.dryRun ? 'Previewed' : 'Reported '} : ${summary.reported}`);
    if (summary.duplicates) console.log(`  Duplicates: ${summary.duplicates} (already posted for this run)`);
    if (summary.skipped)    console.log(`  Skipped   : ${summary.skipped} (issue not found)`);
    if (summary.errored)    console.log(`  Errors    : ${summary.errored}`);
    console.log('──────────────────────────────────────────────────────\n');

    this.writeStepSummary(failures, summary);
    return summary;
  }

  /** Without a run id there is nothing to tell two runs apart, so no marker. */
  private markerFor(failure: ParsedFailure): string | undefined {
    const { runId } = this.config.run;
    return runId ? `defect-bridge:run=${runId};test=${failure.testId ?? failure.uuid}` : undefined;
  }

  /** Prints the comment each destination would receive, whether or not it is configured. */
  private preview(failure: ParsedFailure, marker: string | undefined, summary: ReportSummary): void {
    const { env, runId } = this.config.run;

    if (failure.jiraTicket) {
      const text = previewComment(this.config.jiraFlavor, failure, { env, runId, marker });
      this.printBlock(`Jira comment for ${failure.jiraTicket}:`, text);
      if (failure.screenshotPath) console.log(`  [DRY RUN] Would attach ${failure.screenshotPath}`);
      summary.reported++;
    }

    if (failure.githubIssue) {
      const body = this.githubCommentBuilder.build(failure, env, runId, marker);
      this.printBlock(`GitHub comment for #${failure.githubIssue}:`, body);
      summary.reported++;
    }
  }

  private printBlock(title: string, text: string): void {
    console.log(`  [DRY RUN] ${title}`);
    for (const line of text.split('\n')) console.log(`    │ ${line}`);
  }

  // ── GitHub Actions Job Summary ────────────────────────────────────────────
  /**
   * Writes a Markdown summary table to $GITHUB_STEP_SUMMARY so the report is
   * visible directly on the Actions run page — no artifact download required.
   * No-op when running outside GitHub Actions.
   */
  private writeStepSummary(failures: ParsedFailure[], summary: ReportSummary): void {
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryPath) return;

    const dryTag = this.dryRun ? ' _(dry run)_' : '';
    const lines: string[] = [
      `## defect-bridge${dryTag}`,
      '',
      `**Environment:** \`${this.config.run.env}\`  `,
      `**Results dir:** \`${this.config.allure.resultsDir}\``,
      '',
    ];

    if (failures.length === 0) {
      lines.push('✅ No failures with issue tags found.');
    } else {
      lines.push('| Scenario | Jira | GitHub |');
      lines.push('|---|---|---|');

      for (const f of failures) {
        const jira = f.jiraTicket  ? `\`${f.jiraTicket}\`` : '—';
        const gh   = f.githubIssue ? `#${f.githubIssue}`   : '—';
        lines.push(`| ${f.scenarioName} | ${jira} | ${gh} |`);
      }

      lines.push('');
      lines.push(
        `**${this.dryRun ? 'Previewed' : 'Reported'}:** ${summary.reported} &nbsp; ` +
          `**Already posted:** ${summary.duplicates} &nbsp; **Skipped:** ${summary.skipped} &nbsp; **Errors:** ${summary.errored}`
      );
    }

    lines.push('');
    fs.appendFileSync(summaryPath, lines.join('\n'));
  }
}
