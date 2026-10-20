import { spawn } from 'child_process';
import { describe, expect, it } from 'vitest';
import { Reply, startFakeServer } from './fakeServer';

/**
 * Runs scripts/run.ts as a real process to check exit codes. Credentials are
 * blanked explicitly so a local .env can never be picked up (dotenv does not
 * override variables that are already set, even to an empty string).
 */
function runCli(args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-r', 'ts-node/register', 'scripts/run.ts', ...args], {
      env: {
        ...process.env,
        JIRA_BASE_URL: '',
        JIRA_EMAIL: '',
        JIRA_API_TOKEN: '',
        GITHUB_TOKEN: '',
        GITHUB_REPO: '',
        CI_RUN_ID: '',
        GITHUB_RUN_NUMBER: '',
        FAIL_ON_REPORT_ERROR: '',
        GITHUB_STEP_SUMMARY: '',
        ...env,
      },
    });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => resolve({ code, output }));
  });
}

describe('exit codes', { timeout: 30_000 }, () => {
  it('0 for a dry run of the example results', async () => {
    const { code, output } = await runCli(['--dry-run', '--results-dir=examples/allure-results']);
    expect(code).toBe(0);
    expect(output).toContain('Previewed : 2');
  });

  it('2 for a configuration error', async () => {
    const { code, output } = await runCli(['--results-dir=examples/allure-results']);
    expect(code).toBe(2);
    expect(output).toContain('No reporter configured');
  });

  it('2 when the results directory does not exist', async () => {
    const { code } = await runCli(['--dry-run', '--results-dir=does-not-exist']);
    expect(code).toBe(2);
  });

  it('0 when a ticket update fails, 1 with FAIL_ON_REPORT_ERROR=true', async () => {
    const server = await startFakeServer((): Reply => ({ status: 403, body: {} }));
    const jira = { JIRA_BASE_URL: server.url, JIRA_EMAIL: 'qa@example.com', JIRA_API_TOKEN: 'token' };
    try {
      expect((await runCli(['--results-dir=examples/allure-results'], jira)).code).toBe(0);
      expect((await runCli(['--results-dir=examples/allure-results'], { ...jira, FAIL_ON_REPORT_ERROR: 'true' })).code).toBe(1);
    } finally {
      await server.close();
    }
  });
});
