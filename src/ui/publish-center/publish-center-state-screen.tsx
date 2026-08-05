import type { PublicationServiceStatus } from '../../application';
import { EmptyState } from '../components/empty-state';
import { InlineAlert } from '../components/inline-alert';

export function PublishCenterLoadingScreen() {
  return <main class="pp-publish-state"><EmptyState description="正在读取发布内容；Cloudflare 状态将在后台检查。" icon="loader-circle" title="正在加载发布中心" /></main>;
}

export function PublishCenterErrorScreen({ message }: { message: string }) {
  return <main class="pp-publish-state"><InlineAlert icon="circle-x" title="无法读取发布配置" tone="danger">{message}</InlineAlert></main>;
}

export function PublishingWithoutScanScreen({ status }: { status: Extract<PublicationServiceStatus, { state: 'running' }> }) {
  const stages = ['prepare', 'build', 'upload', 'activate'] as const;
  const labels = { prepare: '准备', build: '构建与检查', upload: '上传', activate: '激活' } as const;
  const active = stages.indexOf(status.stage);
  return <main class="pp-publish-state"><header><div class="pp-eyebrow">发布中心</div><h1>发布进行中</h1><p>任务继续在后台运行。为避免影响当前发布，本次不会重新扫描 Vault。</p></header><ol aria-label="发布进度" class="pp-progress-track">{stages.map((stage, index) => <li aria-current={index === active ? 'step' : undefined} class={index < active ? 'is-complete' : index === active ? 'is-active' : undefined}><span>{index < active ? '✓' : index === active ? '●' : '○'}</span><strong>{labels[stage]}</strong></li>)}</ol></main>;
}
