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

const components = (options) => ({
  BrutalistMasthead: () => {
    const Component = ({ cfg }) => h('div', { class: 'brutalist-masthead' }, [
      h('a', { class: 'brutalist-wordmark', href: '/', 'aria-label': `${cfg.pageTitle} 首页` }, options.wordmark),
      h('span', { class: 'brutalist-edition', 'aria-hidden': 'true' }, 'ED. 001 / QUARTZ 5'),
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
  BrutalistArticleKicker: () => ({ fileData }) => h('div', { class: 'brutalist-kicker' }, [
    h('span', null, String(fileData.slug ?? 'INDEX').toUpperCase()),
    h('span', null, 'FIELD NOTE / READ'),
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
          renderComponents(props.left, props.componentData, 'brutalist-poster-tools brutalist-tool-rail'),
          h('section', { class: 'brutalist-poster-stage' }, [
            h('div', { class: 'brutalist-issue-number', 'aria-hidden': 'true' }, '01'),
            contentBlock(props),
          ]),
          renderComponents(props.right, props.componentData, 'brutalist-poster-utility brutalist-tool-rail'),
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
          renderComponents(props.left, props.componentData, 'brutalist-editorial-index brutalist-tool-rail'),
          contentBlock(props),
          renderComponents(props.right, props.componentData, 'brutalist-editorial-tools brutalist-tool-rail'),
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
      header: ['BrutalistMasthead'],
      beforeBody: ['BrutalistArticleKicker', 'Breadcrumbs', 'ArticleTitle', 'ContentMeta', 'TagList'],
      afterBody: ['Backlinks'],
      left: ['BrutalistIndexLabel', 'Search', 'Darkmode', 'Explorer'],
      right: ['Graph', 'TableOfContents'],
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
    styles: ['./dist/theme.css'],
    assets: ['./dist/assets/registration-mark.svg'],
    clientScripts: ['./dist/client.js'],
  };
};
