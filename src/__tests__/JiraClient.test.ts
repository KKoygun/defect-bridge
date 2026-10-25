import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ParsedFailure } from '../allure/types';
import { JiraCloudClient, JiraDataCenterClient, previewComment } from '../jira/JiraClient';
import { Reply, startFakeServer } from './fakeServer';

let server: Awaited<ReturnType<typeof startFakeServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

const failure: ParsedFailure = {
  uuid: 'u1',
  testId: 'h1',
  scenarioName: 'Add a todo item',
  errorMessage: 'locator.fill: Timeout 5000ms exceeded.',
  jiraTicket: 'PROJ-42',
};
const ctx = { env: 'staging', runId: '147', marker: 'defect-bridge:run=147;test=h1' };

async function cloudWith(handler: Parameters<typeof startFakeServer>[0]) {
  server = await startFakeServer(handler);
  return new JiraCloudClient(server.url, 'qa@example.com', 'token-123', { attempts: 1 });
}

async function dataCenterWith(handler: Parameters<typeof startFakeServer>[0]) {
  server = await startFakeServer(handler);
  return new JiraDataCenterClient(server.url, 'pat-456', { attempts: 1 });
}

function tempScreenshot(): string {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-')), 'failure.png');
  fs.writeFileSync(file, 'fake-png-bytes');
  return file;
}

describe('JiraCloudClient (API v3)', () => {
  it('returns the ticket with its status, priority and assignee, using basic auth', async () => {
    const fields = {
      summary: 'Checkout fails',
      status: { name: 'In Review', statusCategory: { key: 'indeterminate' } },
      priority: { name: 'High' },
      assignee: { displayName: 'Ada Tester' },
    };
    const jira = await cloudWith(() => ({ status: 200, body: { key: 'PROJ-42', fields } }));

    expect(await jira.getIssue('PROJ-42')).toEqual({
      key: 'PROJ-42',
      summary: 'Checkout fails',
      status: 'In Review',
      statusCategory: 'indeterminate',
      priority: 'High',
      assignee: 'Ada Tester',
    });

    const expectedAuth = `Basic ${Buffer.from('qa@example.com:token-123').toString('base64')}`;
    expect(server!.requests[0].url).toBe('/rest/api/3/issue/PROJ-42?fields=summary,status,priority,assignee');
    expect(server!.requests[0].headers.authorization).toBe(expectedAuth);
  });

  it('returns null when the ticket does not exist', async () => {
    const jira = await cloudWith(() => ({ status: 404, body: { errorMessages: ['Issue does not exist'] } }));
    expect(await jira.getIssue('PROJ-404')).toBeNull();
  });

  it('throws on an auth failure instead of treating it as a missing ticket', async () => {
    const jira = await cloudWith((): Reply => ({ status: 401, body: { message: 'Client must be authenticated' } }));
    await expect(jira.getIssue('PROJ-42')).rejects.toThrow('401');
  });

  it('posts the comment as ADF with the marker', async () => {
    const jira = await cloudWith(() => ({ status: 201, body: { id: '10001' } }));

    expect(await jira.addComment('PROJ-42', failure, ctx)).toBe('10001');

    const request = server!.requests[0];
    expect(request.url).toBe('/rest/api/3/issue/PROJ-42/comment');
    const payload = JSON.parse(request.body);
    expect(payload.body).toMatchObject({ type: 'doc', version: 1 });
    expect(request.body).toContain(ctx.marker);
  });

  it('finds an earlier comment by its marker', async () => {
    const adf = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: ctx.marker }] }] };
    const jira = await cloudWith(() => ({ status: 200, body: { comments: [{ body: adf }] } }));

    expect(await jira.hasComment('PROJ-42', ctx.marker)).toBe(true);
    expect(await jira.hasComment('PROJ-42', 'defect-bridge:run=148;test=h1')).toBe(false);
    expect(server!.requests[0].url).toBe('/rest/api/3/issue/PROJ-42/comment?maxResults=100&orderBy=-created');
  });

  it('reads the last reported state of a test from the newest marker', async () => {
    const comment = (text: string) => ({ body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } });
    let comments = [comment('defect-bridge:passing;run=148;test=h1'), comment('defect-bridge:run=147;test=h1')];
    const jira = await cloudWith(() => ({ status: 200, body: { comments } }));

    expect(await jira.lastReportedState('PROJ-42', 'h1')).toBe('passing');
    comments = [comment('defect-bridge:run=149;test=h1'), ...comments];
    expect(await jira.lastReportedState('PROJ-42', 'h1')).toBe('failing');
    // h1 must not match h10
    comments = [comment('defect-bridge:run=150;test=h10')];
    expect(await jira.lastReportedState('PROJ-42', 'h1')).toBeUndefined();
  });

  it('posts the passing comment with its marker', async () => {
    const jira = await cloudWith(() => ({ status: 201, body: { id: '10002' } }));

    await jira.addPassingComment('PROJ-42', failure, { ...ctx, marker: 'defect-bridge:passing;run=147;test=h1' });

    expect(server!.requests[0].body).toContain('passing again');
    expect(server!.requests[0].body).toContain('defect-bridge:passing;run=147;test=h1');
  });

  it('moves the ticket by transition name or target status, and returns null when neither exists', async () => {
    const transitions = [{ id: '31', name: 'Reopen', to: { name: 'To Do' } }];
    const jira = await cloudWith((req) => (req.method === 'GET' ? { status: 200, body: { transitions } } : { status: 204 }));

    expect(await jira.transition('PROJ-42', 'reopen')).toBe('To Do');
    expect(await jira.transition('PROJ-42', 'To Do')).toBe('To Do');
    expect(await jira.transition('PROJ-42', 'Close')).toBeNull();

    const posts = server!.requests.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0].url).toBe('/rest/api/3/issue/PROJ-42/transitions');
    expect(JSON.parse(posts[0].body)).toEqual({ transition: { id: '31' } });
  });

  it('uploads an attachment as multipart with the no-check header', async () => {
    const jira = await cloudWith(() => ({ status: 200, body: [{ id: '1' }] }));

    await jira.addAttachment('PROJ-42', tempScreenshot());

    const request = server!.requests[0];
    expect(request.url).toBe('/rest/api/3/issue/PROJ-42/attachments');
    expect(request.headers['x-atlassian-token']).toBe('no-check');
    expect(request.headers['content-type']).toContain('multipart/form-data');
    expect(request.body).toContain('filename="failure.png"');
    expect(request.body).toContain('fake-png-bytes');
  });
});

