import { describe, expect, it } from 'vitest';
import {
  articleContentIssueLabel,
  articleIntentEditorFields,
  LatestCurrentArticleProjection,
} from '../src/plugin/current-article-controller';
import type {
  CurrentArticleContext,
  CurrentArticlePanelState,
} from '../src/publication/current-article-panel';

describe('latest current article projection', () => {
  it('discards a slower old article after a newer active article resolves', async () => {
    const pending = new Map<
      string,
      (state: CurrentArticlePanelState) => void
    >();
    const projection = new LatestCurrentArticleProjection(
      (context: CurrentArticleContext) =>
        new Promise<CurrentArticlePanelState>((resolve) => {
          pending.set(context.activePath ?? '', resolve);
        }),
    );

    const older = projection.resolve({ activePath: 'notes/a.md' });
    const newer = projection.resolve({ activePath: 'notes/b.md' });
    pending.get('notes/b.md')?.({ status: 'no-active' });
    await expect(newer).resolves.toEqual({ status: 'no-active' });
    pending.get('notes/a.md')?.({
      status: 'non-markdown',
      selection: 'active',
      sourcePath: 'notes/a.md',
    });
    await expect(older).resolves.toBeUndefined();
  });

  it('offers an editor for every non-visibility v1 publication intent field', () => {
    expect(articleIntentEditorFields.map((field) => field.name)).toEqual([
      'title',
      'summary',
      'slug',
      'date',
      'updated',
      'tags',
      'cover',
      'kind',
      'order',
      'redirects',
    ]);
  });

  it('does not downgrade a blocking article issue to a warning label', () => {
    expect(articleContentIssueLabel({ severity: 'blocker', dormant: false }))
      .toBe('阻塞');
    expect(articleContentIssueLabel({ severity: 'warning', dormant: false }))
      .toBe('警告');
    expect(articleContentIssueLabel({ severity: 'warning', dormant: true }))
      .toBe('休眠警告');
  });
});
