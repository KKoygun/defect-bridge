import * as dotenv from 'dotenv';
dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

export const config = {
  jira: {
    baseUrl:  required('JIRA_BASE_URL'),   // e.g. https://yourworkspace.atlassian.net
    email:    required('JIRA_EMAIL'),
    apiToken: required('JIRA_API_TOKEN'),
  },
  allure: {
    resultsDir: process.env.ALLURE_RESULTS_DIR ?? 'allure-results',
  },
  run: {
    env:   process.env.ENV   ?? 'dev',
    runId: process.env.CI_RUN_ID ?? process.env.GITHUB_RUN_NUMBER ?? undefined,
  },
};
