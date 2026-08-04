import { stringify } from 'yaml';
import type { BuiltinThemeId } from '../theme/builtin-theme-catalog';

export interface ControlledQuartzConfigInput {
  siteName: string;
  baseUrl: string;
  search: boolean;
  graph: boolean;
  builtinTheme?: BuiltinThemeId;
  theme?: ControlledQuartzThemeConfig;
}

export interface ControlledQuartzThemePlugin {
  source: string;
  enabled: true;
  options?: Record<string, unknown>;
  layout?: Record<string, unknown>;
}

export interface ControlledQuartzThemeConfig {
  typography?: {
    header?: string;
    body?: string;
    code?: string;
  };
  plugins: ControlledQuartzThemePlugin[];
  suppressDefaultComponentLayout: boolean;
  layoutByPageType: Record<string, {
    exclude?: string[];
    positions?: Record<string, never[]>;
    template?: string;
  }>;
}

export function createControlledQuartzConfig(input: ControlledQuartzConfigInput): string {
  const defaultTypography = {
    header: '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    body: '-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif',
    code: 'SFMono-Regular, Consolas, Liberation Mono, monospace',
  };
  const plugins = [
    ...(input.builtinTheme === undefined
      ? []
      : [plugin('@quartz-themes/core', true, {
        theme: input.builtinTheme,
        mode: 'both',
        themeFonts: false,
      }, 10)]),
    plugin('@quartz-community/note-properties', true, {
      includeAll: false,
      includedProperties: ['description', 'tags'],
      excludedProperties: [],
      hidePropertiesView: true,
    }, 5, layout('beforeBody', 15)),
    plugin('@quartz-community/syntax-highlighting', true, {
      theme: { light: 'github-light', dark: 'github-dark' },
      keepBackground: false,
    }, 20),
    plugin('@quartz-community/obsidian-flavored-markdown', true, {
      enableInHtmlEmbed: false,
      enableCheckbox: true,
      enableObsidianUri: false,
      enableTweetEmbed: false,
      enableVideoEmbed: false,
      enableYouTubeEmbed: false,
      mermaid: false,
    }, 30),
    plugin('@quartz-community/github-flavored-markdown', true, undefined, 40),
    plugin('@quartz-community/table-of-contents', true, undefined, 50, layout('right', 30)),
    plugin('@quartz-community/crawl-links', true, {
      markdownLinkResolution: 'shortest',
    }, 60),
    plugin('@quartz-community/description', true, undefined, 70),
    plugin('@quartz-community/remove-draft', true),
    plugin('@quartz-community/unlisted-pages', true),
    plugin('@quartz-community/content-index', true, {
      enableSiteMap: true,
      enableRSS: false,
    }),
    plugin('@quartz-community/content-page', true),
    plugin('@quartz-community/folder-page', true),
    plugin('@quartz-community/tag-page', true),
    plugin('@quartz-community/explorer', true, {
      folderClickBehavior: 'collapse',
    }, undefined, layout('left', 50)),
    plugin('@quartz-community/graph', input.graph, undefined, undefined, layout('right', 10)),
    plugin('@quartz-community/search', input.search, undefined, undefined, {
      ...layout('left', 20),
      group: 'toolbar',
      groupOptions: { grow: true },
    }),
    plugin('@quartz-community/backlinks', true, undefined, undefined, layout('right', 50)),
    plugin('@quartz-community/article-title', true, undefined, undefined, layout('beforeBody', 10)),
    plugin('@quartz-community/content-meta', true, undefined, undefined, layout('beforeBody', 20)),
    plugin('@quartz-community/tag-list', true, undefined, undefined, layout('beforeBody', 30)),
    plugin('@quartz-community/page-title', true, undefined, undefined, layout('left', 10)),
    plugin('@quartz-community/darkmode', true, undefined, undefined, {
      ...layout('left', 30),
      group: 'toolbar',
    }),
    plugin('@quartz-community/breadcrumbs', true, undefined, undefined, {
      ...layout('beforeBody', 5),
      condition: 'not-index',
    }),
  ];
  if (input.theme !== undefined) {
    plugins.push(...input.theme.plugins.map((entry) => ({ ...entry })));
  }
  return stringify({
    configuration: {
      pageTitle: input.siteName,
      pageTitleSuffix: '',
      enableSPA: true,
      enablePopovers: true,
      analytics: null,
      locale: 'zh-CN',
      baseUrl: input.baseUrl,
      ignorePatterns: [],
      theme: {
        fontOrigin: 'local',
        cdnCaching: false,
        typography: {
          ...defaultTypography,
          ...input.theme?.typography,
        },
        colors: {
          lightMode: {
            light: '#faf8f8',
            lightgray: '#e5e5e5',
            gray: '#b8b8b8',
            darkgray: '#4e4e4e',
            dark: '#2b2b2b',
            secondary: '#284b63',
            tertiary: '#52796f',
            highlight: 'rgba(143, 159, 169, 0.15)',
            textHighlight: '#fff23688',
          },
          darkMode: {
            light: '#161618',
            lightgray: '#393639',
            gray: '#646464',
            darkgray: '#d4d4d4',
            dark: '#ebebec',
            secondary: '#7b97aa',
            tertiary: '#84a59d',
            highlight: 'rgba(143, 159, 169, 0.15)',
            textHighlight: '#b3aa0288',
          },
        },
      },
    },
    plugins,
    ...(input.theme === undefined
      ? {}
      : { layout: { byPageType: input.theme.layoutByPageType } }),
  });
}

function plugin(
  source: string,
  enabled: boolean,
  options?: Record<string, unknown>,
  order?: number,
  pluginLayout?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    source,
    enabled,
    ...(options === undefined ? {} : { options }),
    ...(order === undefined ? {} : { order }),
    ...(pluginLayout === undefined ? {} : { layout: pluginLayout }),
  };
}

function layout(position: string, priority: number): Record<string, unknown> {
  return { position, priority };
}
