import { expect, it } from 'vitest';
import { adfToText } from '../jira/adfToText';
import { CommentBuilder } from '../jira/CommentBuilder';

it('renders the comment as readable text with every field from the ADF', () => {
  const comment = new CommentBuilder().build(
    { uuid: 'u1', scenarioName: 'Add a todo', errorMessage: 'boom\nsecond line', jiraTicket: 'PROJ-1' },
    'staging',
    '147'
  ) as { body: Parameters<typeof adfToText>[0] };

  const text = adfToText(comment.body);

  expect(text).toContain('Scenario     │ Add a todo');
  expect(text).toContain('CI Run       │ 147');
  expect(text).toContain('  boom\n  second line');
  expect(text).not.toContain('"type"');
});
