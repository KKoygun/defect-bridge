import { describe, it, expect, vi, afterEach } from 'vitest';
import { CommentBuilder } from '../jira/CommentBuilder';
import { ParsedFailure } from '../allure/types';

const builder = new CommentBuilder();

const baseFailure: ParsedFailure = {
  uuid: 'abc-123',
  scenarioName: 'User can add a todo item',
  errorMessage: 'Expected element to be visible',
  jiraTicket: 'PROJ-42',
};

describe('CommentBuilder', () => {
  it('returns an ADF document at the top level', () => {
    const result = builder.build(baseFailure, 'dev') as { body: { version: number; type: string } };
    expect(result.body.version).toBe(1);
    expect(result.body.type).toBe('doc');
  });

  it('body content is a non-empty array of ADF nodes', () => {
    const result = builder.build(baseFailure, 'dev') as { body: { content: unknown[] } };
    expect(Array.isArray(result.body.content)).toBe(true);
    expect(result.body.content.length).toBeGreaterThan(0);
  });

  it('first content node is a heading', () => {
    const result = builder.build(baseFailure, 'dev') as {
      body: { content: Array<{ type: string }> };
    };
    expect(result.body.content[0].type).toBe('heading');
  });

  it('serialised output contains the scenario name', () => {
    const result = builder.build(baseFailure, 'dev');
    expect(JSON.stringify(result)).toContain('User can add a todo item');
  });

  it('serialised output contains the error message', () => {
    const result = builder.build(baseFailure, 'dev');
    expect(JSON.stringify(result)).toContain('Expected element to be visible');
  });

  it('serialised output contains the environment', () => {
    const result = builder.build(baseFailure, 'staging');
    expect(JSON.stringify(result)).toContain('staging');
  });

  it('includes CI run ID when provided', () => {
    const result = builder.build(baseFailure, 'dev', '2099');
    expect(JSON.stringify(result)).toContain('2099');
  });

  it('does not include CI run row when runId is omitted', () => {
    const result = builder.build(baseFailure, 'dev');
    expect(JSON.stringify(result)).not.toContain('CI Run');
  });

  it('includes a codeBlock node for the error', () => {
    const result = builder.build(baseFailure, 'dev') as {
      body: { content: Array<{ type: string }> };
    };
    const types = result.body.content.map((n) => n.type);
    expect(types).toContain('codeBlock');
  });

  it('includes stack trace nodes when errorTrace is provided', () => {
    const failure = { ...baseFailure, errorTrace: 'at Object.<anonymous> (test.ts:12)' };
    const result = builder.build(failure, 'dev');
    expect(JSON.stringify(result)).toContain('at Object.<anonymous>');
  });

  it('mentions the screenshot only when there is one', () => {
    expect(JSON.stringify(builder.build(baseFailure, 'dev'))).not.toContain('Screenshot');
    const withScreenshot = builder.build({ ...baseFailure, screenshotPath: 'allure-results/a-attachment.png' }, 'dev');
    expect(JSON.stringify(withScreenshot)).toContain('Screenshot attached to the ticket.');
  });

  it('truncates error messages longer than 800 characters', () => {
    const failure = { ...baseFailure, errorMessage: 'e'.repeat(900) };
    const result = builder.build(failure, 'dev');
    expect(JSON.stringify(result)).toContain('truncated');
  });

  describe('ADF structure', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    // A diff in this snapshot means the comment Jira shows has changed — review it on purpose.
    it('matches the snapshot', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-05T14:32:00Z'));

      const result = builder.build(
        {
          ...baseFailure,
          fullName: 'TodoMVC Task Management > Add a todo item',
          duration: 3,
          errorTrace: 'at TodoPage.addTodo (src/pages/TodoPage.ts:24:5)',
          screenshotPath: 'allure-results/abc-attachment.png',
        },
        'staging',
        '147'
      );

      expect(result).toMatchSnapshot();
    });
  });
});
