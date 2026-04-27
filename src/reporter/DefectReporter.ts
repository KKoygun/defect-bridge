import { AllureResultsParser } from '../allure/AllureResultsParser';
import { JiraClient } from '../jira/JiraClient';
import { CommentBuilder } from '../jira/CommentBuilder';
import { GitHubClient } from '../github/GitHubClient';
import { GitHubCommentBuilder } from '../github/GitHubCommentBuilder';
import { config } from '../config';

export interface DefectReporterOptions {
  /** When true, log what would be posted without making any API calls. */
  dryRun?: boolean;
}

/**
 * DefectReporter — orchestrates the full reporting pipeline.
 *
 * For each failed scenario tagged with an issue key:
 *   1. Parse allure-results → find failures with @issue / @github_issue labels
 *   2. Report to Jira (if configured) — verify ticket, post ADF comment, attach screenshot
 *   3. Report to GitHub Issues (if configured) — verify issue, post Markdown comment
 *
 * Pass { dryRun: true } to preview what would be posted without any API calls.
 */
export class DefectReporter {
  private readonly parser: AllureResultsParser;
  private readonly dryRun: boolean;

  // Jira
  private readonly jira?: JiraClient;
  private readonly commentBuilder: CommentBuilder;

  // GitHub
  private readonly github?: GitHubClient;
  private readonly githubCommentBuilder: GitHubCommentBuilder;

  constructor(options: DefectReporterOptions = {}) {
    this.dryRun = options.dryRun ?? false;
    this.parser = new AllureResultsParser(config.allure.resultsDir);
    this.commentBuilder = new CommentBuilder();
    this.githubCommentBuilder = new GitHubCommentBuilder();

    if (config.jira) {
      this.jira = new JiraClient(
        config.jira.baseUrl,
        config.jira.email,
        config.jira.apiToken
      );
    }

    if (config.github) {
      this.github = new GitHubClient(config.github.token, config.github.repo);
    }
  }

  async run(): Promise<void> {
    const dryTag = this.dryRun ? ' [DRY RUN]' : '';

    console.log(`\n── defect-bridge${dryTag} ────────────────────────────────`);
    console.log(`Allure results : ${config.allure.resultsDir}`);
    if (config.jira)   console.log(`Jira           : ${config.jira.baseUrl}`);
    if (config.github) console.log(`GitHub         : github.com/${config.github.repo}`);
    console.log(`Environment    : ${config.run.env}`);
    if (config.run.runId) console.log(`CI Run ID      : ${config.run.runId}`);
    if (this.dryRun) console.log('\n⚠️  Dry-run mode — no API calls will be made.');
    console.log('──────────────────────────────────────────────────────\n');

    const failures = this.parser.parse();

    if (failures.length === 0) {
      console.log('✅ No failures with @issue / @github_issue tags found. Nothing to report.');
      return;
    }

    let reported = 0;
    let skipped  = 0;
    let errored  = 0;

    for (const failure of failures) {
      const jiraLabel  = failure.jiraTicket  ? `[${failure.jiraTicket}] `  : '';
      const ghLabel    = failure.githubIssue ? `[GH#${failure.githubIssue}] ` : '';
      console.log(`\n${jiraLabel}${ghLabel}${failure.scenarioName}`);

      // ── Jira ─────────────────────────────────────────────────────────────
      if (this.jira && failure.jiraTicket) {
        if (this.dryRun) {
          console.log(`  [DRY RUN] Would post ADF comment to Jira: ${failure.jiraTicket}`);
          if (failure.screenshotPath) {
            console.log(`  [DRY RUN] Would attach screenshot: ${failure.screenshotPath}`);
          }
          reported++;
        } else {
          try {
            const issue = await this.jira.getIssue(failure.jiraTicket);
            if (!issue) {
              console.warn(`  ⚠️  Jira ticket not found: ${failure.jiraTicket} — skipping`);
              skipped++;
            } else {
              console.log(`  Jira: ${issue.key} — ${issue.summary}`);

              const commentBody = this.commentBuilder.build(
                failure,
                config.run.env,
                config.run.runId
              );
              await this.jira.addComment(failure.jiraTicket, commentBody);
              console.log(`  ✅ Jira comment posted`);

              if (failure.screenshotPath) {
                await this.jira.addAttachment(failure.jiraTicket, failure.screenshotPath);
                console.log(`  📎 Screenshot attached to Jira`);
              }

              reported++;
            }
          } catch (err) {
            console.error(
              `  ❌ Jira error: ${err instanceof Error ? err.message : err}`
            );
            errored++;
          }
        }
      }

      // ── GitHub Issues ─────────────────────────────────────────────────────
      if (this.github && failure.githubIssue) {
        if (this.dryRun) {
          console.log(
            `  [DRY RUN] Would post Markdown comment to GitHub Issue #${failure.githubIssue}`
          );
          reported++;
        } else {
          try {
            const issue = await this.github.getIssue(failure.githubIssue);
            if (!issue) {
              console.warn(
                `  ⚠️  GitHub Issue #${failure.githubIssue} not found in ${config.github!.repo} — skipping`
              );
              skipped++;
            } else {
              console.log(`  GitHub: #${issue.number} — ${issue.title}`);

              const body = this.githubCommentBuilder.build(
                failure,
                config.run.env,
                config.run.runId
              );
              await this.github.addComment(failure.githubIssue, body);
              console.log(`  ✅ GitHub comment posted`);

              reported++;
            }
          } catch (err) {
            console.error(
              `  ❌ GitHub error: ${err instanceof Error ? err.message : err}`
            );
            errored++;
          }
        }
      }
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n──────────────────────────────────────────────────────');
    console.log(`defect-bridge summary${dryTag}`);
    console.log(`  Reported : ${reported}`);
    if (skipped) console.log(`  Skipped  : ${skipped} (issue not found)`);
    if (errored) console.log(`  Errors   : ${errored}`);
    console.log('──────────────────────────────────────────────────────\n');

    if (errored > 0) process.exit(1);
  }
}
