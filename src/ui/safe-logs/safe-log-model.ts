import type { SafeDiagnosticLogEntry } from '../../maintenance/maintenance-service';

export type DiagnosticTone = 'success' | 'warning' | 'danger' | 'neutral';

export function diagnosticTone(code: string): DiagnosticTone {
  if (/(?:success|complete|ok)$/i.test(code)) return 'success';
  if (/(?:warn|warning)/i.test(code)) return 'warning';
  if (/(?:error|fail|blocked)/i.test(code)) return 'danger';
  return 'neutral';
}

export function diagnosticIcon(
  tone: DiagnosticTone,
): 'circle-check' | 'triangle-alert' | 'circle-x' | 'circle-dot' {
  if (tone === 'success') return 'circle-check';
  if (tone === 'warning') return 'triangle-alert';
  if (tone === 'danger') return 'circle-x';
  return 'circle-dot';
}

export function diagnosticToneLabel(tone: DiagnosticTone): string {
  if (tone === 'success') return '成功';
  if (tone === 'warning') return '警告';
  if (tone === 'danger') return '错误';
  return '信息';
}

export function localizeStage(stage: SafeDiagnosticLogEntry['stage']): string {
  const labels: Record<SafeDiagnosticLogEntry['stage'], string> = {
    scan: '扫描',
    build: '构建',
    upload: '上传',
    activate: '激活',
    maintenance: '维护',
  };
  return labels[stage];
}

export function formatLocalDiagnosticTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${twoDigits(date.getMonth() + 1)}/${twoDigits(date.getDate())} ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`;
}

export function formatAccessibleLocalTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日 ${twoDigits(date.getHours())}:${twoDigits(date.getMinutes())}:${twoDigits(date.getSeconds())}`;
}

export function formatCounts(counts: Readonly<Record<string, number>> | undefined): string {
  if (!counts || Object.keys(counts).length === 0) return '—';
  return Object.entries(counts)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(' · ');
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}
