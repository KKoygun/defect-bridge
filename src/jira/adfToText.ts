interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
}

const textOf = (node: AdfNode): string => node.text ?? (node.content ?? []).map(textOf).join('');

/**
 * Renders the ADF nodes CommentBuilder uses as plain text, so a dry run shows
 * what the Jira comment will say without printing the raw JSON tree.
 */
export function adfToText(doc: AdfNode): string {
  const lines: string[] = [];

  for (const node of doc.content ?? []) {
    switch (node.type) {
      case 'rule':
        lines.push('─'.repeat(40));
        break;
      case 'table':
        for (const row of node.content ?? []) {
          const [key, value] = (row.content ?? []).map(textOf);
          lines.push(`${key.padEnd(12)} │ ${value}`);
        }
        break;
      case 'codeBlock':
        lines.push(...textOf(node).split('\n').map((line) => `  ${line}`));
        break;
      default:
        lines.push(textOf(node));
    }
  }

  return lines.join('\n');
}
