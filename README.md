# defect-bridge

[![Test](https://github.com/KKoygun/defect-bridge/actions/workflows/test.yml/badge.svg)](https://github.com/KKoygun/defect-bridge/actions/workflows/test.yml)

When a test fails, the question everyone asks is whether it is already tracked.
defect-bridge makes that answerable directly from the Allure report — no ticket
searching, no manual updates.

defect-bridge runs as the final CI step after each test execution. It reads
the Allure results, finds every failed scenario tagged with a Jira defect key,
and posts the full failure detail — error, stack trace, screenshot — as a
timestamped comment on that ticket. Every run. Automatically.

The result:
- **Instant visibility** — the Allure report links directly to the Jira defect,
  making the failure context and tracking status clear at a glance
- **Defect tickets stay current** — each run appends to the ticket history
  without manual intervention
- **Leaner CI artifacts** — failure history lives in Jira, so allure-results
  artifact retention can be cut to the minimum needed for the current report

---

## How it works

**1. Tag your failing scenario with the Jira defect ticket key:**

```gherkin
@smoke @allure.label.issue=DEFECT-123
Scenario: Add a todo item
  Given I am on the application
  ...
```

**2. Run your tests.** Your Allure adapter generates result files in `allure-results/`.

**3. Run defect-bridge:**

```bash
npm run report
```

**4. The linked Jira ticket receives a comment automatically:**

```
🔴 Automated Test is Failing

Scenario     │ Add a todo item
Feature      │ TodoMVC Task Management > Add a todo item
Environment  │ staging
Duration     │ 3s
Timestamp    │ 2026-04-05 14:32:00 UTC
CI Run       │ #147

Error:
  Locator.fill: Error: strict mode violation: locator('.new-todo')
  resolved to 2 elements.

Stack Trace:
  at TodoPage.addTodo (src/pages/TodoPage.ts:24:5)
  at World. (src/steps/todo.steps.ts:18:3)
```

If a screenshot attachment is present in the Allure result, it is attached to the Jira comment automatically.

---

## Project structure

```
src/
├── allure/
│   ├── AllureResultsParser.ts   # Reads result JSONs, extracts failures with @issue tags
│   └── types.ts                 # Allure result type definitions
├── jira/
│   ├── JiraClient.ts            # Jira REST API v3: verify ticket, post comment, attach file
│   └── CommentBuilder.ts        # Builds structured ADF comment body
├── reporter/
│   └── DefectReporter.ts        # Orchestrates: parse → verify → comment → attach → summarise
└── config.ts                    # Reads and validates environment variables

scripts/
└── run.ts                       # CLI entry point

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
- Node.js 20+
- Jira Cloud account
- Jira API token — generate at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens)

### Install

```bash
git clone https://github.com/KKoygun/defect-bridge
cd defect-bridge
npm install
cp .env.example .env
```

### Configure `.env`

```env
JIRA_BASE_URL=https://yourworkspace.atlassian.net
JIRA_EMAIL=your@email.com
JIRA_API_TOKEN=your_api_token_here
ENV=staging
```

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

# Point at a different results directory
ALLURE_RESULTS_DIR=../my-project/allure-results npm run report

# Generate and open the Allure HTML report
npm run allure:generate
npm run allure:open
```

---

## Tagging scenarios

Use `@allure.label.issue=TICKET-KEY` on any scenario linked to a known defect:

```gherkin
@regression @allure.label.issue=PROJ-123
Scenario: Checkout fails on payment step
  ...
```

**What gets processed and what gets skipped:**

| Scenario state | Has `@allure.label.issue` | Action |
|---|---|---|
| Failed / Broken | Yes | Comment posted to Jira ticket |
| Failed / Broken | No | Skipped — no Jira interaction |
| Passed | Yes | Skipped — only failures are reported |
| Any | Ticket not found in Jira | Warning logged, skipped |

---

## CI / CD

### GitHub Actions

The included workflow triggers after any other workflow completes and posts failures to Jira automatically. Add these to your repository secrets (**Settings → Secrets and variables → Actions**):

| Secret | Value |
|---|---|
| `JIRA_BASE_URL` | `https://yourworkspace.atlassian.net` |
| `JIRA_EMAIL` | Your Jira account email |
| `JIRA_API_TOKEN` | API token from id.atlassian.com |

### Integrate into your existing test pipeline

Add as the final step in any workflow that uploads `allure-results` as an artifact:

```yaml
- name: Post failures to Jira
  run: npm run report
  env:
    JIRA_BASE_URL:  ${{ secrets.JIRA_BASE_URL }}
    JIRA_EMAIL:     ${{ secrets.JIRA_EMAIL }}
    JIRA_API_TOKEN: ${{ secrets.JIRA_API_TOKEN }}
    ENV:            staging
```

---

## Security

- Store `JIRA_API_TOKEN` in CI secrets — never in source code or committed `.env` files
- The `.env` file is excluded from git via `.gitignore`
- Rotate your API token periodically at [id.atlassian.com](https://id.atlassian.com/manage-profile/security/api-tokens)
- The token only needs **Comment** and **Attachment** permissions on the relevant Jira project

---

## Related repositories

| Repository | Description |
|---|---|
| [Playwright-cucumber-ai-framework](https://github.com/KKoygun/Playwright-cucumber-ai-framework) | UI automation + Cucumber BDD + AI agents (Healer, Planner, Generator) |
| [playwright-api-framework](https://github.com/KKoygun/playwright-api-framework) | REST API test framework with Zod schema validation and Allure reporting |
