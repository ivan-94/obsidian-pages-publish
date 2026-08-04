import { Fragment, h } from 'preact';

const ACCENTS = {
  orange: '#ff4b17',
  red: '#ff2e68',
  blue: '#0067ff',
  acid: '#d8ff00',
};

const defaults = Object.freeze({
  accent: 'orange',
  graphMode: 'compact',
  homeHero: 'latest',
  showPublicCount: true,
  wordmark: 'PUBLIC FIELD NOTES',
});

// The main client script settles the complete rail state, but it loads after
// Quartz's document shell. Apply only the persisted focused-reading bit while
// parsing so a returning reader never sees a standard-shell flash.
const readingPreferenceBoot = "try{if(localStorage.getItem('pages-publish:brutalist:reading-mode')==='focused'){document.documentElement.dataset.readingMode='focused'}}catch{}";
const brutalistCascadeAsset = '/static/pages-publish-theme/dist/assets/brutalist-cascade.css';

const control = (action, label, shortLabel, controls, mobileLabel = shortLabel) => h('button', {
  class: 'brutalist-shell-control',
  type: 'button',
  'data-brutalist-action': action,
  'aria-label': label,
  ...(controls === undefined ? {} : { 'aria-controls': controls }),
}, [
  h('span', { 'aria-hidden': 'true', 'data-mobile-label': mobileLabel }, shortLabel),
  h('span', { class: 'brutalist-visually-hidden' }, label),
]);

const components = (options) => ({
  BrutalistPreferenceBoot: () => () => h('script', {
    type: 'application/javascript',
    dangerouslySetInnerHTML: { __html: readingPreferenceBoot },
  }),
  // Theme CSS registered through Quartz is intentionally placed in its base
  // cascade layer. This immutable local asset is linked after that base so
  // the theme can own its shell without changing the renderer above it.
  BrutalistCascadeGuard: () => () => h('link', {
    rel: 'stylesheet',
    href: brutalistCascadeAsset,
    'data-pages-publish-brutalist-cascade': 'true',
  }),
  BrutalistMasthead: () => {
    const Component = ({ cfg }) => h('div', { class: 'brutalist-masthead' }, [
      // Keep the compact mark in the DOM rather than synthesising it through
      // a pseudo-element. Quartz replaces page shells during client-side
      // navigation, and a real, independently paintable mark keeps the
      // masthead visually stable while that replacement settles.
      h('a', { class: 'brutalist-wordmark', href: '/', 'aria-label': `${cfg.pageTitle} 首页` }, [
        h('span', { class: 'brutalist-wordmark__long' }, options.wordmark),
        h('span', { class: 'brutalist-wordmark__short', 'aria-hidden': 'true' }, 'PFN'),
      ]),
      h('span', { class: 'brutalist-reading-context', 'aria-label': '当前阅读内容' }, 'READING'),
      h('span', { class: 'brutalist-edition', 'aria-hidden': 'true' }, 'ED. 001 / QUARTZ 5'),
      h('div', { class: 'brutalist-shell-controls', 'aria-label': '阅读工具' }, [
        control('navigation', '打开站点导航', 'NAV', 'brutalist-site-navigation'),
        control('search', '搜索站点内容', 'FIND'),
        control('outline', '打开本文目录', 'OUTLINE', 'brutalist-article-utilities', 'TOC'),
        control('focus', '进入专注阅读', 'FOCUS', undefined, 'READ'),
      ]),
      h('img', { class: 'brutalist-registration', src: '/static/pages-publish-theme/dist/assets/registration-mark.svg', alt: '' }),
    ]);
    Component.css = `:root{--brutalist-signal:${ACCENTS[options.accent]};--brutalist-hero:${JSON.stringify(options.homeHero)}}`;
    return Component;
  },
  BrutalistIndexLabel: () => ({ fileData }) => h('div', {
    class: 'brutalist-index-label',
    'data-slug': String(fileData.slug ?? ''),
  }, [
    h('span', { class: 'brutalist-index-label__key' }, 'PUBLIC INDEX'),
    h('span', { class: 'brutalist-index-label__value' }, options.showPublicCount ? 'LIVE / VERIFIED ROUTES' : 'OPEN EDITION'),
  ]),
  BrutalistArticleKicker: () => ({ fileData }) => {
    const segments = String(fileData.slug ?? 'INDEX').split('/').filter(Boolean);
    const section = segments.length > 1 ? segments.at(-2) : segments.at(-1);
    return h('div', { class: 'brutalist-kicker' }, [
      h('span', null, String(section ?? 'INDEX').replaceAll('-', ' ').toUpperCase()),
      h('span', null, 'FIELD NOTE / READ'),
    ]);
  },
  BrutalistNavigationControls: () => () => h('div', {
    class: 'brutalist-rail-controls brutalist-navigation-controls',
  }, [
    control('navigation', '收起站点导航', 'NAV', 'brutalist-site-navigation'),
    control('close-navigation', '关闭站点导航', 'CLOSE', 'brutalist-site-navigation'),
  ]),
  BrutalistUtilityControls: () => () => h('div', {
    class: 'brutalist-rail-controls brutalist-utility-controls',
  }, [
    h('div', { class: 'brutalist-outline-heading' }, [
      h('span', { class: 'brutalist-outline-heading__label' }, 'OUTLINE'),
      h('h2', { class: 'brutalist-outline-heading__title' }, '本文目录'),
      h('p', { class: 'brutalist-outline-heading__meta' }, 'ARTICLE NAVIGATION'),
    ]),
    control('outline', '收起本文目录', '×', 'brutalist-article-utilities'),
    control('close-outline', '关闭本文目录', '×', 'brutalist-article-utilities'),
  ]),
  BrutalistFooter: () => ({ cfg }) => h('footer', { class: 'brutalist-footer' }, [
    h('span', null, `© PUBLICATION / ${cfg.pageTitle}`),
    h('span', null, 'PUBLISHED WITH PAGES PUBLISH × QUARTZ'),
    h('a', { href: '/privacy/' }, 'PRIVACY'),
  ]),
});

