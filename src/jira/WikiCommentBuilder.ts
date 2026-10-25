import { ParsedFailure } from '../allure/types';

/**
 * WikiCommentBuilder — the same comment as CommentBuilder, in Jira wiki markup,
 * which is what Jira Data Center's REST API v2 expects.
 *
 * No emoji: older Data Center databases (MySQL without utf8mb4) reject them.
 * (x) is Jira's own red-cross icon.
 */
export class WikiCommentBuilder {
  build(failure: ParsedFailure, env: string, runId?: string, marker?: string, regressionOf?: string): string {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const lines = [
      regressionOf
        ? `h3. (!) Regression — ticket is ${regressionOf}, but the test fails again`
        : 'h3. (x) Automated Test is Failing',
      '----',
      `*Scenario:* ${failure.scenarioName}`,
      `*Feature:* ${failure.fullName ?? 'N/A'}`,
      `*Environment:* ${env}`,
      `*Duration:* ${failure.duration !== undefined ? `${failure.duration}s` : 'N/A'}`,
      `*Timestamp:* ${timestamp}`,
      ...(runId ? [`*CI Run:* ${runId}`] : []),
      '----',
      'h4. Error',
      '{code}',
      trim(failure.errorMessage, 800),
      '{code}',
      ...(failure.errorTrace ? ['h4. Stack Trace', '{code}', trim(failure.errorTrace, 1500), '{code}'] : []),
      '----',
      '_Screenshot attached to this comment if available._',
      // Lets a re-run of the same CI run find this comment and skip it
      ...(marker ? [`{{${marker}}}`] : []),
    ];
    return lines.join('\n');
  }

  /** Posted once when a test linked to an open ticket starts passing. (/) is Jira's green tick. */
  buildPassing(result: ParsedFailure, env: string, runId?: string, marker?: string): string {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    return [
      'h3. (/) Automated test is passing again',
      '----',
      `*Scenario:* ${result.scenarioName}`,
      `*Environment:* ${env}`,
      `*Timestamp:* ${timestamp}`,
      ...(runId ? [`*CI Run:* ${runId}`] : []),
      '----',
      'The test linked to this ticket passed. If nothing else is pending, the fix can be verified and the ticket closed.',
      ...(marker ? [`{{${marker}}}`] : []),
    ].join('\n');
  }
}

function trim(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : text.slice(0, maxLength) + '\n... (truncated)';
}
