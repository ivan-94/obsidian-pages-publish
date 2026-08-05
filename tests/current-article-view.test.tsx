// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CurrentArticlePanelState } from '../src/publication/current-article-panel';

vi.mock('../src/ui/obsidian/obsidian-icon', () => ({
  ObsidianIcon({ icon }: { icon: string }) { return <span aria-hidden="true" data-icon={icon} />; },
}));

vi.mock('../src/ui/obsidian/obsidian-button', () => ({
  ObsidianButton({ ariaLabel, ariaPressed, className, disabled, label, onClick }: {
    ariaLabel?: string; ariaPressed?: boolean; className?: string; disabled?: boolean;
    label: string; onClick: () => void;
  }) {
    return <button aria-label={ariaLabel ?? label} aria-pressed={ariaPressed} class={className} disabled={disabled} onClick={onClick}>{label}</button>;
  },
}));

import {
  ArticleInspectorScreen,
  type ArticleInspectorScreenProps,
} from '../src/ui/article-inspector/article-inspector-screen';

afterEach(() => document.body.replaceChildren());

describe('ArticleInspectorScreen', () => {
  it('prioritizes identity, next-vs-online intent, frequent settings, and a stable preview dock', () => {
    const onEdit = vi.fn();
    const onVisibilityChange = vi.fn();
    render(<ArticleInspectorScreen {...screenProps({ onEdit, onVisibilityChange })} />);

    expect(screen.getByRole('heading', { name: 'Article title' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Pages Publish · 当前文章' })).toBeNull();
    expect(screen.queryByRole('button', { name: /固定/ })).toBeNull();
    expect(screen.getAllByText('/notes/article/', { selector: '.compare-block code' })).toHaveLength(2);
    expect(screen.getByRole('combobox', { name: '公开方式' })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(document.querySelector<HTMLButtonElement>('.pp-article-property-action--title')!);
    expect(onEdit).toHaveBeenCalledWith('title');
    fireEvent.change(screen.getByRole('combobox', { name: '公开方式' }), { target: { value: 'unlisted' } });
    expect(onVisibilityChange).toHaveBeenCalledWith('unlisted');
    expect(screen.getByRole('button', { name: '预览文章' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /发布站点/ })).toBeNull();
  });

  it('mounts only the active editor and preserves review-marked draft input', () => {
    const onDraftChange = vi.fn();
    render(<ArticleInspectorScreen {...screenProps({
      editor: {
        busy: false,
        draft: '未保存的新标题',
        field: 'title',
        needsReview: true,
        sourcePath: 'notes/article.md',
      },
      onDraftChange,
    })} />);

    const editor = screen.getByRole<HTMLInputElement>('textbox', { name: '标题显式覆盖' });
    expect(editor.value).toBe('未保存的新标题');
    expect(screen.getByText('草稿需要复核')).toBeTruthy();
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    fireEvent.input(editor, { target: { value: '复核后的标题' } });
    expect(onDraftChange).toHaveBeenCalledWith('复核后的标题');
  });

  it('sorts blockers before warnings and supplies impact plus location actions', () => {
    const state = articleState();
    state.contentIssues = [
      { severity: 'warning', dormant: false, sourcePath: 'notes/article.md', line: 42, column: 3, message: '私密文章引用会降级。', impact: '发布后只保留显示文字。' },
      { severity: 'blocker', dormant: false, sourcePath: 'notes/article.md', line: 28, column: 1, message: '私密图片不可发布。', impact: '发布被阻塞。' },
    ] as never;
    state.route.issues = [{ severity: 'warning', code: 'redirect-review', sourcePath: 'notes/article.md', route: '/notes/article/', message: '旧地址需要确认。' }] as never;
    render(<ArticleInspectorScreen {...screenProps({ state })} />);

    const issues = Array.from(document.querySelectorAll<HTMLElement>('.pp-issue'));
    expect(issues).toHaveLength(3);
    expect(issues[0]?.textContent).toContain('阻塞 · 第 28 行');
    expect(issues[0]?.textContent).toContain('发布被阻塞。');
    expect(issues.every((issue) => issue.querySelector('button')?.textContent === '定位')).toBe(true);
  });

  it.each([
    [{ status: 'no-active' }, '当前没有活动文章', undefined],
    [{ status: 'out-of-scope', selection: 'active', sourcePath: 'drafts/a.md' }, '此文章不在内容范围内', '打开内容范围设置'],
    [{ status: 'no-site', sourcePath: 'notes/a.md' }, '尚未创建发布站点', '开始设置'],
    [{ status: 'config-error', sourcePath: 'notes/a.md', message: '第 18 行错误' }, '站点配置无效，发布功能已暂停', '打开并定位'],
    [{ status: 'missing-pinned', sourcePath: 'notes/moved.md' }, '指定的文章已移动或删除', undefined],
  ] as const)('renders a truthful empty state: %s', (state, title, action) => {
    render(<ArticleInspectorScreen {...screenProps({ state: state as CurrentArticlePanelState })} />);
    expect(screen.getByRole('heading', { name: title })).toBeTruthy();
    if (action) expect(screen.getByRole('button', { name: action })).toBeTruthy();
  });
});

function screenProps(overrides: Partial<ArticleInspectorScreenProps> = {}): ArticleInspectorScreenProps {
  return {
    environmentReady: true,
    externalLinkResults: [],
    loading: false,
    state: articleState(),
    onCancelEdit: () => undefined,
    onCheckExternalLinks: () => undefined,
    onDraftChange: () => undefined,
    onEdit: () => undefined,
    onEmptyAction: () => undefined,
    onLegacyMigration: () => undefined,
    onLocateContentIssue: () => undefined,
    onLocateRouteIssue: () => undefined,
    onOpenOnline: () => undefined,
    onOpenPublishCenter: () => undefined,
    onPreview: () => undefined,
    onRecheck: () => undefined,
    onRepairEnvironment: () => undefined,
    onSaveEdit: () => undefined,
    onVisibilityChange: () => undefined,
    ...overrides,
  };
}

function articleState() {
  return {
    status: 'article' as const,
    selection: 'active' as const,
    sourcePath: 'notes/article.md',
    contentRootPath: 'notes',
    publicationState: 'updated' as const,
    currentSourceDigest: 'current',
    sitePublicationFailed: false,
    dependencies: { images: 0, notes: 0, externalLinks: 0 },
    contentIssues: [] as NonNullable<Extract<CurrentArticlePanelState, { status: 'article' }>['contentIssues']>,
    route: { pendingUrl: '/notes/article/', onlineUrl: '/notes/article/', redirects: [], issues: [] as NonNullable<Extract<CurrentArticlePanelState, { status: 'article' }>['route']['issues']> },
    metadata: {
      visibility: { value: 'public' as const, source: 'publication.visibility' as const },
      slug: { value: 'article', source: 'filename' as const },
      redirects: { value: [], source: 'default' as const },
      title: { value: 'Article title', source: 'first-h1' as const },
      summary: { value: 'Article summary', source: 'body-summary' as const },
      date: { value: '2026-08-01', source: 'frontmatter.date' as const },
      updated: { value: '2026-08-01', source: 'publication.updated' as const },
      tags: { value: ['obsidian', 'publish'], source: 'frontmatter.tags' as const },
      cover: { value: '未设置', source: 'publication.cover' as const },
      kind: { value: 'article' as const, source: 'default' as const },
      order: undefined,
      deployment: { url: '/notes/article/', firstPublishedAt: '2026-07-31T10:00:00.000Z', lastPublishedAt: '2026-08-01T10:00:00.000Z', sourceDigest: 'deployed', deploymentId: 'deployment-1' },
    },
  };
}