const renderComponents = (items, componentData, className) =>
  h('div', { class: className }, items.map((Component, index) =>
    h(Component, { ...componentData, key: index })));

const contentBlock = (props) => {
  const Content = props.pageBody;
  return h('main', { class: 'brutalist-main' }, [
    renderComponents(props.beforeBody, props.componentData, 'brutalist-before-body popover-hint'),
    h(Content, props.componentData),
    renderComponents(props.afterBody, props.componentData, 'brutalist-after-body'),
  ]);
};

const frameSet = (options) => ({
  PosterFrame: {
    name: 'brutalist-poster',
    css: `.brutalist-poster-frame{--brutalist-graph-mode:${JSON.stringify(options.graphMode)}}`,
    render(props) {
      return h(Fragment, null, [
        h('div', { class: 'brutalist-poster-frame' }, [
          renderComponents(props.header, props.componentData, 'brutalist-frame-header'),
          h('aside', {
            id: 'brutalist-site-navigation',
            class: 'brutalist-poster-tools brutalist-tool-rail',
            'aria-label': '站点导航',
          }, renderComponents(props.left, props.componentData, 'brutalist-rail-content')),
          h('section', { class: 'brutalist-poster-stage' }, [
            h('div', { class: 'brutalist-issue-number', 'aria-hidden': 'true' }, '01'),
            contentBlock(props),
          ]),
          h('aside', {
            id: 'brutalist-article-utilities',
            class: 'brutalist-poster-utility brutalist-tool-rail',
            'aria-label': '文章工具',
          }, renderComponents(props.right, props.componentData, 'brutalist-rail-content')),
        ]),
        renderComponents(props.footer, props.componentData, 'brutalist-frame-footer'),
      ]);
    },
  },
  EditorialFrame: {
    name: 'brutalist-editorial',
    render(props) {
      return h(Fragment, null, [
        renderComponents(props.header, props.componentData, 'brutalist-frame-header'),
        h('div', { class: 'brutalist-editorial-frame' }, [
          h('aside', {
            id: 'brutalist-site-navigation',
            class: 'brutalist-editorial-index brutalist-tool-rail',
            'aria-label': '站点导航',
          }, renderComponents(props.left, props.componentData, 'brutalist-rail-content')),
          contentBlock(props),
          h('aside', {
            id: 'brutalist-article-utilities',
            class: 'brutalist-editorial-tools brutalist-tool-rail',
            'aria-label': '文章工具',
          }, renderComponents(props.right, props.componentData, 'brutalist-rail-content')),
        ]),
        renderComponents(props.footer, props.componentData, 'brutalist-frame-footer'),
      ]);
    },
  },
  MinimalFrame: {
    name: 'brutalist-minimal',
    render(props) {
      return h(Fragment, null, [
        renderComponents(props.header, props.componentData, 'brutalist-frame-header'),
        h('div', { class: 'brutalist-minimal-frame' }, contentBlock(props)),
        renderComponents(props.footer, props.componentData, 'brutalist-frame-footer'),
      ]);
    },
  },
});

export default ({ options: input = {} } = {}) => {
  const options = Object.freeze({ ...defaults, ...input });
  return {
    configuration: {
      typography: {
        header: 'Arial Black',
        body: 'Arial',
        code: 'Courier New',
      },
    },
    layout: {
      header: ['BrutalistPreferenceBoot', 'BrutalistCascadeGuard', 'BrutalistMasthead'],
      beforeBody: ['BrutalistArticleKicker', 'Breadcrumbs', 'ArticleTitle', 'ContentMeta', 'TagList'],
      afterBody: ['Backlinks'],
      left: ['BrutalistNavigationControls', 'BrutalistIndexLabel', 'Search', 'Darkmode', 'Explorer'],
      // The reader's place comes before a secondary discovery instrument.
      // On long notes this keeps the Table of Contents in the first viewport
      // of the utility rail instead of letting the graph consume that space.
      right: ['BrutalistUtilityControls', 'TableOfContents', 'Graph'],
      footer: ['BrutalistFooter'],
      byPageType: {
        folder: {
          right: ['Graph'],
        },
        tag: {
          right: ['Graph'],
        },
        notFound: {
          left: ['Search', 'Darkmode'],
          right: [],
        },
      },
      frames: {
        home: 'PosterFrame',
        folder: 'PosterFrame',
        tag: 'PosterFrame',
        content: 'EditorialFrame',
        privacy: 'MinimalFrame',
        notFound: 'MinimalFrame',
      },
    },
    components: components(options),
    pageFrames: frameSet(options),
    styles: [
      './dist/styles/tokens.css',
      './dist/styles/shell.css',
      './dist/styles/navigation.css',
      './dist/styles/article.css',
      './dist/styles/overlays.css',
      './dist/styles/responsive.css',
    ],
    assets: [
      './dist/assets/registration-mark.svg',
      './dist/assets/brutalist-cascade.css',
    ],
    clientScripts: ['./dist/client.js'],
  };
};
