export interface PagesPublishActionDefinition {
  id: string;
  name: string;
}

/** Safe navigation and preview commands only; publication remains in its view. */
export const PAGES_PUBLISH_COMMANDS: readonly PagesPublishActionDefinition[] = [
  { id: 'open-publish-center', name: '打开发布中心' },
  { id: 'open-current-article-panel', name: '打开当前文章面板' },
  { id: 'preview-current-article', name: '预览当前文章' },
  { id: 'preview-site', name: '预览站点' },
  { id: 'change-current-article-visibility', name: '更改当前文章可见性' },
  { id: 'open-current-article-online-page', name: '打开当前文章线上页面' },
  { id: 'open-plugin-settings', name: '打开插件设置' },
];

/** Markdown-only menu actions. They never publish a document or a site. */
export const PAGES_PUBLISH_FILE_ACTIONS: readonly PagesPublishActionDefinition[] = [
  { id: 'open-article-panel', name: '打开当前文章面板' },
  { id: 'change-visibility', name: '更改可见性…' },
  { id: 'preview-article', name: '预览文章' },
  { id: 'open-online-page', name: '打开线上页面' },
];

export function pagesPublishAction(id: string): PagesPublishActionDefinition {
  const action = [...PAGES_PUBLISH_COMMANDS, ...PAGES_PUBLISH_FILE_ACTIONS]
    .find((candidate) => candidate.id === id);
  if (!action) throw new Error(`Unknown Pages Publish action: ${id}`);
  return action;
}

type ArticleMenuActionState = { enabled: true } | { enabled: false; reason: string };

export function articleMenuAvailability(input: {
  article: boolean;
  environmentReady: boolean;
  onlineUrl?: string;
}): {
  visibility: ArticleMenuActionState;
  preview: ArticleMenuActionState;
  online: ArticleMenuActionState;
} {
  return {
    visibility: input.article
      ? { enabled: true }
      : { enabled: false, reason: '不在已配置的内容范围内' },
    preview: !input.environmentReady
      ? { enabled: false, reason: '本地发布环境尚未就绪' }
      : input.article
        ? { enabled: true }
        : { enabled: false, reason: '不在已配置的内容范围内' },
    online: input.onlineUrl
      ? { enabled: true }
      : { enabled: false, reason: '尚无线上页面' },
  };
}
