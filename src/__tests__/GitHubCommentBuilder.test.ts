import { describe, it, expect } from 'vitest';
import { GitHubCommentBuilder } from '../github/GitHubCommentBuilder';
import { ParsedFailure } from '../allure/types';

const builder = new GitHubCommentBuilder();

const baseFailure: ParsedFailure = {
  uuid: 'abc-123',
  scenarioName: 'User can add a todo item',
  errorMessage: 'Expected element to be visible',
  jiraTicket: 'PROJ-42',
  githubIssue: 7,
};

describe('GitHubCommentBuilder', () => {
  it('includes the heading', () => {
    const result = builder.build(baseFailure, 'staging');
    expect(result).toContain('## 🔴 Automated Test Failure');
  });

  it('includes the scenario name', () => {
    const result = builder.build(baseFailure, 'dev');
    expect(result).toContain('User can add a todo item');
  });

  it('includes the environment', () => {
    const result = builder.build(baseFailure, 'staging');
    expect(result).toContain('`staging`');
  });

  it('includes the error message in a code block', () => {
    const result = builder.build(baseFailure, 'dev');
    expect(result).toContain('Expected element to be visible');
    expect(result).toContain('```');
  });

  it('includes the CI run ID when provided', () => {
    const result = builder.build(baseFailure, 'dev', '1042');
    expect(result).toContain('`1042`');
  });

  it('omits the CI run row when runId is not provided', () => {
    const result = builder.build(baseFailure, 'dev');
    expect(result).not.toContain('CI Run');
  });

  it('includes duration when present', () => {
    const failure = { ...baseFailure, duration: 4 };
    const result = builder.build(failure, 'dev');
    expect(result).toContain('4s');
  });

  it('wraps stack trace in a collapsible details block', () => {
    const failure = { ...baseFailure, errorTrace: 'at Object.<anonymous> (test.ts:12)' };
    const result = builder.build(failure, 'dev');
    expect(result).toContain('<details>');
    expect(result).toContain('Stack Trace');
    expect(result).toContain('at Object.<anonymous>');
  });

  it('omits details block when there is no stack trace', () => {
    const result = builder.build(baseFailure, 'dev');
    expect(result).not.toContain('<details>');
  });

  it('truncates error messages longer than 800 characters', () => {
    const longMessage = 'x'.repeat(900);
    const failure = { ...baseFailure, errorMessage: longMessage };
    const result = builder.build(failure, 'dev');
    expect(result).toContain('(truncated)');
  });

  it('truncates stack traces longer than 1500 characters', () => {
    const longTrace = 'y'.repeat(1600);
    const failure = { ...baseFailure, errorTrace: longTrace };
    const result = builder.build(failure, 'dev');
    expect(result).toContain('(truncated)');
  });

  it('escapes pipe characters in scenario name to avoid breaking Markdown tables', () => {
    const failure = { ...baseFailure, scenarioName: 'Login | logout flow' };
    const result = builder.build(failure, 'dev');
    expect(result).toContain('Login \\| logout flow');
  });
});
