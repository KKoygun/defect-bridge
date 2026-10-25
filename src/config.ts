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
 * Jira Cloud       → JIRA_BASE_URL + JIRA_EMAIL + JIRA_API_TOKEN
 * Jira Data Center → JIRA_FLAVOR=datacenter + JIRA_BASE_URL + JIRA_PAT
 * GitHub           → GITHUB_TOKEN + GITHUB_REPO
 */
const jiraBaseUrl = z.string().url('JIRA_BASE_URL must be a valid URL (e.g. https://acme.atlassian.net)');

const ConfigSchema = z
  .object({
    jiraFlavor: z.enum(['cloud', 'datacenter'], { message: 'JIRA_FLAVOR must be "cloud" or "datacenter"' }),

    jira: z
      .discriminatedUnion('flavor', [
        z.object({
          flavor:   z.literal('cloud'),
          baseUrl:  jiraBaseUrl,
          email:    z.string().email('JIRA_EMAIL must be a valid email address'),
          apiToken: z.string().min(1, 'JIRA_API_TOKEN is required for Jira Cloud'),
        }),
        z.object({
          flavor:  z.literal('datacenter'),
          baseUrl: jiraBaseUrl,
          pat:     z.string().min(1, 'JIRA_PAT (personal access token) is required for Jira Data Center'),
        }),
      ])
      .optional(),

    github: z
      .object({
        token: z.string().min(1, 'GITHUB_TOKEN is required when GITHUB_REPO is set'),
        repo: z
          .string()
          .regex(/^[^/]+\/[^/]+$/, 'GITHUB_REPO must be in owner/repo format (e.g. acme/my-repo)'),
        apiUrl: z.string().url('GITHUB_API_URL must be a valid URL'),
      })
      .optional(),

    allure: z.object({
      resultsDir: z.string().min(1),
    }),

    // Optional status changes; without them defect-bridge only comments
    lifecycle: z.object({
      /** Transition (or target status) to use when a test fails on a ticket that is already done, e.g. "Reopen". */
      reopenTransition: z.string().optional(),
      /** Transition (or target status) to use when a test passes on an open ticket, e.g. "Ready for QA". */
      passTransition: z.string().optional(),
    }),

    run: z.object({
      env:    z.string().min(1),
      runId:  z.string().optional(),
      dryRun: z.boolean(),
      /** Exit 1 when a ticket could not be updated. Off by default so a Jira outage does not fail the build. */
      failOnReportError: z.boolean(),
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
  const jiraFlavor = (env.JIRA_FLAVOR || 'cloud').toLowerCase();

  const raw = {
    jiraFlavor,

    jira: !env.JIRA_BASE_URL
      ? undefined
      : jiraFlavor === 'datacenter'
        ? { flavor: jiraFlavor, baseUrl: env.JIRA_BASE_URL, pat: env.JIRA_PAT ?? '' }
        : { flavor: jiraFlavor, baseUrl: env.JIRA_BASE_URL, email: env.JIRA_EMAIL ?? '', apiToken: env.JIRA_API_TOKEN ?? '' },

    github: env.GITHUB_TOKEN
      ? {
          token:  env.GITHUB_TOKEN,
          repo:   env.GITHUB_REPO ?? '',
          // Set by GitHub Actions, so GitHub Enterprise Server works too
          apiUrl: env.GITHUB_API_URL ?? 'https://api.github.com',
        }
      : undefined,

    allure: {
      resultsDir: cli.resultsDir ?? env.ALLURE_RESULTS_DIR ?? 'allure-results',
    },

    lifecycle: {
      reopenTransition: env.JIRA_REOPEN_TRANSITION || undefined,
      passTransition: env.JIRA_PASS_TRANSITION || undefined,
    },

    run: {
      env:    env.ENV ?? 'dev',
      runId:  env.CI_RUN_ID ?? env.GITHUB_RUN_NUMBER ?? undefined,
      dryRun: cli.dryRun ?? false,
      failOnReportError: env.FAIL_ON_REPORT_ERROR === 'true',
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
