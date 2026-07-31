import { describe, expect, it } from 'vitest';
import { isSupportedPlatform } from '../src/plugin/platform';

describe('platform support', () => {
  it('enables the plugin only for a macOS filesystem vault', () => {
    expect(isSupportedPlatform('darwin', true)).toBe(true);
    expect(isSupportedPlatform('darwin', false)).toBe(false);
    expect(isSupportedPlatform('win32', true)).toBe(false);
    expect(isSupportedPlatform('linux', true)).toBe(false);
  });
});
