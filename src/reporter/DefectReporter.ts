import * as fs from 'fs';
import { AllureResultsParser } from '../allure/AllureResultsParser';
import {
  JiraClient,
  JiraCloudClient,
  JiraDataCenterClient,
  JiraIssue,
  previewComment,
  previewPassingComment,
} from '../jira/JiraClient';
import { GitHubClient, GitHubIssue } from '../github/GitHubClient';
import { GitHubCommentBuilder } from '../github/GitHubCommentBuilder';
import { labelFailure, writeCategories } from '../allure/AllureCategories';
import { ParsedResult } from '../allure/types';
import { RetryOptions } from '../http/retry';
import { Config } from '../config';

export interface ReportSummary {
  /** Failure comments posted on open tickets. */
  reported: number;
  /** Failures on tickets that were already done. */
  regressions: number;
  /** "Passing again" comments posted on open tickets. */
  passing: number;
  /** Already reported by an earlier attempt of the same CI run. */
  duplicates: number;
  skipped: number;
  errored: number;
}

/** What happened to one tagged result; the CI summary is built from these. */
export interface Outcome {
  result: ParsedResult;
  jiraIssue?: JiraIssue;
  githubIssue?: GitHubIssue;
  action: string;
}

/**
 * DefectReporter — keeps tagged tests and their tickets in step.
 *
 * For each test tagged with a ticket (@allure.label.issue / github_issue):
 *   Jira, by the ticket's status category:
 *     test fails,  ticket open → failure comment (+ screenshot)
 *     test fails,  ticket done → regression comment, optionally JIRA_REOPEN_TRANSITION
 *     test passes, ticket open → one "passing again" comment, optionally JIRA_PASS_TRANSITION
 *     test passes, ticket done → nothing to do
 *   GitHub Issues: failure comment, as before.
 *
 * Comments carry a marker (CI run id + test id), so re-running the same CI run
 * does not post twice. Afterwards tagged failures are labelled for the Allure
 * report's Categories tab. In a dry run nothing is called or written; the
 * comments are printed.
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

    const results = this.parser.parse();
    const summary: ReportSummary = { reported: 0, regressions: 0, passing: 0, duplicates: 0, skipped: 0, errored: 0 };
    const outcomes: Outcome[] = [];

    if (results.length === 0) {
      console.log('✅ No tests with @issue / @github_issue tags found. Nothing to report.');
      this.writeAllureCategories(outcomes);
      this.writeStepSummary(outcomes, summary);
      return summary;
    }

    for (const result of results) {
      const jiraLabel = result.jiraTicket  ? `[${result.jiraTicket}] `  : '';
      const ghLabel   = result.githubIssue ? `[GH#${result.githubIssue}] ` : '';
      console.log(`\n${jiraLabel}${ghLabel}${result.scenarioName} — ${result.status}`);

      if (this.dryRun) {
        this.preview(result, summary);
        outcomes.push({ result, action: 'preview' });
        continue;
      }

      const outcome: Outcome = { result, action: 'none' };

      if (this.jira && result.jiraTicket) {
        await this.reportToJira(this.jira, result, outcome, summary);
      }

      // GitHub Issues only gets failure comments
      if (this.github && result.githubIssue && result.status !== 'passed') {
        await this.reportToGitHub(this.github, result, outcome, summary);
      }

      outcomes.push(outcome);
    }

    // ── Summary ───────────────────────────────────────────────────────────────
    console.log('\n──────────────────────────────────────────────────────');
    console.log(`defect-bridge summary${dryTag}`);
    console.log(`  ${this.dryRun ? 'Previewed' : 'Reported '} : ${summary.reported}`);
    if (summary.regressions) console.log(`  Regressions: ${summary.regressions} (ticket was done)`);
    if (summary.passing)     console.log(`  Passing   : ${summary.passing} (ticket still open)`);
    if (summary.duplicates)  console.log(`  Duplicates: ${summary.duplicates} (already posted)`);
    if (summary.skipped)     console.log(`  Skipped   : ${summary.skipped} (issue not found)`);
    if (summary.errored)     console.log(`  Errors    : ${summary.errored}`);
    console.log('──────────────────────────────────────────────────────\n');

    this.writeAllureCategories(outcomes);
    this.writeStepSummary(outcomes, summary);
    return summary;
  }

  /** Decides what to do from the test result and the ticket's status category. */
  private async reportToJira(jira: JiraClient, result: ParsedResult, outcome: Outcome, summary: ReportSummary): Promise<void> {
    const key = result.jiraTicket!;
    const { env, runId } = this.config.run;

    try {
      const issue = await jira.getIssue(key);
      if (!issue) {
        console.warn(`  ⚠️  Jira ticket not found: ${key} — skipping`);
        outcome.action = 'ticket not found';
        summary.skipped++;
        return;
      }
      outcome.jiraIssue = issue;
      console.log(`  Jira: ${issue.key} — ${issue.summary} [${issue.status}]`);
      const done = issue.statusCategory === 'done';

      if (result.status === 'passed') {
        if (done) {
          console.log('  ✔️  Test passes and the ticket is done — nothing to do');
          outcome.action = 'none';
          return;
        }
        // One "passing again" comment per test, until it fails again
        if ((await jira.lastReportedState(key, testIdOf(result))) === 'passing') {
          console.log('  ↩️  Already reported as passing — skipping');
          outcome.action = 'already reported passing';
          summary.duplicates++;
          return;
        }
        await jira.addPassingComment(key, result, { env, runId, marker: this.passingMarkerFor(result) });
        console.log('  🟢 Passing comment posted');
        outcome.action = 'passing comment';
        summary.passing++;
        await this.applyTransition(jira, key, this.config.lifecycle.passTransition, outcome);
        return;
      }

      const marker = this.markerFor(result);
      if (marker && (await jira.hasComment(key, marker))) {
        console.log(`  ↩️  ${issue.key} already has this run's comment — skipping`);
        outcome.action = 'already reported';
        summary.duplicates++;
        return;
      }

      await jira.addComment(key, result, { env, runId, marker, regressionOf: done ? issue.status : undefined });
      if (done) {
        console.log(`  🔁 Regression comment posted (ticket is ${issue.status})`);
        outcome.action = 'regression comment';
        summary.regressions++;
      } else {
        console.log('  ✅ Jira comment posted');
        outcome.action = 'failure comment';
        summary.reported++;
      }

      if (result.screenshotPath) {
        await jira.addAttachment(key, result.screenshotPath);
        console.log('  📎 Screenshot attached to Jira');
      }

      if (done) await this.applyTransition(jira, key, this.config.lifecycle.reopenTransition, outcome);
    } catch (err) {
      console.error(`  ❌ Jira error: ${err instanceof Error ? err.message : err}`);
      outcome.action = 'error';
      summary.errored++;
    }
  }

  /** Optional status change; a workflow without that transition is not an error. */
  private async applyTransition(jira: JiraClient, key: string, name: string | undefined, outcome: Outcome): Promise<void> {
    if (!name) return;
    const status = await jira.transition(key, name);
    if (status) {
      console.log(`  ➡️  Moved to ${status}`);
      outcome.action += `, moved to ${status}`;
    } else {
      console.warn(`  ⚠️  No "${name}" transition available on ${key} — status left as is`);
    }
  }

  private async reportToGitHub(github: GitHubClient, result: ParsedResult, outcome: Outcome, summary: ReportSummary): Promise<void> {
    const { config } = this;
    const marker = this.markerFor(result);
    try {
      const issue = await github.getIssue(result.githubIssue!);
      if (issue) outcome.githubIssue = issue;
      if (!issue) {
        console.warn(`  ⚠️  GitHub Issue #${result.githubIssue} not found in ${config.github!.repo} — skipping`);
        summary.skipped++;
      } else if (marker && (await github.hasComment(result.githubIssue!, marker))) {
        console.log(`  ↩️  #${issue.number} already has this run's comment — skipping`);
        summary.duplicates++;
      } else {
        console.log(`  GitHub: #${issue.number} — ${issue.title}`);
        const body = this.githubCommentBuilder.build(result, config.run.env, config.run.runId, marker);
        await github.addComment(result.githubIssue!, body);
        console.log('  ✅ GitHub comment posted');
        summary.reported++;
      }
    } catch (err) {
      console.error(`  ❌ GitHub error: ${err instanceof Error ? err.message : err}`);
      summary.errored++;
    }
  }

  /**
   * Labels each tagged failure as a known defect or a regression, using the
   * ticket status read above (Jira first, then GitHub). When neither could be
   * read the tag still says a defect is linked, so it is a known defect without
   * a status. Untagged failures are left alone and fall under "New failure".
   */
  private writeAllureCategories(outcomes: Outcome[]): void {
    if (this.dryRun || !this.config.allure.categories) return;

    try {
      writeCategories(this.config.allure.resultsDir);
      for (const { result, jiraIssue, githubIssue } of outcomes) {
        if (result.status === 'passed') continue;
        if (jiraIssue) {
          labelFailure(result.file, jiraIssue.statusCategory === 'done' ? 'regression' : 'known', jiraIssue.key, jiraIssue.status);
        } else if (githubIssue) {
          labelFailure(result.file, githubIssue.state === 'closed' ? 'regression' : 'known', `#${githubIssue.number}`, githubIssue.state);
        } else {
          labelFailure(result.file, 'known', result.jiraTicket ?? `#${result.githubIssue}`);
        }
      }
      console.log('🗂️  Allure categories written (known defect / regression / new failure)');
    } catch (err) {
      console.warn(`⚠️  Could not write Allure categories: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Without a run id there is nothing to tell two runs apart, so no marker. */
  private markerFor(result: ParsedResult): string | undefined {
    const { runId } = this.config.run;
    return runId ? `defect-bridge:run=${runId};test=${testIdOf(result)}` : undefined;
  }

  /** Always set: it is how the next run knows this test was already reported as passing. */
  private passingMarkerFor(result: ParsedResult): string {
    const { runId } = this.config.run;
    return `defect-bridge:passing;${runId ? `run=${runId};` : ''}test=${testIdOf(result)}`;
  }

  /**
   * Prints the comment each destination would receive. Without Jira access the
   * ticket status is unknown, so a passing test shows the comment it would get
   * if its ticket were still open.
   */
  private preview(result: ParsedResult, summary: ReportSummary): void {
    const { env, runId } = this.config.run;

    if (result.jiraTicket) {
      if (result.status === 'passed') {
        const text = previewPassingComment(this.config.jiraFlavor, result, { env, runId, marker: this.passingMarkerFor(result) });
        this.printBlock(`Jira comment for ${result.jiraTicket} (only if the ticket is still open):`, text);
        summary.passing++;
      } else {
        const text = previewComment(this.config.jiraFlavor, result, { env, runId, marker: this.markerFor(result) });
        this.printBlock(`Jira comment for ${result.jiraTicket}:`, text);
        if (result.screenshotPath) console.log(`  [DRY RUN] Would attach ${result.screenshotPath}`);
        summary.reported++;
      }
    }

    if (result.githubIssue && result.status !== 'passed') {
      const body = this.githubCommentBuilder.build(result, env, runId, this.markerFor(result));
      this.printBlock(`GitHub comment for #${result.githubIssue}:`, body);
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
  private writeStepSummary(outcomes: Outcome[], summary: ReportSummary): void {
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

    if (outcomes.length === 0) {
      lines.push('✅ No tests with issue tags found.');
    } else {
      lines.push('| Scenario | Test | Jira | GitHub |');
      lines.push('|---|---|---|---|');

      for (const { result } of outcomes) {
        const jira = result.jiraTicket  ? `\`${result.jiraTicket}\`` : '—';
        const gh   = result.githubIssue ? `#${result.githubIssue}`   : '—';
        lines.push(`| ${result.scenarioName} | ${result.status} | ${jira} | ${gh} |`);
      }

      lines.push('');
      lines.push(
        `**${this.dryRun ? 'Previewed' : 'Reported'}:** ${summary.reported} &nbsp; **Regressions:** ${summary.regressions} &nbsp; ` +
          `**Passing again:** ${summary.passing} &nbsp; **Already posted:** ${summary.duplicates} &nbsp; ` +
          `**Skipped:** ${summary.skipped} &nbsp; **Errors:** ${summary.errored}`
      );
    }

    lines.push('');
    fs.appendFileSync(summaryPath, lines.join('\n'));
  }
}

function testIdOf(result: ParsedResult): string {
  return result.testId ?? result.uuid;
}
