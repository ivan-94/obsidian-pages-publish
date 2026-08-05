import { describe, expect, it } from 'vitest';
import { publicationStatusText } from '../src/ui/publish-center/publication-status-copy';

describe('publication status safety copy', () => {
  it('never describes an upload-uncertain recovery as a successful online publication', () => {
    const text = publicationStatusText({
      state: 'reconciliation-required',
      reconciliation: 'upload-uncertain',
      target: {
        provider: 'cloudflare-pages',
        accountId: 'account-original',
        projectName: 'project-original',
      },
      message: 'A Cloudflare upload outcome could not be confirmed.',
    });

    expect(text).toContain('上传结果未确认');
    expect(text).toContain('project-original');
    expect(text).not.toContain('线上发布成功');
  });

  it('states that a failed publication leaves the online site unchanged', () => {
    expect(publicationStatusText({
      state: 'failed',
      stage: 'upload',
      message: 'Cloudflare request timed out.',
    })).toContain('现有线上站点保持不变');
  });
});
