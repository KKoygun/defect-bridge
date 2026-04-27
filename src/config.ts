import * as dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

// ── Schema ────────────────────────────────────────────────────────────────────

/**
 * Zod-validated configuration schema.
 *
 * Either Jira or GitHub (or both) must be configured — the tool will report to
 * whichever destinations have credentials present.
 *
 * Jira  → set JIRA_BASE_URL + JIRA_EMAIL + JIRA_API_TOKEN
 * GitHub → set GITHUB_TOKEN + GITHUB_REPO
 */
const ConfigSchema = z
  .object({
    jira: z
      .object({
        baseUrl:  z.string().url('JIRA_BASE_URL must be a valid URL (e.g. https://acme.atlassian.net)'),
        email:    z.string().email('JIRA_EMAIL must be a valid email address'),
        apiToken: z.string().min(1, 'JIRA_API_TOKEN is required when JIRA_BASE_URL is set'),
      })
      .optional(),

    github: z
      .object({
        token: z.string().min(1, 'GITHUB_TOKEN is required when GITHUB_REPO is set'),
        repo: z
          .string()
          .regex(
            /^[^/]+\/[^/]+$/,
            'GITHUB_REPO must be in owner/repo format (e.g. acme/my-repo)'
          ),
      })
      .optional(),

    allure: z.object({
      resultsDir: z.string().default('allure-results'),
    }),

    run: z.object({
      env:   z.string().default('dev'),
      runId: z.string().optional(),
    }),
  })
  .refine(
    (data) => data.jira !== undefined || data.github !== undefined,
    {
      message:
        'No reporter configured. Set JIRA_BASE_URL + JIRA_EMAIL + JIRA_API_TOKEN ' +
        'and/or GITHUB_TOKEN + GITHUB_REPO.',
    }
  );

export type Config = z.infer<typeof ConfigSchema>;

// ── Parse & validate ──────────────────────────────────────────────────────────

const raw = {
  jira: process.env.JIRA_BASE_URL
    ? {
        baseUrl:  process.env.JIRA_BASE_URL,
        email:    process.env.JIRA_EMAIL    ?? '',
        apiToken: process.env.JIRA_API_TOKEN ?? '',
      }
    : undefined,

  github: process.env.GITHUB_TOKEN
    ? {
        token: process.env.GITHUB_TOKEN,
        repo:  process.env.GITHUB_REPO ?? '',
      }
    : undefined,

  allure: {
    resultsDir: process.env.ALLURE_RESULTS_DIR ?? 'allure-results',
  },

  run: {
    env:   process.env.ENV ?? 'dev',
    runId: process.env.CI_RUN_ID ?? process.env.GITHUB_RUN_NUMBER ?? undefined,
  },
};

const result = ConfigSchema.safeParse(raw);

if (!result.success) {
  const messages = result.error.issues
    .map((issue) => `  • ${issue.path.join('.') || 'config'}: ${issue.message}`)
    .join('\n');
  throw new Error(`\ndefect-bridge configuration error:\n${messages}\n`);
}

export const config = result.data;
