import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';
import { AddressInfo } from 'net';
import { loadConfig } from '../src/config';
import { DefectReporter } from '../src/reporter/DefectReporter';

/**
 *   npm run showcase
 *
 * Runs defect-bridge for real on a copy of examples/allure-results, against a
 * small stand-in for Jira and GitHub on localhost, so every path is visible
 * without credentials:
 *   DEFECT-123 is Done        → its failing test is a regression, ticket reopened
 *   DEFECT-118 is In Progress → its passing test gets "passing again"
 *   GitHub #7 is open         → its failing test is a known defect
 *   one untagged failure      → new failure
 *
 * The results land in showcase/allure-results with categories written, ready
 * for `allure generate`. CI publishes that report to GitHub Pages.
 */
const OUT = 'showcase/allure-results';

const tickets: Record<string, { status: string; category: string; comments: unknown[] }> = {
  'DEFECT-123': { status: 'Done', category: 'done', comments: [] },
  'DEFECT-118': { status: 'In Progress', category: 'indeterminate', comments: [] },
};
const transitions = [{ id: '1', name: 'Reopen', to: { name: 'To Do', statusCategory: { key: 'new' } } }];

function standIn(req: http.IncomingMessage, body: string): [number, unknown?] {
  const url = (req.url ?? '').split('?')[0];
  const jira = url.match(/^\/rest\/api\/3\/issue\/([A-Z]+-\d+)(\/\w+)?$/);

  if (jira && tickets[jira[1]]) {
    const [, key, sub] = jira;
    const t = tickets[key];
    if (!sub) {
      return [200, { key, fields: {
        summary: `Sample defect ${key}`,
        status: { name: t.status, statusCategory: { key: t.category } },
        priority: { name: 'High' },
        assignee: { displayName: 'QA Team' },
      } }];
    }
    if (sub === '/comment' && req.method === 'GET') return [200, { comments: t.comments.map((b) => ({ body: b })) }];
    if (sub === '/comment') { t.comments.unshift(JSON.parse(body).body); return [201, { id: String(t.comments.length) }]; }
    if (sub === '/attachments') return [200, []];
    if (sub === '/transitions' && req.method === 'GET') return [200, { transitions }];
    if (sub === '/transitions') { t.status = 'To Do'; t.category = 'new'; return [204]; }
  }

  if (url === '/repos/acme/todomvc/issues/7') return [200, { number: 7, title: 'Clear completed keeps items', state: 'open' }];
  if (url === '/repos/acme/todomvc/issues/7/comments') return req.method === 'GET' ? [200, []] : [201, { id: 1 }];
  return [404, {}];
}

async function main(): Promise<void> {
  fs.rmSync('showcase', { recursive: true, force: true });
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.cpSync('examples/allure-results', OUT, { recursive: true });

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const [status, reply] = standIn(req, body);
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(reply === undefined ? '' : JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const config = loadConfig(
      {
        JIRA_BASE_URL: url,
        JIRA_EMAIL: 'showcase@example.com',
        JIRA_API_TOKEN: 'stand-in',
        JIRA_REOPEN_TRANSITION: 'Reopen',
        GITHUB_TOKEN: 'stand-in',
        GITHUB_REPO: 'acme/todomvc',
        GITHUB_API_URL: url,
        ENV: 'showcase',
        CI_RUN_ID: process.env.GITHUB_RUN_NUMBER ?? 'local',
      },
      { resultsDir: OUT }
    );
    await new DefectReporter(config).run();
  } finally {
    server.close();
  }

  // Shown on the report's Overview, so nobody mistakes this for a real tracker
  fs.writeFileSync(
    path.join(OUT, 'environment.properties'),
    [
      'Tracker=Local stand-in for Jira and GitHub (no real tickets)',
      'Ticket.statuses=DEFECT-123 Done, DEFECT-118 In Progress, GitHub #7 open',
      'Source=github.com/KKoygun/defect-bridge (npm run showcase)',
    ].join('\n')
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
