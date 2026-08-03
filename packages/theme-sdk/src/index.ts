/** Theme API version understood by Pages Publish 0.1.x. */
export const THEME_API_VERSION = 1 as const;

export const THEME_CAPABILITIES = [
  'styles',
  'assets',
  'layout',
  'components',
  'clientScripts',
  'localFonts',
] as const;

export type ThemeCapability = (typeof THEME_CAPABILITIES)[number];

export const THEME_LAYOUT_SLOTS = [
  'header',
  'beforeBody',
  'afterBody',
  'left',
  'right',
  'footer',
] as const;

export type ThemeLayoutSlot = (typeof THEME_LAYOUT_SLOTS)[number];

export const THEME_PAGE_TYPES = [
  'home',
  'folder',
  'tag',
  'content',
  'notFound',
  'privacy',
] as const;

export type ThemePageType = (typeof THEME_PAGE_TYPES)[number];
export type ThemeComponent = (...args: readonly unknown[]) => unknown;

export interface ThemePageFrame {
  name: string;
  css?: string;
  render: ThemeComponent;
}

export interface ThemeTypography {
  header?: string;
  body?: string;
  code?: string;
}

export interface ThemeConfiguration {
  typography?: ThemeTypography;
}

export type ThemeLayout = Partial<Record<ThemeLayoutSlot, readonly string[]>> & {
  byPageType?: Partial<
    Record<ThemePageType, Partial<Record<ThemeLayoutSlot, readonly string[]>>>
  >;
  frames?: Partial<Record<ThemePageType, string>>;
};

export interface ThemeDescriptor {
  configuration?: ThemeConfiguration;
  layout?: ThemeLayout;
  components?: Readonly<Record<string, ThemeComponent>>;
  pageFrames?: Readonly<Record<string, ThemePageFrame>>;
  styles?: readonly string[];
  assets?: readonly string[];
  clientScripts?: readonly string[];
  localFonts?: readonly string[];
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };
export type ThemeOptions = Readonly<Record<string, JsonValue>>;

export interface ThemeContext {
  options: ThemeOptions;
}

/**
 * Provides inference and excess-property checking to theme packages.
 * Pages Publish performs the authoritative runtime validation after loading the
 * packed artifact; this helper intentionally has no filesystem or Quartz access.
 */
export function defineTheme<const T extends ThemeDescriptor>(descriptor: T): T {
  if (descriptor === null || typeof descriptor !== 'object' || Array.isArray(descriptor)) {
    throw new TypeError('Theme descriptor must be an object.');
  }
  return descriptor;
}
