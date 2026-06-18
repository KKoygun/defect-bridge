import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import { AllureResultsParser } from '../allure/AllureResultsParser';

// Mock the fs module so tests never touch the filesystem
vi.mock('fs');

const mockFs = vi.mocked(fs);

function makeResult(overrides: object = {}) {
  return JSON.stringify({
    uuid: 'test-uuid-1',
    name: 'User can complete a todo',
    status: 'failed',
    labels: [{ name: 'issue', value: 'PROJ-99' }],
    links: [],
    attachments: [],
    statusDetails: { message: 'Element not found', trace: 'at step (test.ts:5)' },
    start: 1000,
    stop: 4000,
    ...overrides,
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockFs.existsSync.mockReturnValue(true);
});

describe('AllureResultsParser', () => {
  it('returns empty array when no result files exist', () => {
    mockFs.readdirSync.mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
    const parser = new AllureResultsParser('allure-results');
    expect(parser.parse()).toEqual([]);
  });

  it('extracts jiraTicket from labels', () => {
    mockFs.readdirSync.mockReturnValue(['abc-result.json'] as unknown as ReturnType<typeof fs.readdirSync>);
    mockFs.readFileSync.mockReturnValue(makeResult());
    const parser = new AllureResultsParser('allure-results');
    const failures = parser.parse();
    expect(failures).toHaveLength(1);
    expect(failures[0].jiraTicket).toBe('PROJ-99');
  });

  it('extracts githubIssue from labels', () => {
    mockFs.readdirSync.mockReturnValue(['abc-result.json'] as unknown as ReturnType<typeof fs.readdirSync>);
    mockFs.readFileSync.mockReturnValue(
      makeResult({ labels: [{ name: 'github_issue', value: '42' }] })
    );
    const parser = new AllureResultsParser('allure-results');
    const failures = parser.parse();
    expect(failures).toHaveLength(1);
    expect(failures[0].githubIssue).toBe(42);
  });

  it('skips passed tests', () => {
    mockFs.readdirSync.mockReturnValue(['abc-result.json'] as unknown as ReturnType<typeof fs.readdirSync>);
    mockFs.readFileSync.mockReturnValue(makeResult({ status: 'passed' }));
    const parser = new AllureResultsParser('allure-results');
    expect(parser.parse()).toHaveLength(0);
  });

  it('skips skipped tests', () => {
    mockFs.readdirSync.mockReturnValue(['abc-result.json'] as unknown as ReturnType<typeof fs.readdirSync>);
    mockFs.readFileSync.mockReturnValue(makeResult({ status: 'skipped' }));
    const parser = new AllureResultsParser('allure-results');
    expect(parser.parse()).toHaveLength(0);
  });

  it('skips failed tests with no issue labels', () => {
    mockFs.readdirSync.mockReturnValue(['abc-result.json'] as unknown as ReturnType<typeof fs.readdirSync>);
    mockFs.readFileSync.mockReturnValue(makeResult({ labels: [] }));
    const parser = new AllureResultsParser('allure-results');
    expect(parser.parse()).toHaveLength(0);
  });

  it('calculates duration in seconds from start/stop', () => {
    mockFs.readdirSync.mockReturnValue(['abc-result.json'] as unknown as ReturnType<typeof fs.readdirSync>);
    mockFs.readFileSync.mockReturnValue(makeResult({ start: 1000, stop: 6000 }));
    const parser = new AllureResultsParser('allure-results');
    const failures = parser.parse();
    expect(failures[0].duration).toBe(5);
  });

  it('processes broken tests the same as failed', () => {
    mockFs.readdirSync.mockReturnValue(['abc-result.json'] as unknown as ReturnType<typeof fs.readdirSync>);
    mockFs.readFileSync.mockReturnValue(makeResult({ status: 'broken' }));
    const parser = new AllureResultsParser('allure-results');
    expect(parser.parse()).toHaveLength(1);
  });

  it('throws when results directory does not exist', () => {
    mockFs.existsSync.mockReturnValue(false);
    const parser = new AllureResultsParser('missing-dir');
    expect(() => parser.parse()).toThrow('missing-dir');
  });

  it('skips unreadable result files without crashing', () => {
    mockFs.readdirSync.mockReturnValue(['bad-result.json'] as unknown as ReturnType<typeof fs.readdirSync>);
    mockFs.readFileSync.mockImplementation(() => { throw new Error('permission denied'); });
    const parser = new AllureResultsParser('allure-results');
    expect(parser.parse()).toHaveLength(0);
  });
});
