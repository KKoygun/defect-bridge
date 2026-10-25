import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config';
import { DefectReporter } from '../reporter/DefectReporter';
import { RecordedRequest, Reply, startFakeServer } from './fakeServer';

// examples/allure-results: DEFECT-123 fails, DEFECT-118 passes, GitHub #7 fails, one untagged failure.
// Each test works on a copy, since a real run writes Allure categories into the results.
const EXAMPLES = 'examples/allure-results';
let resultsDir: string;

let server: Awaited<ReturnType<typeof startFakeServer>> | undefined;

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubEnv('GITHUB_STEP_SUMMARY', '');
  resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-results-'));
  fs.cpSync(EXAMPLES, resultsDir, { recursive: true });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await server?.close();
  server = undefined;
  fs.rmSync(resultsDir, { recursive: true, force: true });
});

interface FakeTicket {
  status: string;
  category: 'new' | 'indeterminate' | 'done';
  comments: unknown[];
}

const STATUS = {
  open: { status: 'In Progress', category: 'indeterminate' },
  done: { status: 'Done', category: 'done' },
} as const;

// Workflow offered by the fake Jira: "Reopen" → To Do, "Ready for QA" → Ready for QA
const TRANSITIONS = [
  { id: '11', name: 'Reopen', to: { name: 'To Do', statusCategory: 'new' } },
  { id: '21', name: 'Send to QA', to: { name: 'Ready for QA', statusCategory: 'indeterminate' } },
];

/**
 * One fake server for both APIs: Jira under /rest, GitHub under /repos.
 * Tickets keep their status and comments in memory, newest comment first.
 */
async function startFakeTrackers(statuses: { 'DEFECT-123'?: keyof typeof STATUS; 'DEFECT-118'?: keyof typeof STATUS } = {}) {
  const tickets: Record<string, FakeTicket> = {
    'DEFECT-123': { ...STATUS[statuses['DEFECT-123'] ?? 'open'], comments: [] },
    'DEFECT-118': { ...STATUS[statuses['DEFECT-118'] ?? 'open'], comments: [] },
  };
  const githubComments: string[] = [];

  server = await startFakeServer((req: RecordedRequest): Reply => {
    const url = req.url.split('?')[0];
    const jira = url.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/\w+)?$/);

    if (jira) {
      const [, key, sub] = jira;
      const ticket = tickets[key];
      if (!ticket) return { status: 404, body: {} };

      if (!sub) {
        return {
          status: 200,
          body: { key, fields: { summary: `Ticket ${key}`, status: { name: ticket.status, statusCategory: { key: ticket.category } }, priority: { name: 'High' }, assignee: { displayName: 'Ada Tester' } } },
        };
      }
      if (sub === '/comment' && req.method === 'GET') return { status: 200, body: { comments: ticket.comments.map((body) => ({ body })) } };
      if (sub === '/comment') {
        ticket.comments.unshift(JSON.parse(req.body).body);
        return { status: 201, body: { id: String(ticket.comments.length) } };
      }
      if (sub === '/attachments') return { status: 200, body: [] };
      if (sub === '/transitions' && req.method === 'GET') return { status: 200, body: { transitions: TRANSITIONS } };
      if (sub === '/transitions') {
        const chosen = TRANSITIONS.find((t) => t.id === JSON.parse(req.body).transition.id)!;
        ticket.status = chosen.to.name;
        ticket.category = chosen.to.statusCategory as FakeTicket['category'];
        return { status: 204 };
      }
    }

    if (url === '/repos/acme/app/issues/7') return { status: 200, body: { number: 7, title: 'Clear completed', state: 'open' } };
    if (url === '/repos/acme/app/issues/7/comments' && req.method === 'GET') {
      return { status: 200, body: githubComments.map((body) => ({ body })) };
    }
    if (url === '/repos/acme/app/issues/7/comments') {
      githubComments.push(JSON.parse(req.body).body);
      return { status: 201, body: { id: githubComments.length } };
    }
    return { status: 404, body: {} };
  });

  return { tickets, githubComments };
}

function configFor(runId?: string, extra: Record<string, string> = {}) {
  return loadConfig(
    {
      JIRA_BASE_URL: server!.url,
      JIRA_EMAIL: 'qa@example.com',
      JIRA_API_TOKEN: 'token',
      GITHUB_TOKEN: 'ghp_test',
      GITHUB_REPO: 'acme/app',
      GITHUB_API_URL: server!.url,
      ...(runId ? { CI_RUN_ID: runId } : {}),
      ...extra,
    },
    { resultsDir }
  );
}

const text = (comment: unknown) => JSON.stringify(comment);

/** Error message of a result file in the copied results dir, by its file name prefix. */
const messageOf = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(resultsDir, `${file}-result.json`), 'utf-8')).statusDetails?.message as string;

