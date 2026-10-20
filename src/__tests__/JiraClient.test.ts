import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { JiraClient } from '../jira/JiraClient';
import { Reply, startFakeServer } from './fakeServer';

let server: Awaited<ReturnType<typeof startFakeServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function clientWith(handler: Parameters<typeof startFakeServer>[0]) {
  server = await startFakeServer(handler);
  return new JiraClient(server.url, 'qa@example.com', 'token-123');
}

describe('JiraClient (Cloud, API v3)', () => {
  it('returns the ticket key and summary, using basic auth', async () => {
    const jira = await clientWith(() => ({ status: 200, body: { key: 'PROJ-42', fields: { summary: 'Checkout fails' } } }));

    expect(await jira.getIssue('PROJ-42')).toEqual({ key: 'PROJ-42', summary: 'Checkout fails' });

    const expectedAuth = `Basic ${Buffer.from('qa@example.com:token-123').toString('base64')}`;
    expect(server!.requests[0].url).toBe('/rest/api/3/issue/PROJ-42?fields=summary');
    expect(server!.requests[0].headers.authorization).toBe(expectedAuth);
  });

  it('returns null when the ticket does not exist', async () => {
    const jira = await clientWith(() => ({ status: 404, body: { errorMessages: ['Issue does not exist'] } }));
    expect(await jira.getIssue('PROJ-404')).toBeNull();
  });

  it('throws on an auth failure instead of treating it as a missing ticket', async () => {
    const jira = await clientWith((): Reply => ({ status: 401, body: { message: 'Client must be authenticated' } }));
    await expect(jira.getIssue('PROJ-42')).rejects.toThrow('401');
  });

  it('posts the comment body to the issue', async () => {
    const jira = await clientWith(() => ({ status: 201, body: { id: '10001' } }));

    const id = await jira.addComment('PROJ-42', { body: { type: 'doc', version: 1, content: [] } });

    expect(id).toBe('10001');
    expect(server!.requests[0].method).toBe('POST');
    expect(server!.requests[0].url).toBe('/rest/api/3/issue/PROJ-42/comment');
    expect(JSON.parse(server!.requests[0].body)).toEqual({ body: { type: 'doc', version: 1, content: [] } });
  });

  it('uploads an attachment as multipart with the no-check header', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'db-')), 'failure.png');
    fs.writeFileSync(file, 'fake-png-bytes');
    const jira = await clientWith(() => ({ status: 200, body: [{ id: '1' }] }));

    await jira.addAttachment('PROJ-42', file);

    const request = server!.requests[0];
    expect(request.url).toBe('/rest/api/3/issue/PROJ-42/attachments');
    expect(request.headers['x-atlassian-token']).toBe('no-check');
    expect(request.headers['content-type']).toContain('multipart/form-data');
    expect(request.body).toContain('filename="failure.png"');
    expect(request.body).toContain('fake-png-bytes');
  });
});
