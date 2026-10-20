import axios, { AxiosInstance } from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import FormData from 'form-data';
import { ParsedFailure } from '../allure/types';
import { RetryOptions, withRetry } from '../http/retry';
import { CommentBuilder } from './CommentBuilder';
import { WikiCommentBuilder } from './WikiCommentBuilder';
import { adfToText } from './adfToText';

export type JiraFlavor = 'cloud' | 'datacenter';

export interface CommentContext {
  env: string;
  runId?: string;
  marker?: string;
}

/**
 * What the reporter needs from Jira. Cloud and Data Center differ in API
 * version, auth and comment format; the reporter does not need to know which.
 */
export interface JiraClient {
  getIssue(ticketKey: string): Promise<{ key: string; summary: string } | null>;
  hasComment(ticketKey: string, marker: string): Promise<boolean>;
  addComment(ticketKey: string, failure: ParsedFailure, ctx: CommentContext): Promise<string>;
  addAttachment(ticketKey: string, filePath: string): Promise<void>;
}

/** The HTTP calls both flavors share; subclasses supply the comment payload. */
abstract class RestJiraClient implements JiraClient {
  protected readonly client: AxiosInstance;

  constructor(
    baseUrl: string,
    apiVersion: 2 | 3,
    authorization: string,
    private readonly retry: RetryOptions
  ) {
    this.client = axios.create({
      baseURL: `${baseUrl.replace(/\/$/, '')}/rest/api/${apiVersion}`,
      headers: {
        Authorization: authorization,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
  }

  protected abstract commentPayload(failure: ParsedFailure, ctx: CommentContext): object;

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
    // body is an ADF object on Cloud and a wiki string on Data Center; stringify covers both
    const comments = response.data.comments as Array<{ body: unknown }>;
    return comments.some((c) => JSON.stringify(c.body).includes(marker));
  }

  async addComment(ticketKey: string, failure: ParsedFailure, ctx: CommentContext): Promise<string> {
    const payload = this.commentPayload(failure, ctx);
    const response = await withRetry(() => this.client.post(`/issue/${ticketKey}/comment`, payload), this.retry);
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

/**
 * Jira Cloud — REST API v3, basic auth with email + API token (id.atlassian.com),
 * comments in Atlassian Document Format.
 */
export class JiraCloudClient extends RestJiraClient {
  private readonly builder = new CommentBuilder();

  constructor(baseUrl: string, email: string, apiToken: string, retry: RetryOptions = {}) {
    super(baseUrl, 3, `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`, retry);
  }

  protected commentPayload(failure: ParsedFailure, ctx: CommentContext): object {
    return this.builder.build(failure, ctx.env, ctx.runId, ctx.marker);
  }
}

/**
 * Jira Data Center / Server — REST API v2, personal access token as a Bearer
 * token, comments in wiki markup.
 */
export class JiraDataCenterClient extends RestJiraClient {
  private readonly builder = new WikiCommentBuilder();

  constructor(baseUrl: string, personalAccessToken: string, retry: RetryOptions = {}) {
    super(baseUrl, 2, `Bearer ${personalAccessToken}`, retry);
  }

  protected commentPayload(failure: ParsedFailure, ctx: CommentContext): object {
    return { body: this.builder.build(failure, ctx.env, ctx.runId, ctx.marker) };
  }
}

/** The comment as plain text, for --dry-run. No client or credentials needed. */
export function previewComment(flavor: JiraFlavor, failure: ParsedFailure, ctx: CommentContext): string {
  if (flavor === 'datacenter') {
    return new WikiCommentBuilder().build(failure, ctx.env, ctx.runId, ctx.marker);
  }
  const comment = new CommentBuilder().build(failure, ctx.env, ctx.runId, ctx.marker) as {
    body: Parameters<typeof adfToText>[0];
  };
  return adfToText(comment.body);
}
