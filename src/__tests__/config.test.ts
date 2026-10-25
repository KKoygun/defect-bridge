import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../config';

const jiraEnv = {
  JIRA_BASE_URL: 'https://acme.atlassian.net',
  JIRA_EMAIL: 'qa@acme.com',
  JIRA_API_TOKEN: 'token',
};

describe('loadConfig', () => {
  it('needs at least one destination outside a dry run', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
  });

  it('allows a dry run without any credentials', () => {
    const config = loadConfig({}, { dryRun: true });
    expect(config.run.dryRun).toBe(true);
    expect(config.jira).toBeUndefined();
  });

  it('names the variable that is wrong', () => {
    expect(() => loadConfig({ ...jiraEnv, JIRA_EMAIL: 'not-an-email' })).toThrow('JIRA_EMAIL');
  });

  it('takes the results dir from the CLI over the environment', () => {
    const config = loadConfig({ ...jiraEnv, ALLURE_RESULTS_DIR: 'from-env' }, { resultsDir: 'from-cli' });
    expect(config.allure.resultsDir).toBe('from-cli');
  });

  it('picks the CI run id from CI_RUN_ID or GITHUB_RUN_NUMBER', () => {
    expect(loadConfig({ ...jiraEnv, GITHUB_RUN_NUMBER: '42' }).run.runId).toBe('42');
    expect(loadConfig({ ...jiraEnv, CI_RUN_ID: 'local-1', GITHUB_RUN_NUMBER: '42' }).run.runId).toBe('local-1');
  });
});

describe('Jira flavor', () => {
  it('defaults to Cloud', () => {
    expect(loadConfig(jiraEnv).jira).toMatchObject({ flavor: 'cloud', email: 'qa@acme.com' });
  });

  it('needs a personal access token for Data Center', () => {
    const dc = { JIRA_FLAVOR: 'datacenter', JIRA_BASE_URL: 'https://jira.bank.local' };
    expect(() => loadConfig(dc)).toThrow('JIRA_PAT');
    expect(loadConfig({ ...dc, JIRA_PAT: 'pat' }).jira).toMatchObject({ flavor: 'datacenter', pat: 'pat' });
  });

  it('rejects an unknown flavor', () => {
    expect(() => loadConfig({ ...jiraEnv, JIRA_FLAVOR: 'server' })).toThrow('JIRA_FLAVOR');
  });
});
