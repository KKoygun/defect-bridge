import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import FormData from 'form-data';
import { RetryOptions, withRetry } from '../http/retry';

/**
 * JiraClient — thin REST API v3 client for Jira Cloud.
 *
 * Auth: Basic auth with email + API token (generated at id.atlassian.com)
 * Docs: https://developer.atlassian.com/cloud/jira/platform/rest/v3/
 */
export class JiraClient {
  private readonly client: AxiosInstance;

  constructor(
    baseUrl: string,
    email: string,
    apiToken: string,
    private readonly retry: RetryOptions = {}
  ) {
    const token = Buffer.from(`${email}:${apiToken}`).toString('base64');

    this.client = axios.create({
      baseURL: `${baseUrl.replace(/\/$/, '')}/rest/api/3`,
      headers: {
        Authorization: `Basic ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
  }

  /** Verify the ticket exists and return its summary. */
  async getIssue(ticketKey: string): Promise<{ key: string; summary: string } | null> {
    try {
      const response = await withRetry(() => this.client.get(`/issue/${ticketKey}?fields=summary`), this.retry);
      return {
        key: response.data.key,
        summary: response.data.fields.summary,
      };
    } catch (err) {
      if (axios.isAxiosError(err) && err.response?.status === 404) {
        return null;
      }
      throw err;
    }
  }

  /** True if one of the latest 100 comments on the ticket contains the marker. */
  async hasComment(ticketKey: string, marker: string): Promise<boolean> {
    const response = await withRetry(
      () => this.client.get(`/issue/${ticketKey}/comment`, { params: { maxResults: 100, orderBy: '-created' } }),
      this.retry
    );
    const comments = response.data.comments as Array<{ body: unknown }>;
    return comments.some((c) => JSON.stringify(c.body).includes(marker));
  }

  /** Add an ADF comment to a Jira ticket. */
  async addComment(ticketKey: string, body: object): Promise<string> {
    const response = await withRetry(() => this.client.post(`/issue/${ticketKey}/comment`, body), this.retry);
    return response.data.id as string;
  }

  /**
   * Attach a file (e.g. screenshot) to a Jira ticket.
   *
   * Requires X-Atlassian-Token: no-check header to bypass CSRF protection.
   * This is documented and expected behaviour for the attachments endpoint.
   */
  async addAttachment(ticketKey: string, filePath: string): Promise<void> {
    const ext = path.extname(filePath).toLowerCase();
    const contentType = ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png';

    // The form is rebuilt per attempt: a file stream can only be read once
    await withRetry(() => {
      const form = new FormData();
      form.append('file', fs.createReadStream(filePath), {
        filename: path.basename(filePath),
        contentType,
      });
      return this.client.post(`/issue/${ticketKey}/attachments`, form, {
        headers: {
          ...form.getHeaders(),
          'X-Atlassian-Token': 'no-check', // required for attachment uploads
        },
      });
    }, this.retry);
  }
}
