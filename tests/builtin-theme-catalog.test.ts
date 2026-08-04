import { describe, expect, it } from 'vitest';
import {
  BUILTIN_THEME_CATALOG,
  builtinTheme,
} from '../src/theme/builtin-theme-catalog';

describe('built-in theme catalog', () => {
  it('exposes only the reviewed, immutable theme packages', () => {
    expect(BUILTIN_THEME_CATALOG.map((theme) => theme.id)).toEqual([
      'minimal',
      'tokyo-night',
      'catppuccin',
      'things',
    ]);
    expect(BUILTIN_THEME_CATALOG.every((theme) => theme.version === '1.0.1')).toBe(true);
    expect(new Set(BUILTIN_THEME_CATALOG.map((theme) => theme.packageName)).size)
      .toBe(BUILTIN_THEME_CATALOG.length);
    expect(Object.isFrozen(BUILTIN_THEME_CATALOG)).toBe(true);
    expect(BUILTIN_THEME_CATALOG.every(Object.isFrozen)).toBe(true);
    expect(builtinTheme('tokyo-night')).toMatchObject({
      displayName: 'Tokyo Night',
      packageName: '@quartz-themes/tokyo-night',
    });
    expect(() => builtinTheme('unreviewed-theme')).toThrow('not a supported built-in theme');
  });
});
