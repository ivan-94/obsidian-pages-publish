export function normalizeRouteUrlPath(value: string): string | undefined {
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    /[\\?#]/u.test(value) ||
    hasControlCharacter(value)
  ) {
    return undefined;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  if (
    decoded.includes('%') ||
    /[\\?#]/u.test(decoded) ||
    hasControlCharacter(decoded)
  ) {
    return undefined;
  }
  const segments = decoded.split('/').filter(Boolean);
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return undefined;
  }
  const normalized = segments.map((segment) => segment.normalize('NFC')).join('/');
  return normalized.length === 0 ? '/' : `/${normalized}/`;
}

export function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}
