import type {
  CurrentArticleContext,
  CurrentArticlePanelState,
} from '../publication/current-article-panel';

export const articleIntentEditorFields = [
  { name: 'title', label: '标题覆盖', kind: 'text' },
  { name: 'summary', label: '摘要覆盖', kind: 'text' },
  { name: 'slug', label: 'Slug 覆盖', kind: 'text' },
  { name: 'date', label: '日期覆盖', kind: 'text' },
  { name: 'updated', label: '更新时间覆盖', kind: 'text' },
  { name: 'tags', label: '标签覆盖', kind: 'list' },
  { name: 'cover', label: '封面覆盖', kind: 'text' },
  { name: 'kind', label: '类型覆盖', kind: 'select' },
  { name: 'order', label: '排序覆盖', kind: 'number' },
  { name: 'redirects', label: '重定向覆盖', kind: 'list' },
] as const;

export function articleContentIssueLabel(issue: {
  severity: 'blocker' | 'warning';
  dormant: boolean;
}): '阻塞' | '警告' | '休眠警告' {
  if (issue.dormant) return '休眠警告';
  return issue.severity === 'blocker' ? '阻塞' : '警告';
}

export class LatestCurrentArticleProjection {
  private generation = 0;

  constructor(
    private readonly project: (
      context: CurrentArticleContext,
    ) => Promise<CurrentArticlePanelState>,
  ) {}

  async resolve(
    context: CurrentArticleContext,
  ): Promise<CurrentArticlePanelState | undefined> {
    const generation = ++this.generation;
    const state = await this.project(context);
    return generation === this.generation ? state : undefined;
  }
}
