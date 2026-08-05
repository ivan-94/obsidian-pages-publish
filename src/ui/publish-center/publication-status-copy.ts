import type { PublicationServiceStatus } from '../../application';

type VisiblePublicationStatus = Exclude<PublicationServiceStatus, { state: 'idle' | 'unavailable' }>;

export function publicationStatusText(status: VisiblePublicationStatus): string {
  return `${label(status)}：${detail(status)}`;
}

function label(status: VisiblePublicationStatus): string {
  if (status.state === 'running') return `${stageLabel(status.stage)}中`;
  if (status.state === 'succeeded') return '发布成功';
  if (status.state === 'reconciliation-required') return status.reconciliation === 'upload-uncertain' ? '上传结果未确认' : '本地发布事实待协调';
  return '发布失败';
}

function detail(status: VisiblePublicationStatus): string {
  if (status.state === 'running') return `第 ${['prepare', 'build', 'upload', 'activate'].indexOf(status.stage) + 1}/4 阶段。任务在后台继续运行。`;
  if (status.state === 'succeeded') return `${status.deployment.output.fileCount} 个文件已激活。后续编辑会进入下一次变化。`;
  if (status.state === 'reconciliation-required') {
    if (status.reconciliation === 'upload-uncertain') return `请先在 Cloudflare Pages 核验${status.target === undefined ? '已保存的目标项目' : `项目 ${status.target.projectName}`}，再解除本地阻塞。${status.message}`;
    return `线上发布成功，但本地事实待协调：${status.message}`;
  }
  return `${status.message} 新版本未激活，现有线上站点保持不变。`;
}

function stageLabel(stage: 'prepare' | 'build' | 'upload' | 'activate'): string {
  return { prepare: '准备', build: '构建与检查', upload: '上传', activate: '激活' }[stage];
}
