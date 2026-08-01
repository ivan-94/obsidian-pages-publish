import { describe, expect, it } from 'vitest';
import {
  PAGES_PUBLISH_COMMANDS,
  PAGES_PUBLISH_FILE_ACTIONS,
} from '../src/plugin/safe-actions';

describe('safe global and Markdown actions', () => {
  it('exposes exactly the documented safe commands and no direct publication escape hatch', () => {
    expect(PAGES_PUBLISH_COMMANDS).toEqual([
      { id: 'open-publish-center', name: '打开发布中心' },
      { id: 'open-current-article-panel', name: '打开当前文章面板' },
      { id: 'preview-current-article', name: '预览当前文章' },
      { id: 'preview-site', name: '预览站点' },
      { id: 'change-current-article-visibility', name: '更改当前文章可见性' },
      { id: 'open-current-article-online-page', name: '打开当前文章线上页面' },
      { id: 'open-plugin-settings', name: '打开插件设置' },
    ]);
    expect(PAGES_PUBLISH_COMMANDS.map((action) => action.id)).not.toContain(
      'publish-current-article',
    );
  });

  it('keeps the Markdown context menu article-scoped and non-destructive', () => {
    expect(PAGES_PUBLISH_FILE_ACTIONS).toEqual([
      { id: 'open-article-panel', name: '打开当前文章面板' },
      { id: 'change-visibility', name: '更改可见性…' },
      { id: 'preview-article', name: '预览文章' },
      { id: 'open-online-page', name: '打开线上页面' },
    ]);
  });
});
