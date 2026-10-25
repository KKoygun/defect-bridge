import axios from 'axios';
import { RetryOptions, withRetry } from '../http/retry';

export interface GitHubIssue {
  number: number;
  title: string;
  state: 'open' | 'closed';
}

/**
 * GitHubClient — thin REST API client for GitHub Issues.
 *
 * Auth: Personal Access Token (classic) or fine-grained PAT with Issues write scope.
 * Docs: https://docs.github.com/en/rest/issues/comments
 */
export class GitHubClient {
  private readonly headers: Record<string, string>;

  constructor(
    token: string,
    private readonly repo: string, // 'owner/repo'
    private readonly apiUrl = 'https://api.github.com',
    private readonly retry: RetryOptions = {}
  ) {
    this.headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }

  /** Verify the issue exists and return its number, title and state. */
  async getIssue(issueNumber: number): Promise<GitHubIssue | null> {
    try {
      const response = await withRetry(
        () => axios.get(`${this.apiUrl}/repos/${this.repo}/issues/${issueNumber}`, { headers: this.headers }),
        this.retry
      );
      return {
        number: response.data.number as number,
        title:  response.data.title  as string,
        state:  response.data.state  as 'open' | 'closed',
      };
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  /** True if any comment on the issue already contains the marker. */
  async hasComment(issueNumber: number, marker: string): Promise<boolean> {
    // Comments come oldest first, 100 per page; ten pages is plenty for a defect ticket
    for (let page = 1; page <= 10; page++) {
      const response = await withRetry(
        () =>
          axios.get(`${this.apiUrl}/repos/${this.repo}/issues/${issueNumber}/comments`, {
            headers: this.headers,
            params: { per_page: 100, page },
          }),
        this.retry
      );
      const comments = response.data as Array<{ body?: string }>;
      if (comments.some((c) => c.body?.includes(marker))) return true;
      if (comments.length < 100) return false;
    }
    return false;
  }

  /** Post a Markdown comment on a GitHub Issue. */
  async addComment(issueNumber: number, body: string): Promise<number> {
    const response = await withRetry(
      () =>
        axios.post(`${this.apiUrl}/repos/${this.repo}/issues/${issueNumber}/comments`, { body }, { headers: this.headers }),
      this.retry
    );
    return response.data.id as number;
  }
}
