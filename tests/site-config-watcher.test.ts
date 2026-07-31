import { describe, expect, it, vi } from 'vitest';
import { watchSiteConfigChanges } from '../src/config/site-config-watcher';

describe('site config watcher', () => {
  it('reports only site.yml changes and closes its filesystem boundary', () => {
    const onChange = vi.fn();
    const close = vi.fn();
    let emit: ((event: string, filename: string | Buffer | null) => void) | undefined;
    const dispose = watchSiteConfigChanges('/vault', onChange, {
      watch: (_root, listener) => {
        emit = listener;
        return { close };
      },
    });

    emit?.('change', 'notes/article.md');
    emit?.('rename', Buffer.from('.publish/site.yml'));
    emit?.('change', '.publish\\site.yml');

    expect(onChange).toHaveBeenCalledTimes(2);
    dispose();
    expect(close).toHaveBeenCalledOnce();
  });
});
