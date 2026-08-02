import { describe, expect, it } from 'vitest';
import { projectGlobalUiState } from '../src/plugin/global-ui-state';

describe('global UI state projection', () => {
  it('routes the single Ribbon entry and status bar from one priority-ordered state model', () => {
    expect(projectGlobalUiState({ configured: false })).toEqual({
      ribbon: { route: 'setup', tooltip: '创建发布站点' },
    });

    expect(projectGlobalUiState({ configured: false, environment: 'preparing' })).toEqual({
      ribbon: { route: 'setup', tooltip: '正在准备发布环境' },
      statusBar: { route: 'setup', text: 'Pages：正在准备发布环境' },
    });

    expect(projectGlobalUiState({ configured: true, scan: 'scanning' })).toEqual({
      ribbon: { route: 'publish-center', tooltip: '正在扫描发布内容' },
      statusBar: { route: 'publish-center', text: 'Pages：正在扫描…' },
    });

    expect(projectGlobalUiState({
      configured: true,
      connection: 'expired',
      scan: 'scanning',
      blockers: 2,
    })).toEqual({
      ribbon: { route: 'publish-center', tooltip: 'Cloudflare 授权已失效' },
      statusBar: { route: 'publish-center', text: 'Pages：Cloudflare 需要重新授权' },
    });

    expect(projectGlobalUiState({
      configured: true,
      scan: 'idle',
      blockers: 2,
      pending: 9,
    })).toEqual({
      ribbon: { route: 'publish-center', tooltip: '打开发布中心：2 个阻塞' },
      statusBar: { route: 'publish-center', text: 'Pages：2 个阻塞' },
    });

    expect(projectGlobalUiState({
      configured: true,
      scan: 'idle',
      blockers: 0,
      pending: 9,
    })).toEqual({
      ribbon: { route: 'publish-center', tooltip: '打开发布中心' },
      statusBar: { route: 'publish-center', text: 'Pages：9 项待发布' },
    });

    expect(projectGlobalUiState({
      configured: true,
      scan: 'scanning',
      blockers: 4,
      pending: 12,
      publication: { state: 'running', stage: 'upload' },
    })).toEqual({
      ribbon: { route: 'publish-center', tooltip: '发布中：上传' },
      statusBar: { route: 'publish-center', text: 'Pages：发布中 · 上传' },
    });

    expect(projectGlobalUiState({
      configured: true,
      environment: 'preparing',
      publication: { state: 'running', stage: 'activate' },
    })).toEqual({
      ribbon: { route: 'publish-center', tooltip: '发布中：激活' },
      statusBar: { route: 'publish-center', text: 'Pages：发布中 · 激活' },
    });

    expect(projectGlobalUiState({
      configured: true,
      publication: { state: 'failed', stage: 'activate' },
    })).toEqual({
      ribbon: { route: 'publish-center', tooltip: '上次发布失败，线上保持不变' },
      statusBar: { route: 'publish-center', text: 'Pages：发布失败' },
    });

    expect(projectGlobalUiState({
      configured: true,
      publication: { state: 'reconciliation-required', reconciliation: 'upload-uncertain' },
    })).toEqual({
      ribbon: { route: 'publish-center', tooltip: '上传结果未确认，请核验 cloudflare' },
      statusBar: { route: 'publish-center', text: 'Pages：上传结果未确认' },
    });
  });

  it('keeps idle configured workspaces quiet while preserving a background publication route', () => {
    expect(projectGlobalUiState({ configured: true, scan: 'idle' })).toEqual({
      ribbon: { route: 'publish-center', tooltip: '打开发布中心' },
    });
    expect(projectGlobalUiState({
      configured: false,
      publication: { state: 'failed', stage: 'build' },
    })).toEqual({
      ribbon: { route: 'publish-center', tooltip: '上次发布失败，线上保持不变' },
      statusBar: { route: 'publish-center', text: 'Pages：发布失败' },
    });
    expect(projectGlobalUiState({
      configured: false,
      publication: { state: 'running', stage: 'upload' },
    })).toEqual({
      ribbon: { route: 'publish-center', tooltip: '发布中：上传' },
      statusBar: { route: 'publish-center', text: 'Pages：发布中 · 上传' },
    });
    expect(projectGlobalUiState({ configured: true, pending: 'unknown' })).toEqual({
      ribbon: { route: 'publish-center', tooltip: '打开发布中心' },
      statusBar: { route: 'publish-center', text: 'Pages：有待发布变化' },
    });
  });
});
