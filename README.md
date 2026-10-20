# defect-bridge

[![Test](https://github.com/KKoygun/defect-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/KKoygun/defect-bridge/actions/workflows/test.yml)
[![Action](https://github.com/KKoygun/defect-bridge/actions/workflows/action.yml/badge.svg)](https://github.com/KKoygun/defect-bridge/actions/workflows/action.yml)

When a test fails, the question everyone asks is whether it is already tracked.
defect-bridge makes that answerable directly from the Allure report — no ticket
searching, no manual updates.

defect-bridge runs as the final CI step after each test execution. It reads
the Allure results, finds every failed scenario tagged with a defect key,
and posts the full failure detail — error, stack trace, screenshot — as a
timestamped comment on that ticket. Every run. Automatically.

The result:
- **Instant visibility** — the Allure report links directly to the Jira defect,
  making the failure context and tracking status clear at a glance
- **Defect tickets stay current** — each run appends to the ticket history
  without manual intervention
- **Leaner CI artifacts** — failure history lives in Jira, so allure-results
  artifact retention can be cut to the minimum needed for the current report

Works with **Jira Cloud**, **Jira Data Center** and **GitHub Issues**.

---

## How it works

**1. Tag your failing scenario with the defect key:**

```gherkin
@smoke @allure.label.issue=DEFECT-123
Scenario: Add a single todo item
  Given I am on the application
  ...
```

Use `@allure.label.github_issue=7` to link a GitHub issue instead (or as well).

**2. Run your tests.** Your Allure adapter generates result files in `allure-results/`.

**3. Run defect-bridge** — `npm run report`, or the [GitHub Action](#use-it-as-a-github-action).

**4. The linked ticket receives a comment.** This is the real dry-run output for the results in [`examples/allure-results`](examples/allure-results) (`npm run example` with `ENV=staging CI_RUN_ID=147`):

```
[DEFECT-123] Add a single todo item
  [DRY RUN] Jira comment for DEFECT-123:
    │ 🔴 Automated Test is Failing
    │ ────────────────────────────────────────
    │ Scenario     │ Add a single todo item
    │ Feature      │ TodoMVC Task Management > Add a single todo item
    │ Environment  │ staging
    │ Duration     │ 6s
    │ Timestamp    │ 2026-10-20 09:10:56 UTC
    │ CI Run       │ 147
    │ ────────────────────────────────────────
    │ Error
    │   locator.fill: Timeout 5000ms exceeded.
    │   Call log:
    │     - waiting for locator('.new-todo')
    │ Stack Trace
    │   at TodoPage.addTodo (src/pages/TodoPage.ts:42:24)
    │   at CustomWorld.<anonymous> (src/steps/todo.steps.ts:22:3)
    │ ────────────────────────────────────────
    │ 📎 Screenshot attached to this comment if available.
    │ defect-bridge:run=147;test=c1a8e2f7a9b14d3e
  [DRY RUN] Would attach examples\allure-results\3f1c2a10-attachment.png

[GH#7] Clear all completed todos
  [DRY RUN] GitHub comment for #7:
    │ ## 🔴 Automated Test Failure
    │
    │ | Field | Value |
    │ |---|---|
    │ | **Scenario** | Clear all completed todos |
    │ | **Feature** | TodoMVC Task Management > Clear all completed todos |
    │ | **Environment** | `staging` |
    │ | **Duration** | 2s |
    │ | **Timestamp** | 2026-10-20T09:10:56.204Z |
    │ | **CI Run** | `147` |
    │
    │ ### Error
    │
    │ ```
    │ expect(locator).toHaveCount(expected) failed
    │
    │ Locator: locator('.todo-list li')
    │ Expected: 1
    │ Received: 2
    │ ```
    │
    │ <details>
    │ <summary>Stack Trace</summary>
    │
    │ ```
    │ at CustomWorld.<anonymous> (src/steps/todo.steps.ts:55:5)
    │ ```
    │ </details>
    │
    │ ---
    │ _Posted automatically by **defect-bridge**_
    │ <!-- defect-bridge:run=147;test=5e93b0c4d2a7f611 -->

──────────────────────────────────────────────────────
defect-bridge summary [DRY RUN]
  Previewed : 2
──────────────────────────────────────────────────────
```

The example folder also holds a passed test and an untagged failure; both are skipped. On Jira Cloud the comment is sent as Atlassian Document Format (shown above as text) and the screenshot is attached to the ticket.

<details>
<summary>The same Jira comment on Data Center (<code>JIRA_FLAVOR=datacenter</code>)</summary>

```
h3. (x) Automated Test is Failing
----
*Scenario:* Add a single todo item
*Feature:* TodoMVC Task Management > Add a single todo item
*Environment:* staging
*Duration:* 6s
*Timestamp:* 2026-10-20 09:10:58 UTC
*CI Run:* 147
----
h4. Error
{code}
locator.fill: Timeout 5000ms exceeded.
Call log:
  - waiting for locator('.new-todo')
{code}
h4. Stack Trace
{code}
at TodoPage.addTodo (src/pages/TodoPage.ts:42:24)
at CustomWorld.<anonymous> (src/steps/todo.steps.ts:22:3)
{code}
----
_Screenshot attached to this comment if available._
{{defect-bridge:run=147;test=c1a8e2f7a9b14d3e}}
```

Data Center gets wiki markup and no emoji, since older Data Center databases (MySQL without utf8mb4) reject them.

</details>

---

## Use it as a GitHub Action

```yaml
- name: Post failures to Jira
  if: failure()
  uses: KKoygun/defect-bridge@master   # pin to a release tag once one exists
  with:
    allure-results: allure-results
    env: staging
    jira-base-url:  ${{ secrets.JIRA_BASE_URL }}
    jira-email:     ${{ secrets.JIRA_EMAIL }}
    jira-api-token: ${{ secrets.JIRA_API_TOKEN }}
```

Jira Data Center:

```yaml
  with:
    jira-flavor: datacenter
    jira-base-url: https://jira.bank.internal
    jira-pat: ${{ secrets.JIRA_PAT }}
```

An internal Data Center instance is usually only reachable from a self-hosted runner.

GitHub Issues (give the job `permissions: issues: write`):

```yaml
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

Other inputs: `dry-run`, `fail-on-report-error`, `github-repo` (defaults to the current repo). See [`action.yml`](action.yml). The [Action workflow](.github/workflows/action.yml) runs the action on the example results in dry-run mode on every push.

---

## Behaviour

**Retries** — rate limits (429), server errors (5xx) and dropped connections are retried with exponential backoff (1s, 2s, 4s), honouring `Retry-After`. Other errors (400, 401, 403) fail at once.

**No duplicate comments** — each comment carries a marker made of the CI run id and the test's Allure `historyId`. Before posting, defect-bridge looks for that marker on the ticket, so re-running the same CI run does not comment twice. A new run comments again. Without a run id (`CI_RUN_ID` or `GITHUB_RUN_NUMBER`) the check is off.

**Exit codes**

| Code | When |
|---|---|
| `0` | Done. A ticket that could not be updated is logged as an error but does not fail the build. |
| `1` | Some tickets could not be updated and `FAIL_ON_REPORT_ERROR=true`. |
| `2` | Bad configuration or unreadable results directory — nothing was reported. |

A Jira outage should not turn a red test run into a confusing pipeline failure; misconfiguration should be loud.

**Job summary** — inside GitHub Actions the outcome is also written to the run's summary page.

---

## Project structure

```
src/
├── allure/
│   ├── AllureResultsParser.ts   # Reads result JSONs, extracts failures with @issue tags
│   └── types.ts                 # Allure result type definitions
├── jira/
│   ├── JiraClient.ts            # JiraClient interface + Cloud (API v3) and Data Center (API v2) clients
│   ├── CommentBuilder.ts        # Cloud comment in Atlassian Document Format
│   ├── WikiCommentBuilder.ts    # Data Center comment in wiki markup
│   └── adfToText.ts             # Renders ADF as text for --dry-run
├── github/
│   ├── GitHubClient.ts          # Issues API: verify issue, find marker, post comment
│   └── GitHubCommentBuilder.ts  # Markdown comment
├── http/
│   └── retry.ts                 # Backoff for 429 / 5xx / dropped connections
├── reporter/
│   └── DefectReporter.ts        # Orchestrates: parse → verify → dedupe → comment → attach → summarise
├── config.ts                    # Reads and validates environment variables (Zod)
└── __tests__/                   # Vitest unit tests; HTTP tests use a local fake server

scripts/run.ts                   # CLI entry point
action.yml                       # Composite GitHub Action
examples/allure-results/         # Small fixture for npm run example
allure.properties.example        # Copy to allure-results/ to enable clickable Jira links
```

---

## Framework compatibility

Works with any framework that produces standard `allure-results/*.json` files:

| Framework | Allure adapter |
|---|---|
| Playwright + Cucumber | `allure-cucumberjs` |
| Playwright native runner | `allure-playwright` |
| Selenium + JUnit | `allure-java` |

Companion UI automation repo using `allure-cucumberjs`: [Playwright-cucumber-ai-framework](https://github.com/KKoygun/Playwright-cucumber-ai-framework)

---

## Setup

### Prerequisites
- Node.js 22+
- Jira Cloud (API token from [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens)), Jira Data Center (personal access token), and/or a GitHub token

### Install

```bash
git clone https://github.com/KKoygun/defect-bridge
cd defect-bridge
npm install
cp .env.example .env
```

### Configure `.env`

| Variable | Needed for | Notes |
|---|---|---|
| `JIRA_FLAVOR` | Jira | `cloud` (default) or `datacenter` |
| `JIRA_BASE_URL` | Jira | e.g. `https://yourworkspace.atlassian.net` |
| `JIRA_EMAIL`, `JIRA_API_TOKEN` | Jira Cloud | |
| `JIRA_PAT` | Jira Data Center | Personal access token |
| `GITHUB_TOKEN`, `GITHUB_REPO` | GitHub Issues | `GITHUB_REPO` as `owner/repo` |
| `GITHUB_API_URL` | GitHub Enterprise Server | Set automatically inside GitHub Actions |
| `ALLURE_RESULTS_DIR` | | Default `allure-results` |
| `ENV` | | Label shown in comments, default `dev` |
| `CI_RUN_ID` | | Falls back to `GITHUB_RUN_NUMBER`; enables the duplicate check |
| `FAIL_ON_REPORT_ERROR` | | `true` to exit 1 when a ticket could not be updated |

Settings are validated at start-up and a wrong one is named in the error, e.g. `jira.email: JIRA_EMAIL must be a valid email address`.

### Enable clickable Jira links in Allure report

Copy the provided example into your `allure-results/` directory and update the URL:

```bash
cp allure.properties.example allure-results/allure.properties
# then edit the URL inside to match your Jira workspace
```

---

## Running

```bash
# Run defect-bridge (reads from allure-results/ by default)
npm run report

# Print the comments instead of posting them — no credentials needed
npm run report -- --dry-run

# Point at a different results directory
npm run report -- --results-dir=../my-project/allure-results

# Dry run on the bundled example results
npm run example
```

---

## Tagging scenarios

Use `@allure.label.issue=TICKET-KEY` for Jira and `@allure.label.github_issue=NUMBER` for GitHub:

```gherkin
@regression @allure.label.issue=PROJ-123
Scenario: Checkout fails on payment step
  ...
```

**What gets processed and what gets skipped:**

| Scenario state | Tagged | Action |
|---|---|---|
| Failed / Broken | Yes | Comment posted to the ticket |
| Failed / Broken | No | Skipped — no tracker interaction |
| Passed | Yes | Skipped — only failures are reported |
| Any | Ticket not found | Warning logged, skipped |
| Any | Already commented in this CI run | Skipped as a duplicate |

---

## Tests

```bash
npm run test:unit
npm run typecheck
```

Unit tests cover the parser edge cases, the ADF comment (snapshot), both Jira clients and the GitHub client over real HTTP against a local fake server (auth failure, missing ticket, attachment upload, marker lookup), retries, the duplicate check across two runs, and the CLI exit codes. Nothing calls a real tracker.

---

## Security

- Store tokens in CI secrets — never in source code or committed `.env` files
- The `.env` file is excluded from git via `.gitignore`
- Rotate your API token periodically at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens)
- The token only needs **Comment** and **Attachment** permissions on the relevant Jira project (Data Center: **Browse**, **Add Comments**, **Create Attachments**)

---

## Related repositories

| Repository | Description |
|---|---|
| [Playwright-cucumber-ai-framework](https://github.com/KKoygun/Playwright-cucumber-ai-framework) | UI automation + Cucumber BDD + AI agents (Healer, Planner, Generator) |
| [playwright-api-framework](https://github.com/KKoygun/playwright-api-framework) | REST API test framework with Zod schema validation, Pact and Allure reporting |
