export type GlobalUiRoute = 'setup' | 'publish-center';

export type GlobalPublicationState =
  | { state: 'idle' | 'succeeded' | 'unavailable' | 'reconciliation-required' }
  | { state: 'running'; stage: 'prepare' | 'build' | 'upload' | 'activate' }
  | { state: 'failed'; stage: 'prepare' | 'build' | 'upload' | 'activate' };

export interface GlobalUiStateInput {
  configured: boolean;
  environment?: 'preparing' | 'failed';
  scan?: 'idle' | 'scanning';
  blockers?: number;
  pending?: number | 'unknown';
  publication?: GlobalPublicationState;
}

export interface GlobalUiProjection {
  ribbon: { route: GlobalUiRoute; tooltip: string };
  statusBar?: { route: GlobalUiRoute; text: string };
}

/**
 * Projects the one user-visible global state from local configuration, scans,
 * and publication. Consumers use this same priority order for Ribbon and the
 * status bar, so a background publish can never be obscured by a stale scan.
 */
export function projectGlobalUiState(input: GlobalUiStateInput): GlobalUiProjection {
  const route: GlobalUiRoute = input.configured ? 'publish-center' : 'setup';
  const publication = input.publication;
  // A publication operates on its frozen snapshot. It can therefore outlive a
  // concurrent removal of site.yml; keep its recovery surface reachable.
  if (publication?.state === 'running') {
    const stage = publicationStageLabel(publication.stage);
    return {
      ribbon: { route: 'publish-center', tooltip: `发布中：${stage}` },
      statusBar: { route: 'publish-center', text: `Pages：发布中 · ${stage}` },
    };
  }
  if (publication?.state === 'failed') {
    return {
      ribbon: { route: 'publish-center', tooltip: '上次发布失败，线上保持不变' },
      statusBar: { route: 'publish-center', text: 'Pages：发布失败' },
    };
  }
  if (publication?.state === 'reconciliation-required') {
    return {
      ribbon: { route: 'publish-center', tooltip: '线上已成功，本地状态待协调' },
      statusBar: { route: 'publish-center', text: 'Pages：本地状态待协调' },
    };
  }
  if (input.environment === 'preparing') {
    return {
      ribbon: { route, tooltip: '正在准备发布环境' },
      statusBar: { route, text: 'Pages：正在准备发布环境' },
    };
  }
  if (input.environment === 'failed') {
    return {
      ribbon: { route, tooltip: '本地环境需要修复' },
      statusBar: { route, text: 'Pages：本地环境需要修复' },
    };
  }
  if (!input.configured) {
    return { ribbon: { route: 'setup', tooltip: '创建发布站点' } };
  }
  if (input.scan === 'scanning') {
    return {
      ribbon: { route: 'publish-center', tooltip: '正在扫描发布内容' },
      statusBar: { route: 'publish-center', text: 'Pages：正在扫描…' },
    };
  }
  const blockers = positiveInteger(input.blockers);
  if (blockers > 0) {
    return {
      ribbon: { route: 'publish-center', tooltip: `打开发布中心：${blockers} 个阻塞` },
      statusBar: { route: 'publish-center', text: `Pages：${blockers} 个阻塞` },
    };
  }
  if (input.pending === 'unknown') {
    return {
      ribbon: { route: 'publish-center', tooltip: '打开发布中心' },
      statusBar: { route: 'publish-center', text: 'Pages：有待发布变化' },
    };
  }
  const pending = positiveInteger(input.pending);
  if (pending > 0) {
    return {
      ribbon: { route: 'publish-center', tooltip: '打开发布中心' },
      statusBar: { route: 'publish-center', text: `Pages：${pending} 项待发布` },
    };
  }
  return { ribbon: { route: 'publish-center', tooltip: '打开发布中心' } };
}

function positiveInteger(value: number | undefined): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function publicationStageLabel(stage: 'prepare' | 'build' | 'upload' | 'activate'): string {
  const labels = {
    prepare: '准备',
    build: '构建与检查',
    upload: '上传',
    activate: '激活',
  } as const;
  return labels[stage];
}
