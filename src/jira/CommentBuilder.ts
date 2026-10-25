import { ParsedFailure } from '../allure/types';

/**
 * CommentBuilder — builds Jira comments in Atlassian Document Format (ADF).
 *
 * Jira Cloud REST API v3 requires ADF for comment bodies — plain text or
 * markdown are not accepted. ADF is a JSON tree of typed nodes.
 *
 * https://developer.atlassian.com/cloud/jira/platform/apis/document/structure/
 */
export class CommentBuilder {
  /** regressionOf: the ticket's status when it is already Done, e.g. "Done" or "Closed". */
  build(failure: ParsedFailure, env: string, runId?: string, marker?: string, regressionOf?: string): object {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const durationText = failure.duration !== undefined ? `${failure.duration}s` : 'N/A';
    const title = regressionOf
      ? `🔁 Regression — ticket is ${regressionOf}, but the test fails again`
      : '🔴 Automated Test is Failing';

    return {
      body: {
        version: 1,
        type: 'doc',
        content: [
          this.heading(title),
          this.divider(),
          this.infoTable(failure, timestamp, env, durationText, runId),
          this.divider(),
          this.heading('Error', 3),
          this.codeBlock(this.trimTrace(failure.errorMessage)),
          ...(failure.errorTrace
            ? [this.heading('Stack Trace', 3), this.codeBlock(this.trimTrace(failure.errorTrace, 1500))]
            : []),
          this.divider(),
          this.note('Screenshot attached to this comment if available.'),
          // Lets a re-run of the same CI run find this comment and skip it
          ...(marker ? [this.marker(marker)] : []),
        ],
      },
    };
  }

  /** Posted once when a test linked to an open ticket starts passing. */
  buildPassing(result: ParsedFailure, env: string, runId?: string, marker?: string): object {
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
    const durationText = result.duration !== undefined ? `${result.duration}s` : 'N/A';

    return {
      body: {
        version: 1,
        type: 'doc',
        content: [
          this.heading('🟢 Automated test is passing again'),
          this.divider(),
          this.infoTable(result, timestamp, env, durationText, runId),
          this.divider(),
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'The test linked to this ticket passed. If nothing else is pending, the fix can be verified and the ticket closed.' }],
          },
          ...(marker ? [this.marker(marker)] : []),
        ],
      },
    };
  }

  // ── ADF node builders ────────────────────────────────────────────────────

  private heading(text: string, level = 2): object {
    return {
      type: 'heading',
      attrs: { level },
      content: [{ type: 'text', text }],
    };
  }

  private divider(): object {
    return { type: 'rule' };
  }

  private infoTable(
    failure: ParsedFailure,
    timestamp: string,
    env: string,
    duration: string,
    runId?: string
  ): object {
    const rows = [
      ['Scenario', failure.scenarioName],
      ['Feature', failure.fullName ?? 'N/A'],
      ['Environment', env],
      ['Duration', duration],
      ['Timestamp', timestamp],
      ...(runId ? [['CI Run', runId]] : []),
    ];

    return {
      type: 'table',
      attrs: { isNumberColumnEnabled: false, layout: 'default' },
      content: rows.map(([key, value]) => ({
        type: 'tableRow',
        content: [
          {
            type: 'tableCell',
            attrs: {},
            content: [
              {
                type: 'paragraph',
                content: [{ type: 'text', text: key, marks: [{ type: 'strong' }] }],
              },
            ],
          },
          {
            type: 'tableCell',
            attrs: {},
            content: [{ type: 'paragraph', content: [{ type: 'text', text: value }] }],
          },
        ],
      })),
    };
  }

  private codeBlock(text: string): object {
    return {
      type: 'codeBlock',
      attrs: {},
      content: [{ type: 'text', text }],
    };
  }

  private note(text: string): object {
    return {
      type: 'paragraph',
      content: [
        { type: 'text', text: '📎 ', },
        { type: 'text', text, marks: [{ type: 'em' }] },
      ],
    };
  }

  private marker(text: string): object {
    return {
      type: 'paragraph',
      content: [{ type: 'text', text, marks: [{ type: 'code' }] }],
    };
  }

  private trimTrace(text: string, maxLength = 800): string {
    if (text.length <= maxLength) return text;
    return text.slice(0, maxLength) + '\n... (truncated)';
  }
}
