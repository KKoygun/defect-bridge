import { AxiosError, AxiosHeaders } from 'axios';
import { afterEach, describe, expect, it } from 'vitest';
import { JiraCloudClient } from '../jira/JiraClient';
import { retryDelay } from '../http/retry';
import { Reply, startFakeServer } from './fakeServer';

let server: Awaited<ReturnType<typeof startFakeServer>> | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

/** Answers with the given statuses in order, then keeps repeating the last one. */
async function jiraReplying(...statuses: number[]) {
  let call = 0;
  server = await startFakeServer((): Reply => {
    const status = statuses[Math.min(call++, statuses.length - 1)];
    return status === 200 ? { status, body: { key: 'PROJ-1', fields: { summary: 'ok' } } } : { status, body: {} };
  });
  return new JiraCloudClient(server.url, 'qa@example.com', 'token', { attempts: 3, baseDelayMs: 1 });
}

describe('retry', () => {
  it('retries a rate limit and then succeeds', async () => {
    const jira = await jiraReplying(429, 200);
    expect(await jira.getIssue('PROJ-1')).toEqual({ key: 'PROJ-1', summary: 'ok' });
    expect(server!.requests).toHaveLength(2);
  });

  it('gives up on a server error after the last attempt', async () => {
    const jira = await jiraReplying(503);
    await expect(jira.getIssue('PROJ-1')).rejects.toThrow('503');
    expect(server!.requests).toHaveLength(3);
  });

  it('does not retry a client error', async () => {
    const jira = await jiraReplying(400);
    await expect(jira.getIssue('PROJ-1')).rejects.toThrow('400');
    expect(server!.requests).toHaveLength(1);
  });

  it('backs off exponentially, honours Retry-After and caps the wait', () => {
    const withStatus = (status: number, headers: Record<string, string> = {}) =>
      new AxiosError('x', 'ERR', undefined, undefined, {
        status,
        statusText: '',
        data: {},
        headers,
        config: { headers: new AxiosHeaders() },
      });

    expect(retryDelay(withStatus(503), 1, 1000)).toBe(1000);
    expect(retryDelay(withStatus(503), 3, 1000)).toBe(4000);
    expect(retryDelay(withStatus(429, { 'retry-after': '7' }), 1, 1000)).toBe(7000);
    expect(retryDelay(withStatus(429, { 'retry-after': '3600' }), 1, 1000)).toBe(30_000);
  });
});
