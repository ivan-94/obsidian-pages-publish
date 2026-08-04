const reviewedBuiltinThemes = [
  {
    id: 'minimal',
    displayName: 'Minimal',
    packageName: '@quartz-themes/minimal',
    version: '1.0.1',
    integrity: 'sha512-Y6O2pnxGkrbBmT6cw5cNP+6s14Mi/8TnEaujrXykikuicjAhpWdF8KutK9qSqXfAzXHGU/w9MPns9wkV3gUGLw==',
  },
  {
    id: 'tokyo-night',
    displayName: 'Tokyo Night',
    packageName: '@quartz-themes/tokyo-night',
    version: '1.0.1',
    integrity: 'sha512-or5TEAM6/xJwm/D9dZX84nDmTPzDIHDcFP5ZGVEgG5U8Fe9lWpAfdpvEtfjkkYv01rCCobbOwsfZBZ96yWeXyQ==',
  },
  {
    id: 'catppuccin',
    displayName: 'Catppuccin',
    packageName: '@quartz-themes/catppuccin',
    version: '1.0.1',
    integrity: 'sha512-zmdsx2P8G9Gj9MW6ZP8RxBo3cXSkWm3f5SCzNFkmhOwHiw8VVpgH9uUGCPZr23Yd8Ame3fAOPum21jMXiccJQA==',
  },
  {
    id: 'things',
    displayName: 'Things',
    packageName: '@quartz-themes/things',
    version: '1.0.1',
    integrity: 'sha512-7NcALX5RNWU+6AITXtoU9riVlHZvzbNK8rG84ccdNlT4eho+MeTL+6RakhVyUS7xtQvFDDtXwiN7hzxXHNQOcg==',
  },
] as const;

export type BuiltinThemeId = (typeof reviewedBuiltinThemes)[number]['id'];

export interface BuiltinThemeDefinition {
  readonly id: BuiltinThemeId;
  readonly displayName: string;
  readonly packageName: `@quartz-themes/${string}`;
  readonly version: string;
  readonly integrity: `sha512-${string}`;
}

export const BUILTIN_THEME_CATALOG: readonly BuiltinThemeDefinition[] =
  Object.freeze(reviewedBuiltinThemes.map((theme) => Object.freeze({ ...theme })));

export function builtinTheme(id: string): BuiltinThemeDefinition {
  const theme = BUILTIN_THEME_CATALOG.find((candidate) => candidate.id === id);
  if (!theme) throw new Error(`${JSON.stringify(id)} is not a supported built-in theme.`);
  return theme;
}

export function isBuiltinThemeId(value: string): value is BuiltinThemeId {
  return BUILTIN_THEME_CATALOG.some((theme) => theme.id === value);
}
