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
  it('returns the ticket key and summary, using basic auth', async () => {
    const jira = await cloudWith(() => ({ status: 200, body: { key: 'PROJ-42', fields: { summary: 'Checkout fails' } } }));

    expect(await jira.getIssue('PROJ-42')).toEqual({ key: 'PROJ-42', summary: 'Checkout fails' });

    const expectedAuth = `Basic ${Buffer.from('qa@example.com:token-123').toString('base64')}`;
    expect(server!.requests[0].url).toBe('/rest/api/3/issue/PROJ-42?fields=summary');
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

    expect(server!.requests[0].url).toBe('/rest/api/2/issue/PROJ-42?fields=summary');
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
