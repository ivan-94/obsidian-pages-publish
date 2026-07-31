import { describe, expect, it } from 'vitest';
import MarkdownIt from 'markdown-it';
import {
  inspectNoteReferences,
  installNoteReferenceRule,
} from '../src/content/note-references';
import {
  readArticleSnapshotFromSource,
  type ArticleSourceSnapshot,
} from '../src/publication/article-metadata';

describe('note reference inspection', () => {
  it('advances safely when Markdown probes Wiki syntax inside a link label', () => {
    const markdown = new MarkdownIt({ html: false });
    installNoteReferenceRule(markdown);

    expect(() =>
      markdown.render(
        '[label [[target|wiki]]](https://example.com) and ![alt [[target]]](x.png)',
      ),
    ).not.toThrow();
  });

  it('reports occurrence-aware columns for repeated references on one line', () => {
    const snapshot = readArticleSnapshotFromSource(
      'notes/source.md',
      '---\npublication:\n  visibility: public\n---\n# Source\n\n`[[same]]` then [[same]] and [[same]]\n',
    );

    const issues = inspectNoteReferences(
      new Map([[snapshot.sourcePath, snapshot]]),
    );

    expect(issues.map(({ line, column }) => ({ line, column }))).toEqual([
      { line: 7, column: 17 },
      { line: 7, column: 30 },
    ]);
  });

  it('bounds a very deep acyclic embed graph without overflowing the call stack', () => {
    const snapshots = new Map<string, ArticleSourceSnapshot>();
    const base = readArticleSnapshotFromSource(
      'notes/base.md',
      '---\npublication:\n  visibility: public\n---\n# Base\n',
    );
    for (let index = 0; index < 6_000; index += 1) {
      const sourcePath = `notes/note-${index}.md`;
      const body =
        index === 5_999 ? '# End\n' : `![[note-${index + 1}|next]]\n`;
      snapshots.set(sourcePath, {
        ...base,
        sourcePath,
        source: body,
        body,
        bodyStartLine: 1,
        revision: String(index),
      });
    }

    const issues = inspectNoteReferences(snapshots);

    expect(
      issues.some(
        (issue) =>
          issue.severity === 'warning' &&
          issue.code === 'embed-expansion-limit' &&
          /^notes\/note-\d+\.md$/u.test(issue.sourcePath) &&
          issue.impact ===
            'Nested note content will stop at the safe expansion limit.',
      ),
    ).toBe(true);
  });

  it('locates expansion exhaustion using the renderer\'s depth-first source order', () => {
    const sources = new Map([
      [
        'notes/root.md',
        '---\npublication:\n  visibility: public\n---\n# Root\n\n![[a|A_FALLBACK]]\n![[b|B_FALLBACK]]\n',
      ],
      [
        'notes/a.md',
        `---\npublication:\n  visibility: public\n---\n# A\n\n${'![[leaf|LEAF_FALLBACK]]\n'.repeat(255)}`,
      ],
      [
        'notes/b.md',
        '---\npublication:\n  visibility: public\n---\n# B\n\nB_PAYLOAD\n',
      ],
      [
        'notes/leaf.md',
        '---\npublication:\n  visibility: public\n---\n# Leaf\n\nLEAF_PAYLOAD\n',
      ],
    ]);
    const snapshots = new Map(
      [...sources].map(([sourcePath, source]) => {
        const snapshot = readArticleSnapshotFromSource(sourcePath, source);
        return [sourcePath, snapshot];
      }),
    );

    const limitIssues = inspectNoteReferences(snapshots).filter(
      (issue) => issue.code === 'embed-expansion-limit',
    );

    expect(limitIssues).toContainEqual(
      expect.objectContaining({
        sourcePath: 'notes/root.md',
        line: 8,
        column: 1,
      }),
    );
    expect(limitIssues).not.toContainEqual(
      expect.objectContaining({ sourcePath: 'notes/a.md' }),
    );
  });

  it('keeps private-root expansion warnings dormant until the root is selected', () => {
    const target = readArticleSnapshotFromSource(
      'notes/target.md',
      '---\npublication:\n  visibility: public\n---\n# Target\n',
    );
    const sourceBody = `${'![[target|bounded embed]]\n'.repeat(300)}`;
    const inspectSource = (visibility: 'private' | 'unlisted') => {
      const source = readArticleSnapshotFromSource(
        'notes/source.md',
        `---\npublication:\n  visibility: ${visibility}\n---\n# Source\n\n${sourceBody}`,
      );
      return inspectNoteReferences(
        new Map([
          [source.sourcePath, source],
          [target.sourcePath, target],
        ]),
      ).filter(
        (issue) =>
          issue.code === 'embed-expansion-limit' &&
          issue.sourcePath === source.sourcePath,
      );
    };

    expect(inspectSource('private')).toContainEqual(
      expect.objectContaining({ dormant: true }),
    );
    expect(inspectSource('unlisted')).toContainEqual(
      expect.objectContaining({ dormant: false }),
    );
  });
});