describe('JiraDataCenterClient (API v2)', () => {
  it('uses API v2 with the personal access token as a Bearer token', async () => {
    const jira = await dataCenterWith(() => ({ status: 200, body: { key: 'PROJ-42', fields: { summary: 'Checkout fails' } } }));

    await jira.getIssue('PROJ-42');

    expect(server!.requests[0].url).toBe('/rest/api/2/issue/PROJ-42?fields=summary,status,priority,assignee');
    expect(server!.requests[0].headers.authorization).toBe('Bearer pat-456');
  });

  it('posts the comment as wiki markup, without emoji', async () => {
    const jira = await dataCenterWith(() => ({ status: 201, body: { id: '20001' } }));

    await jira.addComment('PROJ-42', failure, ctx);

    const { body } = JSON.parse(server!.requests[0].body) as { body: string };
    expect(server!.requests[0].url).toBe('/rest/api/2/issue/PROJ-42/comment');
    expect(typeof body).toBe('string');
    expect(body).toContain('h3. (x) Automated Test is Failing');
    expect(body).toContain('*Scenario:* Add a todo item');
    expect(body).toContain(`{{${ctx.marker}}}`);
    expect(body).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('posts regression and passing comments in wiki markup', async () => {
    const jira = await dataCenterWith(() => ({ status: 201, body: { id: '20002' } }));

    await jira.addComment('PROJ-42', failure, { ...ctx, regressionOf: 'Closed' });
    await jira.addPassingComment('PROJ-42', failure, ctx);

    const [regression, passing] = server!.requests.map((r) => (JSON.parse(r.body) as { body: string }).body);
    expect(regression).toContain('h3. (!) Regression — ticket is Closed, but the test fails again');
    expect(passing).toContain('h3. (/) Automated test is passing again');
  });

  it('finds an earlier comment by its marker in a wiki body', async () => {
    const jira = await dataCenterWith(() => ({ status: 200, body: { comments: [{ body: `h3. old\n{{${ctx.marker}}}` }] } }));
    expect(await jira.hasComment('PROJ-42', ctx.marker)).toBe(true);
  });

  it('returns null for a missing ticket and throws on a forbidden one', async () => {
    let status = 404;
    const jira = await dataCenterWith(() => ({ status, body: {} }));

    expect(await jira.getIssue('PROJ-404')).toBeNull();
    status = 403;
    await expect(jira.getIssue('PROJ-42')).rejects.toThrow('403');
  });

  it('uploads attachments through API v2', async () => {
    const jira = await dataCenterWith(() => ({ status: 200, body: [] }));
    await jira.addAttachment('PROJ-42', tempScreenshot());
    expect(server!.requests[0].url).toBe('/rest/api/2/issue/PROJ-42/attachments');
    expect(server!.requests[0].headers['x-atlassian-token']).toBe('no-check');
  });
});

describe('previewComment', () => {
  it('renders the Cloud comment as text and the Data Center comment as wiki markup', () => {
    expect(previewComment('cloud', failure, ctx)).toContain('Scenario     │ Add a todo item');
    expect(previewComment('datacenter', failure, ctx)).toContain('*Scenario:* Add a todo item');
  });
});
