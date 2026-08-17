import { describe, expect, it } from 'vitest';
import { parseCargoSyntax } from './cargoSyntax.js';

describe('parseCargoSyntax', () => {
  it.each([
    ['/repo junkyard22/Orca', 'repo', 'junkyard22/Orca'],
    ['/file open ARCHITECTURE.md', 'file', 'ARCHITECTURE.md'],
    ['/task create #142', 'task', '#142'],
    ['/connect github', 'connect', 'github'],
  ])('parses %s', (input, name, argument) => {
    expect(parseCargoSyntax(input).command).toEqual({ name, argument });
  });

  it('parses context and status commands without arguments', () => {
    expect(parseCargoSyntax('/context').command).toEqual({ name: 'context' });
    expect(parseCargoSyntax('/status').command).toEqual({ name: 'status' });
  });

  it('extracts line-oriented resource references and preserves the request', () => {
    expect(parseCargoSyntax([
      '@repo junkyard22/Orca',
      '@file ARCHITECTURE.md',
      '@task #142',
      '@connector github',
      'Review these resources.',
    ].join('\n'))).toEqual({
      message: 'Review these resources.',
      references: [
        { kind: 'repository', value: 'junkyard22/Orca' },
        { kind: 'file', value: 'ARCHITECTURE.md' },
        { kind: 'task', value: '#142' },
        { kind: 'connector', value: 'github' },
      ],
    });
  });

  it('does not treat an inline social mention as a Cargo reference', () => {
    const input = 'Ask @repo-maintainers whether this is ready.';
    expect(parseCargoSyntax(input)).toEqual({ message: input, references: [] });
  });

  it('does not consume a multiline request as one slash-command argument', () => {
    const input = '/file ARCHITECTURE.md\nReview it for drift.';
    expect(parseCargoSyntax(input)).toEqual({ message: input, references: [] });
  });
});
