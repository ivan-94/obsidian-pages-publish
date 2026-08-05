// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PublishCenterScreenProps } from '../src/ui/publish-center/publish-center-screen';

vi.mock('../src/ui/obsidian/obsidian-icon', () => ({
  ObsidianIcon({ icon }: { icon: string }) { return <span aria-hidden="true" data-icon={icon} />; },
}));
vi.mock('../src/ui/obsidian/obsidian-button', () => ({
  ObsidianButton({ disabled, label, onClick }: { disabled?: boolean; label: string; onClick: () => void }) { return <button disabled={disabled} onClick={onClick}>{label}</button>; },
}));

import { PublishCenterScreen } from '../src/ui/publish-center/publish-center-screen';

afterEach(() => document.body.replaceChildren());

describe('PublishCenterScreen', () => {
  it('answers what changes, what blocks, and whether publishing is safe above the workbench', () => {
    render(<PublishCenterScreen {...props()} />);
    expect(screen.getByRole('heading', { name: 'Demo Wiki' })).toBeTruthy();
    expect(screen.getByRole('region', { name: '发布快照' }).textContent).toContain('2');
    expect(document.querySelector('.pc-gate.is-required')?.textContent).toContain('当前问题阻止发布');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: '发布站点（不可用）' }).disabled).toBe(true);
  });

  it('uses a real table, chevron review affordance, and quick inclusion toggle', () => {
    const onChangeInclusion = vi.fn();
    const onSelectArticle = vi.fn();
    render(<PublishCenterScreen {...props({ activeTab: 'all', onChangeInclusion, onSelectArticle })} />);
    expect(screen.getByRole('columnheader', { name: '文章' })).toBeTruthy();
    const checkbox = screen.getByRole<HTMLInputElement>('checkbox', { name: '下一版包含 Clean article' });
    fireEvent.click(checkbox);
    expect(onChangeInclusion).toHaveBeenCalledWith(expect.objectContaining({ sourcePath: 'notes/clean.md' }), false);
    fireEvent.click(screen.getByRole('button', { name: '审阅 Clean article' }));
    expect(onSelectArticle).toHaveBeenCalledWith(expect.objectContaining({ sourcePath: 'notes/clean.md' }));
  });

  it('uses placeholder-only search chrome without a duplicate visible label', () => {
    render(<PublishCenterScreen {...props({ activeTab: 'all' })} />);
    const search = screen.getByRole<HTMLInputElement>('searchbox', { name: '搜索文章或路径' });
    expect(search.placeholder).toBe('搜索标题或路径');
    expect(search.parentElement?.textContent).toBe('');
  });

  it('renders issues directly in the issues tab without duplicating the article table', () => {
    render(<PublishCenterScreen {...props({ activeTab: 'issues' })} />);
    expect(screen.queryByRole('table')).toBeNull();
    const list = document.querySelector('.pc-issues');
    expect(list?.textContent).toContain('Broken image');
    expect(list?.textContent).toContain('notes/broken.md:12');
  });

  it('shows a sibling review pane and collapses back through an explicit action', () => {
    const onCloseReview = vi.fn();
    render(<PublishCenterScreen {...props({ activeTab: 'all', selectedSourcePath: 'notes/clean.md', onCloseReview })} />);
    expect(screen.getByRole('dialog', { name: '审阅 Clean article' })).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: '关闭文章审阅' })[1]!);
    expect(onCloseReview).toHaveBeenCalledOnce();
  });

  it('renders four truthful publication stages while a task is running', () => {
    render(<PublishCenterScreen {...props({ publication: { state: 'running', stage: 'upload' } as never })} />);
    const progress = screen.getByRole('list', { name: '发布进度' });
    expect(progress.querySelectorAll('li')).toHaveLength(4);
    expect(progress.querySelector('[aria-current="step"]')?.textContent).toContain('上传');
    expect(document.querySelector<HTMLButtonElement>('.pc-actions button:last-child')?.disabled).toBe(true);
  });
});

function props(overrides: Partial<PublishCenterScreenProps> = {}): PublishCenterScreenProps {
  const issue = { severity: 'blocker' as const, code: 'missing-image', path: 'notes/broken.md', line: 12, message: 'Broken image' };
  return {
    activeTab: 'changes',
    center: {
      siteName: 'Demo Wiki', siteUrl: 'https://demo.pages.dev', lastPublishedAt: '2026-08-01T10:00:00.000Z', baseline: 'available', canPublish: false, scanDigest: 'scan-1',
      output: { status: 'known', fileCount: 18, assetCount: 4, assetBytes: 1024 },
      summary: { changes: 2, added: 1, updated: 1, urlChanged: 0, visibilityChanged: 0, takedowns: 0, unknown: 0, blockers: 1, warnings: 0 },
      issues: [issue] as never,
      articles: [
        { sourcePath: 'notes/clean.md', title: 'Clean article', url: '/clean/', onlineUrl: '/clean/', visibility: 'public', nextIncluded: true, availability: 'ready', change: 'updated', issues: [] },
        { sourcePath: 'notes/broken.md', title: 'Broken article', url: '/broken/', visibility: 'public', nextIncluded: true, availability: 'ready', change: 'added', issues: [issue] as never },
      ],
    },
    connection: { state: 'connected', account: { id: 'a', name: 'Demo' } }, filter: 'all', previewBusy: false, publication: { state: 'idle' }, query: '',
    onAcknowledgeUploadUncertain: () => undefined, onChangeFilter: () => undefined, onChangeInclusion: () => undefined, onChangeQuery: () => undefined, onChangeTab: () => undefined,
    onCheckConnection: () => undefined, onCloseReview: () => undefined, onLocateIssue: () => undefined, onOpenLogs: () => undefined, onOpenSettings: () => undefined,
    onOpenSite: () => undefined, onOpenSiteConfig: () => undefined, onPreview: () => undefined, onPublish: () => undefined, onRefresh: () => undefined, onSelectArticle: () => undefined,
    ...overrides,
  };
}
