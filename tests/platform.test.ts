import { describe, expect, it } from 'vitest';
import {
  isSupportedPlatform,
  supportedPlatformIdentity,
} from '../src/plugin/platform';

describe('platform support', () => {
  it('enables the plugin only for a macOS filesystem vault', () => {
    expect(isSupportedPlatform('darwin', true)).toBe(true);
    expect(isSupportedPlatform('darwin', false)).toBe(false);
    expect(isSupportedPlatform('win32', true)).toBe(false);
    expect(isSupportedPlatform('linux', true)).toBe(false);
  });

  it('identifies the macOS architecture used by native Quartz dependencies', () => {
    expect(supportedPlatformIdentity('darwin', 'arm64', true)).toBe('darwin-arm64');
    expect(supportedPlatformIdentity('darwin', 'x64', true)).toBe('darwin-x64');
    expect(supportedPlatformIdentity('darwin', 'ia32', true)).toBeUndefined();
    expect(supportedPlatformIdentity('linux', 'arm64', true)).toBeUndefined();
    expect(supportedPlatformIdentity('darwin', 'arm64', false)).toBeUndefined();
  });
});
