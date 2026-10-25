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

export interface JiraIssue {
  key: string;
  summary: string;
  status: string;
  /**
   * Jira's status category: "new" (To Do), "indeterminate" (In Progress) or "done".
   * Every workflow maps its statuses onto these three, so checks stay workflow-agnostic.
   */
  statusCategory: string;
  priority?: string;
  assignee?: string;
}

export interface CommentContext {
  env: string;
  runId?: string;
  marker?: string;
  /** Set when the ticket is already done: the failure comment is posted as a regression. */
  regressionOf?: string;
}

/**
 * What the reporter needs from Jira. Cloud and Data Center differ in API
 * version, auth and comment format; the reporter does not need to know which.
 */
export interface JiraClient {
  getIssue(ticketKey: string): Promise<JiraIssue | null>;
  hasComment(ticketKey: string, marker: string): Promise<boolean>;
  /** Whether the newest defect-bridge comment for this test reported it failing or passing. */
  lastReportedState(ticketKey: string, testId: string): Promise<'failing' | 'passing' | undefined>;
  addComment(ticketKey: string, failure: ParsedFailure, ctx: CommentContext): Promise<string>;
  addPassingComment(ticketKey: string, result: ParsedFailure, ctx: CommentContext): Promise<string>;
  addAttachment(ticketKey: string, filePath: string): Promise<void>;
  /** Moves the ticket through the named transition (or to the named status). Returns the new status, or null if not available. */
  transition(ticketKey: string, name: string): Promise<string | null>;
}

/** The HTTP calls both flavors share; subclasses supply the comment payloads. */
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
  protected abstract passingPayload(result: ParsedFailure, ctx: CommentContext): object;

  /** Verify the ticket exists and return its summary, status, priority and assignee. */
  async getIssue(ticketKey: string): Promise<JiraIssue | null> {
    try {
      const response = await withRetry(
        () => this.client.get(`/issue/${ticketKey}`, { params: { fields: 'summary,status,priority,assignee' } }),
        this.retry
      );
      const fields = response.data.fields;
      return {
        key: response.data.key,
        summary: fields.summary,
        status: fields.status?.name ?? 'Unknown',
        statusCategory: fields.status?.statusCategory?.key ?? 'unknown',
        priority: fields.priority?.name,
        assignee: fields.assignee?.displayName,
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
    return (await this.recentCommentBodies(ticketKey)).some((body) => body.includes(marker));
  }

  async lastReportedState(ticketKey: string, testId: string): Promise<'failing' | 'passing' | undefined> {
    const forThisTest = new RegExp(`defect-bridge:[^"}\\s]*;test=${escapeRegex(testId)}(?![\\w-])`);
    const newest = (await this.recentCommentBodies(ticketKey)).find((body) => forThisTest.test(body));
    if (!newest) return undefined;
    return newest.includes('defect-bridge:passing') ? 'passing' : 'failing';
  }

  async addComment(ticketKey: string, failure: ParsedFailure, ctx: CommentContext): Promise<string> {
    return this.postComment(ticketKey, this.commentPayload(failure, ctx));
  }

  async addPassingComment(ticketKey: string, result: ParsedFailure, ctx: CommentContext): Promise<string> {
    return this.postComment(ticketKey, this.passingPayload(result, ctx));
  }

  async transition(ticketKey: string, name: string): Promise<string | null> {
    const response = await withRetry(() => this.client.get(`/issue/${ticketKey}/transitions`), this.retry);
    const wanted = name.trim().toLowerCase();
    // Match the transition's own name ("Reopen") or the status it leads to ("To Do")
    const match = (response.data.transitions as Array<{ id: string; name: string; to?: { name?: string } }>).find(
      (t) => t.name.toLowerCase() === wanted || t.to?.name?.toLowerCase() === wanted
    );
    if (!match) return null;

    await withRetry(
      () => this.client.post(`/issue/${ticketKey}/transitions`, { transition: { id: match.id } }),
      this.retry
    );
    return match.to?.name ?? match.name;
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

  private async postComment(ticketKey: string, payload: object): Promise<string> {
    const response = await withRetry(() => this.client.post(`/issue/${ticketKey}/comment`, payload), this.retry);
    return response.data.id as string;
  }

  /** Bodies of the latest 100 comments, newest first, as strings. */
  private async recentCommentBodies(ticketKey: string): Promise<string[]> {
    const response = await withRetry(
      () => this.client.get(`/issue/${ticketKey}/comment`, { params: { maxResults: 100, orderBy: '-created' } }),
      this.retry
    );
    // body is an ADF object on Cloud and a wiki string on Data Center; stringify covers both
    return (response.data.comments as Array<{ body: unknown }>).map((c) => JSON.stringify(c.body));
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
    return this.builder.build(failure, ctx.env, ctx.runId, ctx.marker, ctx.regressionOf);
  }

  protected passingPayload(result: ParsedFailure, ctx: CommentContext): object {
    return this.builder.buildPassing(result, ctx.env, ctx.runId, ctx.marker);
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
    return { body: this.builder.build(failure, ctx.env, ctx.runId, ctx.marker, ctx.regressionOf) };
  }

  protected passingPayload(result: ParsedFailure, ctx: CommentContext): object {
    return { body: this.builder.buildPassing(result, ctx.env, ctx.runId, ctx.marker) };
  }
}

/** The comment as plain text, for --dry-run. No client or credentials needed. */
export function previewComment(flavor: JiraFlavor, failure: ParsedFailure, ctx: CommentContext): string {
  if (flavor === 'datacenter') {
    return new WikiCommentBuilder().build(failure, ctx.env, ctx.runId, ctx.marker, ctx.regressionOf);
  }
  const comment = new CommentBuilder().build(failure, ctx.env, ctx.runId, ctx.marker, ctx.regressionOf) as {
    body: Parameters<typeof adfToText>[0];
  };
  return adfToText(comment.body);
}

/** The "passing again" comment as plain text, for --dry-run. */
export function previewPassingComment(flavor: JiraFlavor, result: ParsedFailure, ctx: CommentContext): string {
  if (flavor === 'datacenter') {
    return new WikiCommentBuilder().buildPassing(result, ctx.env, ctx.runId, ctx.marker);
  }
  const comment = new CommentBuilder().buildPassing(result, ctx.env, ctx.runId, ctx.marker) as {
    body: Parameters<typeof adfToText>[0];
  };
  return adfToText(comment.body);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
