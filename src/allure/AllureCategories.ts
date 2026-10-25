import * as fs from 'fs';
import * as path from 'path';

/**
 * Groups failures in the Allure report's Categories tab by what defect-bridge
 * found on the linked ticket.
 *
 * Allure matches categories on the status and error message only, so the
 * message of each tagged failure gets a short prefix, e.g.
 *   [Known defect DEFECT-123 · In Progress] locator.fill: Timeout 5000ms exceeded.
 *   [Regression DEFECT-123 · Done] locator.fill: Timeout 5000ms exceeded.
 * and categories.json matches on that prefix. Untagged failures have none and
 * land in "New failure".
 *
 * Regexes use [\s\S] instead of (?s) so they work in Allure 2 (Java) and Allure 3 (JS).
 * Allure 2 matches the whole message and puts a result in every category it
 * matches, hence the lookahead in the last one.
 */
export type FailureKind = 'known' | 'regression';

const PREFIX = /^\[(?:Known defect|Regression) [^\]\n]*\] /;

const CATEGORIES = [
  {
    name: 'Regression (linked ticket is closed)',
    matchedStatuses: ['failed', 'broken'],
    messageRegex: '\\[Regression [\\s\\S]*',
  },
  {
    name: 'Known defect',
    matchedStatuses: ['failed', 'broken'],
    messageRegex: '\\[Known defect [\\s\\S]*',
  },
  {
    name: 'New failure (no defect linked)',
    matchedStatuses: ['failed', 'broken'],
    messageRegex: '(?!\\[(?:Known defect|Regression) )[\\s\\S]*',
  },
];

/** The message without a prefix from an earlier defect-bridge run on the same results. */
export function stripCategoryPrefix(message: string): string {
  return message.replace(PREFIX, '');
}

/** Rewrites the message in one result file. A prefix from an earlier run is replaced, not stacked. */
export function labelFailure(resultFile: string, kind: FailureKind, ref: string, status?: string): void {
  const result = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
  const prefix = `[${kind === 'regression' ? 'Regression' : 'Known defect'} ${ref}${status ? ` · ${status}` : ''}] `;
  const message = stripCategoryPrefix(result.statusDetails?.message ?? '');
  result.statusDetails = { ...result.statusDetails, message: prefix + message };
  fs.writeFileSync(resultFile, JSON.stringify(result));
}

/** Writes categories.json, keeping categories the project already defines. */
export function writeCategories(resultsDir: string): void {
  const file = path.join(resultsDir, 'categories.json');
  const ours = new Set(CATEGORIES.map((c) => c.name));

  let existing: Array<{ name?: string }> = [];
  if (fs.existsSync(file)) {
    try {
      existing = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } catch {
      console.warn(`[Categories] Could not read ${file} — replacing it`);
    }
  }

  const kept = existing.filter((c) => !ours.has(c.name ?? ''));
  fs.writeFileSync(file, JSON.stringify([...CATEGORIES, ...kept], null, 2));
}
