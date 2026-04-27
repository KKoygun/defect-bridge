import { ParsedFailure } from '../allure/types';

/**
 * GitHubCommentBuilder — builds Markdown-formatted failure comments for GitHub Issues.
 *
 * GitHub Issues render standard Markdown, so the output is a plain string
 * (unlike Jira's ADF JSON).  Stack traces are collapsed inside a <details>
 * block to keep the comment scannable.
 */
export class GitHubCommentBuilder {
  build(failure: ParsedFailure, env: string, runId?: string): string {
    const lines: string[] = [];

    lines.push('## 🔴 Automated Test Failure');
    lines.push('');

    // ── Info table ───────────────────────────────────────────────────────────
    lines.push('| Field | Value |');
    lines.push('|---|---|');
    lines.push(`| **Scenario** | ${escapeCell(failure.scenarioName)} |`);

    if (failure.fullName && failure.fullName !== failure.scenarioName) {
      lines.push(`| **Feature** | ${escapeCell(failure.fullName)} |`);
    }

    lines.push(`| **Environment** | \`${env}\` |`);

    if (failure.duration !== undefined) {
      lines.push(`| **Duration** | ${failure.duration}s |`);
    }

    lines.push(`| **Timestamp** | ${new Date().toISOString()} |`);

    if (runId) {
      lines.push(`| **CI Run** | \`${runId}\` |`);
    }

    // ── Error ────────────────────────────────────────────────────────────────
    lines.push('');
    lines.push('### Error');
    lines.push('');
    lines.push('```');

    const msg = failure.errorMessage;
    lines.push(msg.length > 800 ? `${msg.slice(0, 800)}\n… (truncated)` : msg);
    lines.push('```');

    // ── Stack trace (collapsible) ────────────────────────────────────────────
    if (failure.errorTrace) {
      lines.push('');
      lines.push('<details>');
      lines.push('<summary>Stack Trace</summary>');
      lines.push('');
      lines.push('```');
      const trace = failure.errorTrace;
      lines.push(trace.length > 1500 ? `${trace.slice(0, 1500)}\n… (truncated)` : trace);
      lines.push('```');
      lines.push('</details>');
    }

    // ── Footer ───────────────────────────────────────────────────────────────
    lines.push('');
    lines.push('---');
    lines.push('_Posted automatically by **defect-bridge**_');

    return lines.join('\n');
  }
}

/** Escape pipe characters so they don't break the Markdown table. */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|');
}
