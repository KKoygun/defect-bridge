import axios from 'axios';

/**
 * GitHubClient — thin REST API client for GitHub Issues.
 *
 * Auth: Personal Access Token (classic) or fine-grained PAT with Issues write scope.
 * Docs: https://docs.github.com/en/rest/issues/comments
 */
export class GitHubClient {
  private readonly baseUrl = 'https://api.github.com';

  private readonly headers: Record<string, string>;

  constructor(
    private readonly token: string,
    private readonly repo: string   // 'owner/repo'
  ) {
    this.headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }

  /** Verify the issue exists and return its number + title. */
  async getIssue(
    issueNumber: number
  ): Promise<{ number: number; title: string } | null> {
    try {
      const response = await axios.get(
        `${this.baseUrl}/repos/${this.repo}/issues/${issueNumber}`,
        { headers: this.headers }
      );
      return {
        number: response.data.number as number,
        title:  response.data.title  as string,
      };
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 404) return null;
      throw err;
    }
  }

  /** Post a Markdown comment on a GitHub Issue. */
  async addComment(issueNumber: number, body: string): Promise<number> {
    const response = await axios.post(
      `${this.baseUrl}/repos/${this.repo}/issues/${issueNumber}/comments`,
      { body },
      { headers: this.headers }
    );
    return response.data.id as number;
  }
}
