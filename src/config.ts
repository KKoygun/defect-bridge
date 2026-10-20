import { z } from 'zod';

/** Thrown for missing or invalid settings — the CLI exits with code 2 on it. */
export class ConfigError extends Error {}

/**
 * Zod-validated configuration.
 *
 * Either Jira or GitHub (or both) must be configured — the tool reports to
 * whichever destinations have credentials present. A dry run needs neither:
 * it only prints the comments it would post.
 *
 * Jira   → JIRA_BASE_URL + JIRA_EMAIL + JIRA_API_TOKEN
 * GitHub → GITHUB_TOKEN + GITHUB_REPO
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
          .regex(/^[^/]+\/[^/]+$/, 'GITHUB_REPO must be in owner/repo format (e.g. acme/my-repo)'),
      })
      .optional(),

    allure: z.object({
      resultsDir: z.string().min(1),
    }),

    run: z.object({
      env:    z.string().min(1),
      runId:  z.string().optional(),
      dryRun: z.boolean(),
    }),
  })
  .refine((data) => data.run.dryRun || data.jira !== undefined || data.github !== undefined, {
    message:
      'No reporter configured. Set JIRA_BASE_URL + JIRA_EMAIL + JIRA_API_TOKEN ' +
      'and/or GITHUB_TOKEN + GITHUB_REPO, or use --dry-run.',
  });

export type Config = z.infer<typeof ConfigSchema>;

export interface CliOptions {
  dryRun?: boolean;
  resultsDir?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cli: CliOptions = {}): Config {
  const raw = {
    jira: env.JIRA_BASE_URL
      ? {
          baseUrl:  env.JIRA_BASE_URL,
          email:    env.JIRA_EMAIL ?? '',
          apiToken: env.JIRA_API_TOKEN ?? '',
        }
      : undefined,

    github: env.GITHUB_TOKEN
      ? {
          token: env.GITHUB_TOKEN,
          repo:  env.GITHUB_REPO ?? '',
        }
      : undefined,

    allure: {
      resultsDir: cli.resultsDir ?? env.ALLURE_RESULTS_DIR ?? 'allure-results',
    },

    run: {
      env:    env.ENV ?? 'dev',
      runId:  env.CI_RUN_ID ?? env.GITHUB_RUN_NUMBER ?? undefined,
      dryRun: cli.dryRun ?? false,
    },
  };

  const result = ConfigSchema.safeParse(raw);

  if (!result.success) {
    const messages = result.error.issues
      .map((issue) => `  • ${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('\n');
    throw new ConfigError(`defect-bridge configuration error:\n${messages}`);
  }

  return result.data;
}
