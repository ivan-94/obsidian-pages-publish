import { describe, expect, it } from 'vitest';
import {
  diagnosticTone,
  formatCounts,
  formatLocalDiagnosticTime,
  localizeStage,
} from '../src/ui/safe-logs/safe-log-model';

describe('safe log presentation model', () => {
  it('derives stable visual tones without expanding the safe schema', () => {
    expect(diagnosticTone('scan.complete')).toBe('success');
    expect(diagnosticTone('upload.warning')).toBe('warning');
    expect(diagnosticTone('build.failed')).toBe('danger');
    expect(diagnosticTone('maintenance.started')).toBe('neutral');
    expect(localizeStage('activate')).toBe('激活');
  });

  it('formats bounded counts deterministically and tolerates invalid timestamps', () => {
    expect(formatCounts({ warnings: 2, articles: 12 })).toBe('articles=12 · warnings=2');
    expect(formatCounts(undefined)).toBe('—');
    expect(formatLocalDiagnosticTime('not-a-date')).toBe('not-a-date');
  });
});