describe('DefectReporter', () => {
  describe('failing test, open ticket', () => {
    it('posts each failure once per CI run', async () => {
      const { tickets, githubComments } = await startFakeTrackers();

      const first = await new DefectReporter(configFor('147')).run();
      const second = await new DefectReporter(configFor('147')).run();

      expect(first).toMatchObject({ reported: 2, errored: 0 });
      expect(second).toMatchObject({ reported: 0, errored: 0 });
      expect(tickets['DEFECT-123'].comments).toHaveLength(1);
      expect(githubComments).toHaveLength(1);
      expect(text(tickets['DEFECT-123'].comments[0])).toContain('defect-bridge:run=147;test=c1a8e2f7a9b14d3e');
      expect(githubComments[0]).toContain('<!-- defect-bridge:run=147;test=5e93b0c4d2a7f611 -->');
    });

    it('posts again for a different CI run', async () => {
      const { tickets } = await startFakeTrackers();

      await new DefectReporter(configFor('147')).run();
      await new DefectReporter(configFor('148')).run();

      expect(tickets['DEFECT-123'].comments).toHaveLength(2);
    });

    it('skips the duplicate check without a run id', async () => {
      await startFakeTrackers();

      await new DefectReporter(configFor()).run();

      const markerLookups = server!.requests.filter((r) => r.method === 'GET' && r.url.includes('DEFECT-123/comment'));
      expect(markerLookups).toHaveLength(0);
    });
  });

  describe('failing test, ticket already done', () => {
    it('posts a regression comment and leaves the status alone by default', async () => {
      const { tickets } = await startFakeTrackers({ 'DEFECT-123': 'done' });

      const summary = await new DefectReporter(configFor('147')).run();

      expect(summary.regressions).toBe(1);
      expect(text(tickets['DEFECT-123'].comments[0])).toContain('Regression — ticket is Done');
      expect(tickets['DEFECT-123'].status).toBe('Done');
    });

    it('reopens the ticket when JIRA_REOPEN_TRANSITION is set', async () => {
      const { tickets } = await startFakeTrackers({ 'DEFECT-123': 'done' });

      await new DefectReporter(configFor('147', { JIRA_REOPEN_TRANSITION: 'Reopen' })).run();

      expect(tickets['DEFECT-123'].status).toBe('To Do');
    });

    it('accepts the target status name too, and warns when the workflow has no such transition', async () => {
      const first = await startFakeTrackers({ 'DEFECT-123': 'done' });
      await new DefectReporter(configFor('147', { JIRA_REOPEN_TRANSITION: 'to do' })).run();
      expect(first.tickets['DEFECT-123'].status).toBe('To Do');
      await server!.close();

      const second = await startFakeTrackers({ 'DEFECT-123': 'done' });
      const summary = await new DefectReporter(configFor('147', { JIRA_REOPEN_TRANSITION: 'Reopened' })).run();
      expect(second.tickets['DEFECT-123'].status).toBe('Done');
      expect(summary.errored).toBe(0);
    });
  });

  describe('passing test', () => {
    it('posts one "passing again" comment on an open ticket, not one per run', async () => {
      const { tickets } = await startFakeTrackers();

      const first = await new DefectReporter(configFor('147')).run();
      const second = await new DefectReporter(configFor('148')).run();

      expect(first.passing).toBe(1);
      expect(second.passing).toBe(0);
      expect(tickets['DEFECT-118'].comments).toHaveLength(1);
      expect(text(tickets['DEFECT-118'].comments[0])).toContain('passing again');
      expect(text(tickets['DEFECT-118'].comments[0])).toContain('defect-bridge:passing;run=147;test=0b7f2d9e8c1a4e55');
    });

    it('reports passing again after the test has failed in between', async () => {
      const { tickets } = await startFakeTrackers();
      tickets['DEFECT-118'].comments.unshift({ text: 'defect-bridge:passing;run=100;test=0b7f2d9e8c1a4e55' });
      tickets['DEFECT-118'].comments.unshift({ text: 'defect-bridge:run=101;test=0b7f2d9e8c1a4e55' });

      const summary = await new DefectReporter(configFor('102')).run();

      expect(summary.passing).toBe(1);
    });

    it('tracks pass → fail → pass without a run id too', async () => {
      const { tickets } = await startFakeTrackers();
      const file = path.join(resultsDir, 'a9e6f031-result.json');
      const setStatus = (status: string) =>
        fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf-8')), status }));

      await new DefectReporter(configFor()).run();
      setStatus('failed');
      await new DefectReporter(configFor()).run();
      setStatus('passed');
      const third = await new DefectReporter(configFor()).run();

      expect(third.passing).toBe(1);
      expect(tickets['DEFECT-118'].comments.map((c) => (text(c).includes('passing again') ? 'passing' : 'failing'))).toEqual([
        'passing',
        'failing',
        'passing',
      ]);
    });

    it('moves the ticket when JIRA_PASS_TRANSITION is set', async () => {
      const { tickets } = await startFakeTrackers();

      await new DefectReporter(configFor('147', { JIRA_PASS_TRANSITION: 'Ready for QA' })).run();

      expect(tickets['DEFECT-118'].status).toBe('Ready for QA');
    });

    it('does nothing when the ticket is already done', async () => {
      const { tickets } = await startFakeTrackers({ 'DEFECT-118': 'done' });

      const summary = await new DefectReporter(configFor('147')).run();

      expect(summary.passing).toBe(0);
      expect(tickets['DEFECT-118'].comments).toHaveLength(0);
    });
  });

  describe('Allure categories', () => {
    it('labels tagged failures by ticket status and writes categories.json', async () => {
      await startFakeTrackers({ 'DEFECT-123': 'done' });

      await new DefectReporter(configFor('147')).run();

      expect(messageOf('3f1c2a10')).toMatch(/^\[Regression DEFECT-123 · Done\] locator\.fill/);
      expect(messageOf('8b4d7e22')).toMatch(/^\[Known defect #7 · open\] expect\(locator\)/);
      expect(messageOf('d2c58b77')).not.toMatch(/^\[/); // untagged
      const names = JSON.parse(fs.readFileSync(path.join(resultsDir, 'categories.json'), 'utf-8')).map((c: { name: string }) => c.name);
      expect(names).toEqual(['Regression (linked ticket is closed)', 'Known defect', 'New failure (no defect linked)']);
    });

    it('replaces its own labels on a second run and keeps the comment text clean', async () => {
      const { tickets } = await startFakeTrackers();

      await new DefectReporter(configFor('147')).run();
      await new DefectReporter(configFor('148')).run();

      expect(messageOf('3f1c2a10')).toMatch(/^\[Known defect DEFECT-123 · In Progress\] locator\.fill/);
      expect(text(tickets['DEFECT-123'].comments[0])).not.toContain('[Known defect');
    });

    it('keeps categories the project already defines', async () => {
      await startFakeTrackers();
      fs.writeFileSync(path.join(resultsDir, 'categories.json'), JSON.stringify([{ name: 'Timeouts', messageRegex: '.*Timeout.*' }]));

      await new DefectReporter(configFor('147')).run();

      const names = JSON.parse(fs.readFileSync(path.join(resultsDir, 'categories.json'), 'utf-8')).map((c: { name: string }) => c.name);
      expect(names).toContain('Timeouts');
      expect(names).toHaveLength(4);
    });

    it('writes nothing with ALLURE_CATEGORIES=false or in a dry run', async () => {
      await startFakeTrackers();
      const before = messageOf('3f1c2a10');

      await new DefectReporter(configFor('147', { ALLURE_CATEGORIES: 'false' })).run();
      await new DefectReporter({ ...configFor('148'), run: { ...configFor('148').run, dryRun: true } }).run();

      expect(messageOf('3f1c2a10')).toBe(before);
      expect(fs.existsSync(path.join(resultsDir, 'categories.json'))).toBe(false);
    });
  });

  describe('GitHub Actions job summary', () => {
    it('shows each test next to its ticket status, priority, assignee and what was done', async () => {
      await startFakeTrackers({ 'DEFECT-123': 'done' });
      const summaryFile = path.join(resultsDir, 'step-summary.md');
      vi.stubEnv('GITHUB_STEP_SUMMARY', summaryFile);
      vi.stubEnv('GITHUB_SERVER_URL', 'https://github.com');

      await new DefectReporter(configFor('147', { JIRA_REOPEN_TRANSITION: 'Reopen' })).run();

      const rows = fs.readFileSync(summaryFile, 'utf-8').split('\n');
      expect(rows).toContain('| Scenario | Test | Ticket | Status | Priority | Assignee | defect-bridge |');
      expect(rows).toContain(
        `| Add a single todo item | ❌ failed | [DEFECT-123](${server!.url}/browse/DEFECT-123) | Done | High | Ada Tester | regression comment, moved to To Do |`
      );
      expect(rows).toContain(
        `| Complete a todo item | ✅ passed | [DEFECT-118](${server!.url}/browse/DEFECT-118) | In Progress | High | Ada Tester | passing comment |`
      );
      expect(rows).toContain('| Clear all completed todos | ⚠️ broken | [#7](https://github.com/acme/app/issues/7) | open | — | — | failure comment |');
    });
  });

  it('counts a failed update as an error and keeps going', async () => {
    server = await startFakeServer((req): Reply =>
      req.url.startsWith('/rest') ? { status: 401, body: {} } : { status: 404, body: {} }
    );

    const summary = await new DefectReporter(configFor('147'), { attempts: 1 }).run();

    expect(summary).toMatchObject({ errored: 2, skipped: 1 });
  });

  it('sends nothing in a dry run', async () => {
    await startFakeTrackers();

    const summary = await new DefectReporter({ ...configFor('147'), run: { ...configFor('147').run, dryRun: true } }).run();

    expect(summary).toMatchObject({ reported: 2, passing: 1 });
    expect(server!.requests).toHaveLength(0);
  });
});
