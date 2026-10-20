import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { DefectReporter } from '../reporter/DefectReporter';
import { RecordedRequest, Reply, startFakeServer } from './fakeServer';

const EXAMPLES = 'examples/allure-results';

let server: Awaited<ReturnType<typeof startFakeServer>> | undefined;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('GITHUB_STEP_SUMMARY', '');
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await server?.close();
  server = undefined;
});

/** One fake server for both APIs: Jira under /rest, GitHub under /repos. Comments are kept in memory. */
async function startFakeTrackers() {
  const jiraComments: unknown[] = [];
  const githubComments: string[] = [];

  server = await startFakeServer((req: RecordedRequest): Reply => {
    const url = req.url.split('?')[0];
    if (url === '/rest/api/3/issue/DEFECT-123') return { status: 200, body: { key: 'DEFECT-123', fields: { summary: 'Add todo broken' } } };
    if (url === '/rest/api/3/issue/DEFECT-123/comment' && req.method === 'GET') {
      return { status: 200, body: { comments: jiraComments.map((body) => ({ body })) } };
    }
    if (url === '/rest/api/3/issue/DEFECT-123/comment') {
      jiraComments.push(JSON.parse(req.body).body);
      return { status: 201, body: { id: String(jiraComments.length) } };
    }
    if (url === '/rest/api/3/issue/DEFECT-123/attachments') return { status: 200, body: [] };
    if (url === '/repos/acme/app/issues/7') return { status: 200, body: { number: 7, title: 'Clear completed' } };
    if (url === '/repos/acme/app/issues/7/comments' && req.method === 'GET') {
      return { status: 200, body: githubComments.map((body) => ({ body })) };
    }
    if (url === '/repos/acme/app/issues/7/comments') {
      githubComments.push(JSON.parse(req.body).body);
      return { status: 201, body: { id: githubComments.length } };
    }
    return { status: 404, body: {} };
  });

  return { jiraComments, githubComments };
}

function configFor(runId?: string) {
  return loadConfig(
    {
      JIRA_BASE_URL: server!.url,
      JIRA_EMAIL: 'qa@example.com',
      JIRA_API_TOKEN: 'token',
      GITHUB_TOKEN: 'ghp_test',
      GITHUB_REPO: 'acme/app',
      GITHUB_API_URL: server!.url,
      ...(runId ? { CI_RUN_ID: runId } : {}),
    },
    { resultsDir: EXAMPLES }
  );
}

describe('DefectReporter', () => {
  it('posts each tagged failure once per CI run', async () => {
    const { jiraComments, githubComments } = await startFakeTrackers();

    const first = await new DefectReporter(configFor('147')).run();
    const second = await new DefectReporter(configFor('147')).run();

    expect(first).toMatchObject({ reported: 2, duplicates: 0, errored: 0 });
    expect(second).toMatchObject({ reported: 0, duplicates: 2, errored: 0 });
    expect(jiraComments).toHaveLength(1);
    expect(githubComments).toHaveLength(1);
    expect(JSON.stringify(jiraComments[0])).toContain('defect-bridge:run=147;test=c1a8e2f7a9b14d3e');
    expect(githubComments[0]).toContain('<!-- defect-bridge:run=147;test=5e93b0c4d2a7f611 -->');
  });

  it('posts again for a different CI run', async () => {
    const { jiraComments } = await startFakeTrackers();

    await new DefectReporter(configFor('147')).run();
    await new DefectReporter(configFor('148')).run();

    expect(jiraComments).toHaveLength(2);
  });

  it('skips the duplicate check without a run id', async () => {
    await startFakeTrackers();

    await new DefectReporter(configFor()).run();

    const lookups = server!.requests.filter((r) => r.method === 'GET' && r.url.includes('comment'));
    expect(lookups).toHaveLength(0);
  });

  it('counts a failed update as an error and keeps going', async () => {
    server = await startFakeServer((req): Reply =>
      req.url.startsWith('/rest') ? { status: 401, body: {} } : { status: 404, body: {} }
    );

    const summary = await new DefectReporter(configFor('147'), { attempts: 1 }).run();

    expect(summary).toMatchObject({ errored: 1, skipped: 1 });
  });

  it('sends nothing in a dry run', async () => {
    await startFakeTrackers();

    const summary = await new DefectReporter({ ...configFor('147'), run: { ...configFor('147').run, dryRun: true } }).run();

    expect(summary.reported).toBe(2);
    expect(server!.requests).toHaveLength(0);
  });
});
