(() => {
  const root = document.documentElement;
  if (root.dataset.brutalistReady === 'true') return;
  root.dataset.brutalistReady = 'true';

  const STORAGE = {
    left: 'pages-publish:brutalist:left-rail',
    right: 'pages-publish:brutalist:right-rail',
    index: 'pages-publish:brutalist:index-expanded',
    reading: 'pages-publish:brutalist:reading-mode',
  };
  const DESKTOP = 1280;
  const TABLET = 1024;
  const noOverlay = 'none';
  const HISTORY_READING_POSITION = 'pagesPublishBrutalistReadingPosition';
  let activeOverlay = noOverlay;
  let lastTrigger;
  let scrollLock;
  let resizeTimer;
  let imageDialog;
  let searchPortal;
  let graphPortal;
  let graphStatus;
  let tocAnnotationFrame;
  let hashRecoveryFrame;
  let hashRecoveryUntil = 0;
  let backdrop;
  let progress;
  let pendingInteraction;
  let readingPositionFrame;
  let pendingHistoryRestore;
  let historyRestoreFrame;
  let historyRestoreUntil = 0;
  let explorerRailFrame;
  let explorerRailPasses = 0;

  const safeStorage = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // A read-only or private browsing storage must not block reading.
      }
    },
  };

  const rail = (side) => document.querySelector(side === 'left'
    ? '.brutalist-editorial-index, .brutalist-poster-tools'
    : '.brutalist-editorial-tools, .brutalist-poster-utility');
  const header = () => document.querySelector('.brutalist-frame-header');
  const article = () => document.querySelector('.brutalist-main');
  const footer = () => document.querySelector('.brutalist-frame-footer');
  const searchButton = () => document.querySelector('.search-button');
  const searchContainer = () => document.querySelector('.search-container');
  const graphDialog = () => document.querySelector('.global-graph-outer');
  const graphTrigger = () => document.querySelector('.global-graph-icon');
  const routeKey = () => `${location.pathname}${location.search}`;
  const focusable = (container) => [...container.querySelectorAll([
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
  ].join(','))].filter((element) => {
    const style = getComputedStyle(element);
    return !element.hasAttribute('hidden')
      && !element.closest('[hidden], [aria-hidden="true"], [inert]')
      && style.display !== 'none'
      && style.visibility !== 'hidden';
  });

  function portalSearch() {
    const panel = searchContainer();
    if (!panel || panel.parentElement === document.body) return panel;
    const placeholder = document.createComment('brutalist-search-home');
    const toolbar = document.createElement('div');
    toolbar.className = 'brutalist-search-dialog-bar';
    const title = document.createElement('p');
    title.textContent = 'SEARCH / 查找笔记';
    const close = document.createElement('button');
    close.type = 'button';
    close.dataset.brutalistAction = 'close-search';
    close.setAttribute('aria-label', '关闭搜索');
    close.textContent = 'CLOSE';
    const hint = document.createElement('p');
    hint.className = 'brutalist-search-dialog-hint';
    hint.textContent = '输入关键词，搜索公开内容';
    toolbar.append(title, close);
    panel.parentElement.insertBefore(placeholder, panel);
    document.body.append(panel);
    panel.prepend(toolbar);
    // The mobile panel pins its toolbar while this inner search space owns
    // result scrolling. Keep the empty-state hint with that scrollable space
    // instead of creating a third, accidental panel row.
    const space = panel.querySelector('.search-space');
    (space ?? panel).append(hint);
    searchPortal = { panel, placeholder, toolbar, hint };
    return panel;
  }

  function restoreSearch() {
    if (!searchPortal?.panel.isConnected) {
      searchPortal = undefined;
      return;
    }
    if (searchPortal.placeholder.isConnected) {
      searchPortal.placeholder.replaceWith(searchPortal.panel);
    }
    searchPortal.toolbar.remove();
    searchPortal.hint.remove();
    searchPortal = undefined;
  }

  function decodeSearchText(value) {
    let decoded = value;
    // Quartz's index can encode code snippets more than once. Decode only
    // twice, then insert text nodes below so a result can never become HTML.
    for (let index = 0; index < 2; index += 1) {
      const decoder = document.createElement('textarea');
      decoder.innerHTML = decoded;
      decoded = decoder.value;
    }
    return decoded.replace(/\s+/gu, ' ').trim();
  }

  function compactSearchResults() {
    for (const description of document.querySelectorAll('.search-layout .card-description')) {
      if (description.dataset.brutalistCompact === 'true') continue;
      const cardTitle = decodeSearchText(
        description.closest('.result-card, .search-result-card')?.querySelector('.card-title')?.textContent ?? '',
      );
      let text = decodeSearchText(description.textContent ?? '');
      // A result title is already its scan anchor. Quartz's raw description
      // often begins with that exact same title, spending the first line on
      // a duplicate instead of the actual matching context.
      if (cardTitle && text.toLocaleLowerCase().startsWith(cardTitle.toLocaleLowerCase())) {
        text = text.slice(cardTitle.length).replace(/^[\s:：—–-]+/u, '').trim();
      }
      const query = description.querySelector('.highlight')?.textContent?.trim() ?? '';
      const matchAt = query ? text.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
      const start = Math.max(0, matchAt < 0 ? 0 : matchAt - 104);
      const end = Math.min(text.length, matchAt < 0 ? 220 : matchAt + query.length + 136);
      const prefix = start > 0 ? '…' : '';
      const suffix = end < text.length ? '…' : '';
      const excerpt = text.slice(start, end);
      const localMatch = query ? excerpt.toLocaleLowerCase().indexOf(query.toLocaleLowerCase()) : -1;
      description.replaceChildren();
      if (localMatch < 0) {
        description.textContent = `${prefix}${excerpt}${suffix}`;
      } else {
        description.append(`${prefix}${excerpt.slice(0, localMatch)}`);
        const highlight = document.createElement('mark');
        highlight.className = 'highlight';
        highlight.textContent = excerpt.slice(localMatch, localMatch + query.length);
        description.append(highlight, `${excerpt.slice(localMatch + query.length)}${suffix}`);
      }
      description.dataset.brutalistCompact = 'true';
    }
  }

  function compactSearchPreview() {
    const panel = searchContainer();
    if (!panel) return;
    const selected = panel.querySelector([
      '.search-layout .result-card.focus[href]',
      '.search-layout .search-result-card.focus[href]',
      '.search-layout .result-card.focus a[href]',
      '.search-layout .search-result-card.focus a[href]',
    ].join(',')) ?? panel.querySelector([
      '.search-layout .result-card[href]',
      '.search-layout .search-result-card[href]',
      '.search-layout .result-card a[href]',
      '.search-layout .search-result-card a[href]',
    ].join(','));
    for (const container of panel.querySelectorAll('.search-layout .preview-container')) {
      const preview = container.querySelector(':scope > .preview-inner');
      const sourceArticle = preview?.querySelector('article');
      const sourceHead = preview?.querySelector('.brutalist-before-body');
      if (!preview || !sourceArticle) continue;

      const title = decodeSearchText(
        sourceHead?.querySelector('.article-title')?.textContent
          ?? sourceArticle.querySelector('h1')?.textContent
          ?? '',
      ) || '预览文章';
      const location = decodeSearchText(sourceHead?.querySelector('.breadcrumb-container')?.textContent ?? '');
      const tagNodes = sourceHead?.querySelectorAll('.tags a');
      const tags = [...(tagNodes?.length ? tagNodes : sourceHead?.querySelectorAll('.tags li') ?? [])]
        .map((tag) => decodeSearchText(tag.textContent ?? ''))
        .filter(Boolean)
        .slice(0, 5);
      const excerpt = [...sourceArticle.querySelectorAll('p')]
        .map((paragraph) => decodeSearchText(paragraph.textContent ?? ''))
        .find((text) => text.length > 24) ?? '';
      const href = selected?.getAttribute('href') ?? '';
      const signature = JSON.stringify({ title, location, tags, excerpt, href });
      let summary = container.querySelector(':scope > .brutalist-search-preview-summary');
      if (summary?.dataset.brutalistSignature === signature) {
        preview.hidden = true;
        preview.setAttribute('aria-hidden', 'true');
        continue;
      }
      if (!summary) {
        summary = document.createElement('section');
        summary.className = 'brutalist-search-preview-summary';
        container.append(summary);
      }
      const eyebrow = document.createElement('p');
      eyebrow.className = 'brutalist-search-preview-summary__eyebrow';
      eyebrow.textContent = 'PREVIEW / 摘要';
      const heading = document.createElement('h2');
      heading.className = 'brutalist-search-preview-summary__title';
      heading.textContent = title;
      const locationLine = document.createElement('p');
      locationLine.className = 'brutalist-search-preview-summary__location';
      locationLine.textContent = location || '公开笔记';
      const tagList = document.createElement('p');
      tagList.className = 'brutalist-search-preview-summary__tags';
      for (const tag of tags) {
        const token = document.createElement('span');
        token.textContent = tag;
        tagList.append(token);
      }
      const excerptLine = document.createElement('p');
      excerptLine.className = 'brutalist-search-preview-summary__excerpt';
      excerptLine.textContent = excerpt.slice(0, 320);
      summary.replaceChildren(eyebrow, locationLine, heading);
      if (tags.length) summary.append(tagList);
      if (excerpt) summary.append(excerptLine);
      if (href) {
        const open = document.createElement('a');
        open.className = 'brutalist-search-preview-summary__open';
        open.href = href;
        open.textContent = 'OPEN ARTICLE / 打开文章';
        summary.append(open);
      }
      summary.dataset.brutalistSignature = signature;
      // Quartz previews the full rendered note, including every body link,
      // table and footnote. Search needs a controlled read-only projection,
      // not a second interactive article nested inside its dialog.
      preview.hidden = true;
      preview.setAttribute('aria-hidden', 'true');
    }
  }

  function clearGraphStatus() {
    if (!graphStatus) return;
    graphStatus.abort?.abort();
    graphStatus.observer?.disconnect();
    graphStatus.nativeFailureObserver?.disconnect();
    graphStatus.status?.remove();
    graphStatus = undefined;
  }

  function setGraphStatus(state, title, detail) {
    if (!graphStatus?.status.isConnected) return;
    const { status } = graphStatus;
    status.dataset.state = state;
    status.replaceChildren();
    const heading = document.createElement('strong');
    heading.textContent = title;
    const message = document.createElement('p');
    message.textContent = detail;
    status.append(heading, message);
    if (state !== 'error') return;
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'RETRY / 重试';
    retry.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const trigger = graphTrigger();
      if (!trigger || activeOverlay !== 'graph') return;
      // `startGraphStatus()` replaces the status subtree that contains this
      // button. Move focus to the persistent dialog control first so retry
      // never lets focus escape an aria-modal dialog.
      (panel.querySelector('[data-brutalist-action="close-graph"]') ?? panel)
        .focus({ preventScroll: true });
      // Quartz owns the graph renderer. Toggle its native control to create
      // a fresh rendering attempt, while the theme retains modal ownership.
      trigger.click();
      requestAnimationFrame(() => {
        const panel = graphDialog();
        if (!panel || activeOverlay !== 'graph') return;
        startGraphStatus(panel);
        trigger.click();
      });
    });
    status.append(retry);
  }

  function startGraphStatus(panel) {
    clearGraphStatus();
    const container = panel.querySelector('.global-graph-container');
    if (!container || container.querySelector('canvas, svg')) return;

    const status = document.createElement('section');
    status.className = 'brutalist-graph-status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.setAttribute('aria-atomic', 'true');
    container.before(status);
    const abort = new AbortController();
    const state = { status, abort };
    graphStatus = state;
    setGraphStatus('loading', '正在建立关系图谱', '正在读取公开笔记之间的关系…');

    const complete = () => {
      if (graphStatus !== state) return;
      clearGraphStatus();
    };
    const fail = (title, detail) => {
      if (graphStatus !== state) return;
      state.observer?.disconnect();
      state.nativeFailureObserver?.disconnect();
      setGraphStatus('error', title, detail);
    };
    const nativeGraphFailed = () => [...document.querySelectorAll('.graph-container')]
      .some((candidate) => /Graph could not load/u.test(candidate.textContent ?? ''));

    state.observer = new MutationObserver(() => {
      if (container.querySelector('canvas, svg')) complete();
    });
    state.observer.observe(container, { childList: true, subtree: true });
    state.nativeFailureObserver = new MutationObserver(() => {
      if (nativeGraphFailed()) {
        fail('图谱无法载入', 'Quartz 图谱运行时未能加载；请检查网络后重试。');
      }
    });
    state.nativeFailureObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    if (nativeGraphFailed()) {
      fail('图谱无法载入', 'Quartz 图谱运行时未能加载；请检查网络后重试。');
      return;
    }

    // The renderer fetches the same Quartz content index. Reading it here
    // gives the dialog a truthful empty/error state without taking over its
    // data model or guessing at an arbitrary loading timeout.
    fetch('/static/contentIndex.json', { signal: abort.signal })
      .then((response) => {
        if (!response.ok) throw new Error(`content index: ${response.status}`);
        return response.json();
      })
      .then((entries) => {
        if (graphStatus !== state || abort.signal.aborted) return;
        if (Object.keys(entries ?? {}).length === 0) {
          state.observer?.disconnect();
          state.nativeFailureObserver?.disconnect();
          setGraphStatus('empty', '暂无可展示的关系', '发布公开笔记并建立链接后，图谱会显示在这里。');
        }
      })
      .catch((error) => {
        if (error.name === 'AbortError' || graphStatus !== state) return;
        fail('图谱数据不可用', '无法读取公开笔记关系；请检查网络后重试。');
      });
  }

  function portalGraph() {
    const panel = graphDialog();
    if (!panel || panel.parentElement === document.body) return panel;
    const placeholder = document.createComment('brutalist-graph-home');
    const toolbar = document.createElement('div');
    toolbar.className = 'brutalist-graph-dialog-bar';
    const title = document.createElement('p');
    title.textContent = 'GRAPH / 知识图谱';
    const close = document.createElement('button');
    close.type = 'button';
    close.dataset.brutalistAction = 'close-graph';
    close.setAttribute('aria-label', '关闭知识图谱');
    close.textContent = 'CLOSE';
    toolbar.append(title, close);
    panel.parentElement.insertBefore(placeholder, panel);
    document.body.append(panel);
    panel.prepend(toolbar);
    graphPortal = { panel, placeholder, toolbar };
    startGraphStatus(panel);
    return panel;
  }

  function restoreGraph() {
    clearGraphStatus();
    if (!graphPortal?.panel.isConnected) {
      graphPortal = undefined;
      return;
    }
    if (graphPortal.placeholder.isConnected) {
      graphPortal.placeholder.replaceWith(graphPortal.panel);
    }
    graphPortal.toolbar.remove();
    graphPortal = undefined;
  }

  function ensureRuntimeChrome() {
    // Quartz's SPA navigation can replace the generated document subtree
    // while this client module deliberately remains alive. Restore only the
    // two body-level presentation primitives that are owned by this theme,
    // so a later route keeps the same progress and modal backdrop language.
    if (!backdrop?.isConnected) {
      const existing = document.querySelector('.brutalist-overlay-backdrop');
      backdrop = existing instanceof HTMLButtonElement ? existing : document.createElement('button');
      backdrop.className = 'brutalist-overlay-backdrop';
      backdrop.type = 'button';
      backdrop.tabIndex = -1;
      backdrop.setAttribute('aria-label', '关闭浮层');
      if (!backdrop.isConnected) document.body.append(backdrop);
      if (backdrop.dataset.brutalistBackdropBound !== 'true') {
        backdrop.dataset.brutalistBackdropBound = 'true';
        backdrop.addEventListener('click', () => closeOverlay());
      }
    }

    if (!progress?.isConnected) {
      const existing = document.querySelector('.brutalist-reading-progress');
      progress = existing instanceof HTMLDivElement ? existing : document.createElement('div');
      progress.className = 'brutalist-reading-progress';
      progress.setAttribute('role', 'progressbar');
      progress.setAttribute('aria-label', '阅读进度');
      progress.setAttribute('aria-valuemin', '0');
      progress.setAttribute('aria-valuemax', '100');
      if (!progress.isConnected) document.body.append(progress);
    }
  }

  const viewport = () => ({
    desktop: innerWidth >= DESKTOP,
    compact: innerWidth >= TABLET && innerWidth < DESKTOP,
  });

  const isFocused = () => root.dataset.readingMode === 'focused';

  function setVisibleLabel(button, label) {
    if (!button) return;
    button.setAttribute('aria-label', label);
    const visible = button.querySelector(':scope > span[aria-hidden="true"]');
    if (visible && button.dataset.brutalistAction === 'focus') {
      const focused = label === '退出专注阅读';
      visible.textContent = focused ? 'EXIT' : 'FOCUS';
      visible.dataset.mobileLabel = focused ? 'EXIT' : 'READ';
    }
  }

  function syncControls() {
    const { desktop } = viewport();
    const leftExpanded = root.dataset.leftRail === 'expanded';
    const rightExpanded = root.dataset.rightRail === 'expanded';
    const outlineAvailable = Boolean(document.querySelector('.toc a[href]'));
    for (const button of document.querySelectorAll('[data-brutalist-action="navigation"]')) {
      const expanded = activeOverlay === 'navigation' || (desktop && !isFocused() && leftExpanded);
      button.setAttribute('aria-expanded', String(expanded));
      setVisibleLabel(button, expanded ? '收起站点导航' : '展开站点导航');
    }
    for (const button of document.querySelectorAll('[data-brutalist-action="outline"]')) {
      button.hidden = !outlineAvailable;
      const expanded = outlineAvailable && (
        activeOverlay === 'outline' || (desktop && !isFocused() && rightExpanded)
      );
      button.setAttribute('aria-expanded', String(expanded));
      setVisibleLabel(button, expanded ? '收起本文目录' : '展开本文目录');
    }
    for (const button of document.querySelectorAll('[data-brutalist-action="focus"]')) {
      button.setAttribute('aria-pressed', String(isFocused()));
      setVisibleLabel(button, isFocused() ? '退出专注阅读' : '进入专注阅读');
    }
  }

  function assignArticleLabel() {
    const heading = document.querySelector('.brutalist-main .article-title');
    const main = article();
    if (!heading || !main) return;
    heading.id = 'brutalist-article-title';
    main.setAttribute('aria-labelledby', heading.id);
  }

  function syncReadingContext() {
    const context = document.querySelector('.brutalist-reading-context');
    if (!context) return;
    const title = document.querySelector('.brutalist-main .article-title')?.textContent?.trim();
    context.textContent = title || 'READING';
    if (title) {
      context.setAttribute('aria-label', `当前阅读：${title}`);
      context.setAttribute('title', title);
    } else {
      context.setAttribute('aria-label', '当前阅读内容');
      context.removeAttribute('title');
    }
  }

  function annotateGraphTrigger() {
    const trigger = graphTrigger();
    if (!trigger) return;
    trigger.setAttribute('aria-label', '打开全局知识图谱');
    trigger.setAttribute('title', '打开全局知识图谱');
  }

  function presentImageFailure(image) {
    if (image.dataset.brutalistImageFailed === 'true' || !image.isConnected) return;
    const alt = image.getAttribute('alt')?.trim();
    const fallback = document.createElement('div');
    fallback.className = 'brutalist-image-fallback';
    fallback.setAttribute('role', 'img');
    fallback.setAttribute('aria-label', alt ? `图片无法加载：${alt}` : '图片无法加载');

    const label = document.createElement('span');
    label.className = 'brutalist-image-fallback__label';
    label.textContent = 'IMAGE UNAVAILABLE';
    const detail = document.createElement('p');
    detail.className = 'brutalist-image-fallback__detail';
    detail.textContent = alt ? `无法加载图片：${alt}` : '无法加载图片。';
    fallback.append(label, detail);

    image.dataset.brutalistImageFailed = 'true';
    image.removeAttribute('tabindex');
    image.removeAttribute('role');
    image.removeAttribute('aria-haspopup');
    image.removeAttribute('aria-label');
    image.removeAttribute('title');
    delete image.dataset.brutalistImagePreview;
    image.setAttribute('aria-hidden', 'true');
    image.insertAdjacentElement('afterend', fallback);
  }

  function annotateImageFailures() {
    for (const image of document.querySelectorAll('.brutalist-main article img[src]')) {
      if (image.complete && image.naturalWidth === 0) presentImageFailure(image);
    }
  }

  function annotateArticleImages() {
    for (const image of document.querySelectorAll('.brutalist-main article img[src]')) {
      if (image.dataset.brutalistImageFailed === 'true' || image.closest('a')) continue;
      const alt = image.getAttribute('alt')?.trim();
      image.dataset.brutalistImagePreview = 'true';
      image.tabIndex = 0;
      image.setAttribute('role', 'button');
      image.setAttribute('aria-haspopup', 'dialog');
      image.setAttribute('aria-label', alt ? `放大图片：${alt}` : '放大图片');
      image.setAttribute('title', '点击或按 Enter 放大图片');
    }
  }

  function annotateScrollableTables() {
    for (const container of document.querySelectorAll('.brutalist-main .table-container')) {
      const table = container.querySelector('table');
      if (!table) continue;
      const overflowing = container.scrollWidth > container.clientWidth + 1;
      const previousHint = container.nextElementSibling?.matches('.brutalist-scroll-hint')
        ? container.nextElementSibling
        : undefined;
      if (!overflowing) {
        if (container.dataset.brutalistScrollRegion === 'true') {
          delete container.dataset.brutalistScrollRegion;
          container.removeAttribute('role');
          container.removeAttribute('aria-label');
          container.removeAttribute('tabindex');
        }
        previousHint?.remove();
        continue;
      }

      container.dataset.brutalistScrollRegion = 'true';
      container.tabIndex = 0;
      container.setAttribute('role', 'region');
      container.setAttribute('aria-label', '可横向滚动的表格；使用左右方向键浏览');
      if (previousHint) continue;
      const hint = document.createElement('p');
      hint.className = 'brutalist-scroll-hint';
      hint.setAttribute('aria-hidden', 'true');
      hint.textContent = '← SCROLL TABLE →';
      container.insertAdjacentElement('afterend', hint);
    }
  }

  function annotateCollapsibleCallouts() {
    for (const callout of document.querySelectorAll('.brutalist-main .callout.is-collapsible')) {
      const title = callout.querySelector(':scope > .callout-title');
      const content = callout.querySelector(':scope > .callout-content');
      if (!title || !content) continue;
      if (!content.id) content.id = `brutalist-callout-${crypto.randomUUID()}`;
      title.tabIndex = 0;
      title.setAttribute('role', 'button');
      title.setAttribute('aria-controls', content.id);
      title.setAttribute('aria-expanded', String(!callout.classList.contains('is-collapsed')));
      if (title.dataset.brutalistCalloutBound === 'true') continue;
      title.dataset.brutalistCalloutBound = 'true';
      const sync = () => queueMicrotask(() => {
        if (title.isConnected) {
          title.setAttribute('aria-expanded', String(!callout.classList.contains('is-collapsed')));
        }
      });
      title.addEventListener('click', sync);
      title.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        title.click();
      });
    }
  }

  function enhanceTagIndex() {
    if (document.body.dataset.slug !== 'tags/index') return;
    const content = document.querySelector('.brutalist-main > .popover-hint');
    if (!content) return;
    for (const heading of content.querySelectorAll('h2')) {
      const listing = heading.nextElementSibling;
      const group = heading.parentElement;
      const tagLink = heading.querySelector('a[href]');
      if (
        !group
        || !tagLink
        || !listing?.matches('.page-listing')
        || group.dataset.brutalistTagGroup === 'true'
      ) continue;

      const tagName = tagLink.textContent?.trim() || '标签';
      const count = listing.querySelector(':scope > p')?.textContent?.trim() || '条目';
      const disclosure = document.createElement('details');
      disclosure.className = 'brutalist-tag-index-disclosure';
      const summary = document.createElement('summary');
      const action = document.createElement('span');
      action.className = 'brutalist-tag-index-disclosure__action';
      const countLabel = document.createElement('span');
      countLabel.className = 'brutalist-tag-index-disclosure__count';
      countLabel.textContent = count;
      summary.append(action, countLabel);
      disclosure.append(summary, listing);
      listing.before(disclosure);
      group.classList.add('brutalist-tag-index-group');
      group.dataset.brutalistTagGroup = 'true';

      const sync = () => {
        const verb = disclosure.open ? '收起' : '展开';
        action.textContent = `${verb}条目`;
        summary.setAttribute('aria-label', `${verb}标签 ${tagName} 的${count}`);
      };
      disclosure.addEventListener('toggle', sync);
      sync();
    }
  }

  function protectCjkTitlePhrases() {
    const heading = document.querySelector('.brutalist-main .article-title');
    const Segmenter = globalThis.Intl?.Segmenter;
    const containsHan = /[\u3400-\u9fff\uf900-\ufaff]/u;
    if (
      !heading
      || heading.dataset.brutalistPhrases === 'true'
      || heading.childElementCount > 0
      || !Segmenter
      || !containsHan.test(heading.textContent ?? '')
    ) return;

    const fragment = document.createDocumentFragment();
    let protectedPhrase = false;
    const segmenter = new Segmenter('zh-CN', { granularity: 'word' });
    for (const { segment, isWordLike } of segmenter.segment(heading.textContent ?? '')) {
      if (isWordLike && segment.length > 1 && containsHan.test(segment)) {
        const phrase = document.createElement('span');
        phrase.className = 'brutalist-title-phrase';
        phrase.textContent = segment;
        fragment.append(phrase);
        protectedPhrase = true;
      } else {
        fragment.append(segment);
      }
    }
    if (!protectedPhrase) return;
    heading.replaceChildren(fragment);
    heading.dataset.brutalistPhrases = 'true';
  }

  function annotateExplorer() {
    for (const explorer of document.querySelectorAll('.explorer')) {
      const title = explorer.querySelector('.title-button');
      const content = explorer.querySelector('.explorer-content');
      if (!title || !content) continue;
      if (!content.id) content.id = 'brutalist-browse-index';
      title.setAttribute('aria-controls', content.id);
      const heading = title.querySelector('h2');
      if (heading && heading.textContent?.trim() !== '浏览索引') heading.textContent = '浏览索引';
      if (explorer.dataset.brutalistIndexExpanded === undefined) {
        explorer.dataset.brutalistIndexExpanded = safeStorage.get(STORAGE.index) === 'false'
          ? 'false'
          : 'true';
      }
      const expanded = explorer.dataset.brutalistIndexExpanded === 'true';
      content.hidden = !expanded;
      title.setAttribute('aria-expanded', String(expanded));
      title.setAttribute('aria-label', expanded ? '收起浏览索引' : '展开浏览索引');
    }
    for (const link of document.querySelectorAll('.explorer a.nav-file-title')) {
      const label = link.textContent?.trim();
      if (label && !link.hasAttribute('title')) link.setAttribute('title', label);
      if (link.classList.contains('active') || link.classList.contains('is-active')) {
        link.setAttribute('aria-current', 'page');
      }
    }
    scheduleExplorerRailStabilization();
  }

  function bindExplorerToggle() {
    for (const explorer of document.querySelectorAll('.explorer')) {
      const title = explorer.querySelector('.title-button');
      if (!title || title.dataset.brutalistIndexToggleBound === 'true') continue;
      title.dataset.brutalistIndexToggleBound = 'true';
      title.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        const expanded = explorer.dataset.brutalistIndexExpanded !== 'true';
        explorer.dataset.brutalistIndexExpanded = String(expanded);
        safeStorage.set(STORAGE.index, String(expanded));
        annotateExplorer();
      }, { capture: true });
    }
  }

  function stabilizeExplorerRail() {
    if (
      activeOverlay !== noOverlay
      || isFocused()
      || !viewport().desktop
      || root.dataset.leftRail !== 'expanded'
      || userMovedPage
    ) return false;
    const shell = rail('left');
    const scroller = shell?.querySelector('.explorer-content');
    const active = shell?.querySelector('.explorer a[aria-current="page"], .explorer a.active, .explorer a.is-active');
    if (!shell || !scroller || !active) return false;

    // Quartz can call `scrollIntoView()` on the active tree row after it
    // hydrates. The rail itself may be programmatically scrolled even with
    // CSS overflow hidden, which makes Search/NAV/theme controls disappear.
    // Restore the shell first, then keep that row inside the dedicated tree
    // scroller using a bounded nearest-edge adjustment.
    if (shell.scrollTop) shell.scrollTop = 0;
    const view = scroller.getBoundingClientRect();
    const target = active.getBoundingClientRect();
    const gutter = 12;
    if (target.top < view.top + gutter) {
      scroller.scrollTop += target.top - view.top - gutter;
    } else if (target.bottom > view.bottom - gutter) {
      scroller.scrollTop += target.bottom - view.bottom + gutter;
    }
    return true;
  }

  function scheduleExplorerRailStabilization() {
    if (explorerRailFrame) return;
    explorerRailPasses = 4;
    const settle = () => {
      explorerRailFrame = undefined;
      stabilizeExplorerRail();
      explorerRailPasses -= 1;
      if (explorerRailPasses > 0 && !userMovedPage) {
        explorerRailFrame = requestAnimationFrame(settle);
      }
    };
    explorerRailFrame = requestAnimationFrame(settle);
  }

  function enhanceTableOfContents() {
    const toc = rail('right')?.querySelector('.toc');
    const list = toc?.querySelector('.toc-content');
    if (!list) return;

    const items = [...list.children].filter((item) => item.matches('li'));
    const sectionItems = items.filter((item) => (
      !item.classList.contains('depth-0')
      && !item.classList.contains('overflow-end')
      && item.querySelector(':scope > a[href]')
    ));
    const minutes = document.querySelector('.content-meta')?.textContent?.match(/\d+/u)?.[0] ?? '1';
    const meta = rail('right')?.querySelector('.brutalist-outline-heading__meta');
    if (meta) meta.textContent = `${sectionItems.length} SECTIONS · ${minutes} MIN READ`;

    for (const item of sectionItems) {
      const isChild = item.classList.contains('depth-2');
      item.classList.toggle('brutalist-toc-child', isChild);
      if (isChild) continue;

      const children = [];
      let candidate = item.nextElementSibling;
      while (candidate?.classList.contains('depth-2')) {
        children.push(candidate);
        candidate = candidate.nextElementSibling;
      }
      const isParent = children.length > 0;
      item.classList.toggle('brutalist-toc-parent', isParent);
      item.classList.toggle('brutalist-toc-leaf', !isParent);
      if (!isParent) continue;

      let button = item.querySelector(':scope > .brutalist-toc-branch-toggle');
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'brutalist-toc-branch-toggle';
        item.prepend(button);
      }
      const title = item.querySelector(':scope > a')?.textContent?.trim() ?? '章节';
      const setExpanded = (expanded) => {
        button.setAttribute('aria-expanded', String(expanded));
        button.setAttribute('aria-label', `${expanded ? '收起' : '展开'} ${title}`);
        for (const child of children) child.hidden = !expanded;
      };
      if (button.dataset.brutalistBound !== 'true') {
        button.dataset.brutalistBound = 'true';
        button.addEventListener('click', () => {
          setExpanded(button.getAttribute('aria-expanded') !== 'true');
        });
      }
      setExpanded(button.getAttribute('aria-expanded') !== 'false');
    }
  }

  function annotateTableOfContents() {
    const links = [...document.querySelectorAll('.toc a')];
    const readingLine = (header()?.getBoundingClientRect().bottom ?? 0) + 32;
    const visible = links.filter((link) => link.classList.contains('in-view'));
    let current;

    // Quartz may leave several preceding and upcoming headings marked
    // `.in-view`. The reader's actual location is the last marked heading at
    // the reading line, falling back to the first marked heading ahead.
    for (const link of visible) {
      const href = link.getAttribute('href');
      const heading = href?.startsWith('#') ? document.getElementById(href.slice(1)) : null;
      if (!heading) continue;
      if (heading.getBoundingClientRect().top <= readingLine) current = link;
      else if (!current) {
        current = link;
        break;
      }
    }
    current ??= visible[0];

    for (const link of links) {
      const isCurrent = link === current;
      if (isCurrent) {
        link.setAttribute('aria-current', 'location');
      } else {
        link.removeAttribute('aria-current');
      }
    }

    const currentItem = current?.closest('li.brutalist-toc-child');
    if (currentItem?.hidden) {
      let parent = currentItem.previousElementSibling;
      while (parent?.classList.contains('brutalist-toc-child')) parent = parent.previousElementSibling;
      const button = parent?.querySelector(':scope > .brutalist-toc-branch-toggle');
      if (button?.getAttribute('aria-expanded') === 'false') button.click();
    }
  }

  function scheduleTableOfContentsAnnotation() {
    if (tocAnnotationFrame) return;
    tocAnnotationFrame = requestAnimationFrame(() => {
      tocAnnotationFrame = undefined;
      annotateTableOfContents();
    });
  }

  function applyViewport() {
    const { desktop } = viewport();
    const preference = safeStorage.get(STORAGE.reading);
    if (preference === 'focused') root.dataset.readingMode = 'focused';
    if (isFocused()) {
      root.dataset.leftRail = desktop ? 'hidden' : 'drawer';
      root.dataset.rightRail = desktop ? safeStorage.get(STORAGE.right) === 'hidden' ? 'hidden' : 'expanded' : 'drawer';
      syncFocusedRailInteractivity();
      syncControls();
      return;
    }
    root.dataset.readingMode = 'standard';
    const leftPreference = safeStorage.get(STORAGE.left);
    root.dataset.leftRail = desktop
      ? leftPreference === 'hidden' || leftPreference === 'compact' ? 'hidden' : 'expanded'
      : 'drawer';
    root.dataset.rightRail = desktop
      ? safeStorage.get(STORAGE.right) === 'hidden' ? 'hidden' : 'expanded'
      : 'drawer';
    syncFocusedRailInteractivity();
    syncControls();
  }

  function modalFor(overlay) {
    if (overlay === 'navigation') return rail('left');
    if (overlay === 'outline') return rail('right');
    if (overlay === 'search') return searchContainer();
    if (overlay === 'graph') return graphDialog();
    if (overlay === 'image') return imageDialog;
    return null;
  }

  function setModalSemantics(overlay) {
    for (const candidate of [rail('left'), rail('right'), searchContainer(), graphDialog(), imageDialog]) {
      if (!candidate) continue;
      candidate.removeAttribute('role');
      candidate.removeAttribute('aria-modal');
      candidate.removeAttribute('tabindex');
    }
    const modal = modalFor(overlay);
    if (!modal) return null;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('tabindex', '-1');
    modal.setAttribute('aria-label', {
      navigation: '站点导航',
      outline: '本文目录',
      search: '搜索站点内容',
      graph: '知识图谱',
      image: '图片预览',
    }[overlay] ?? '浮层');
    return modal;
  }

  function setBackgroundInert(modal) {
    const regions = [header(), article(), footer(), rail('left'), rail('right')].filter(Boolean);
    for (const region of regions) {
      const isModalRegion = modal && (region === modal || region.contains(modal));
      if (modal && !isModalRegion) {
        region.inert = true;
        region.setAttribute('inert', '');
        region.dataset.brutalistInert = 'true';
        region.setAttribute('aria-hidden', 'true');
      } else if (region.dataset.brutalistInert === 'true') {
        region.inert = false;
        region.removeAttribute('inert');
        delete region.dataset.brutalistInert;
        region.removeAttribute('aria-hidden');
      }
    }
  }

  function syncFocusedRailInteractivity() {
    for (const [side, overlay] of [['left', 'navigation'], ['right', 'outline']]) {
      const candidate = rail(side);
      if (!candidate) continue;
      const shouldHide = isFocused() && activeOverlay !== overlay;
      if (shouldHide) {
        if (candidate.dataset.brutalistFocusedRailInert === undefined) {
          candidate.dataset.brutalistFocusedRailInert = candidate.getAttribute('aria-hidden') ?? '';
        }
        candidate.inert = shouldHide;
        candidate.setAttribute('aria-hidden', 'true');
        continue;
      }
      if (candidate.dataset.brutalistFocusedRailInert === undefined) continue;
      candidate.inert = false;
      const previousAriaHidden = candidate.dataset.brutalistFocusedRailInert;
      delete candidate.dataset.brutalistFocusedRailInert;
      if (previousAriaHidden) candidate.setAttribute('aria-hidden', previousAriaHidden);
      else candidate.removeAttribute('aria-hidden');
    }
  }

  function lockDocument(requestedTop = scrollY) {
    if (scrollLock) return;
    const top = Number.isFinite(requestedTop) ? Math.max(0, requestedTop) : scrollY;
    if (Math.abs(scrollY - top) > 1) {
      scrollTo({ top, left: 0, behavior: 'instant' });
    }
    const scrollbar = Math.max(0, innerWidth - document.documentElement.clientWidth);
    scrollLock = {
      top,
      position: document.body.style.position,
      topStyle: document.body.style.top,
      width: document.body.style.width,
      paddingRight: document.body.style.paddingRight,
      overflow: document.body.style.overflow,
    };
    document.body.style.position = 'fixed';
    document.body.style.top = `-${top}px`;
    document.body.style.width = '100%';
    document.body.style.paddingRight = `${scrollbar}px`;
    document.body.style.overflow = 'hidden';
  }

  function unlockDocument({ restoreScroll = true } = {}) {
    if (!scrollLock) return;
    const previous = scrollLock;
    document.body.style.position = previous.position;
    document.body.style.top = previous.topStyle;
    document.body.style.width = previous.width;
    document.body.style.paddingRight = previous.paddingRight;
    document.body.style.overflow = previous.overflow;
    scrollLock = undefined;
    if (restoreScroll) scrollTo({ top: previous.top, left: 0, behavior: 'instant' });
  }

  function restoreReadingPosition(top) {
    if (!Number.isFinite(top) || top < 0) return;
    // The same-URL history entry used for a modal can make Quartz run its
    // normal route-scroll routine after the body has been unlocked. Reassert
    // the captured reading position only for that tiny settling window, and
    // immediately yield to any new pointer, wheel, touch or keyboard input.
    let interrupted = false;
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
    const interrupt = () => {
      interrupted = true;
    };
    const cleanup = () => {
      for (const event of events) removeEventListener(event, interrupt, true);
    };
    for (const event of events) {
      addEventListener(event, interrupt, { passive: true, once: true, capture: true });
    }
    const restore = () => {
      if (interrupted || activeOverlay !== noOverlay) return;
      if (Math.abs(scrollY - top) > 1) {
        scrollTo({ top, left: 0, behavior: 'instant' });
      }
    };
    let frames = 4;
    const settle = () => {
      restore();
      frames -= 1;
      if (frames > 0 && !interrupted) requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
    setTimeout(() => {
      restore();
      cleanup();
    }, 120);
  }

  function cancelHistoryReadingRestore() {
    historyRestoreUntil = 0;
    if (historyRestoreFrame) cancelAnimationFrame(historyRestoreFrame);
    historyRestoreFrame = undefined;
  }

  function restoreHistoryReadingPosition(top) {
    if (!Number.isFinite(top) || top < 0) return;
    cancelHistoryReadingRestore();
    // Quartz can hydrate Explorer after its SPA `nav` event and issue a late
    // scroll. Preserve the reader's history context through that window, but
    // surrender immediately to wheel, touch, pointer or keyboard input.
    historyRestoreUntil = performance.now() + 1000;
    const restore = () => {
      if (
        userMovedPage
        || activeOverlay !== noOverlay
        || historyRestoreUntil <= performance.now()
      ) {
        cancelHistoryReadingRestore();
        return;
      }
      if (Math.abs(scrollY - top) > 1) {
        scrollTo({ top, left: 0, behavior: 'instant' });
      }
      historyRestoreFrame = requestAnimationFrame(restore);
    };
    historyRestoreFrame = requestAnimationFrame(restore);
  }

  const storedReadingPositionKey = (path = routeKey()) => (
    `${HISTORY_READING_POSITION}:${encodeURIComponent(path)}`
  );

  function readStoredReadingPosition() {
    try {
      const value = sessionStorage.getItem(storedReadingPositionKey());
      if (!value) return undefined;
      const position = JSON.parse(value);
      return position?.path === routeKey() && Number.isFinite(position.top)
        ? position
        : undefined;
    } catch {
      // Private browsing and locked-down WebViews can reject session storage.
      return undefined;
    }
  }

  function currentHistoryReadingPosition({ allowStored = false } = {}) {
    const fromHistory = history.state?.[HISTORY_READING_POSITION];
    if (fromHistory?.path === routeKey() && Number.isFinite(fromHistory.top)) {
      return fromHistory;
    }
    return allowStored ? readStoredReadingPosition() : undefined;
  }

  function persistReadingPosition() {
    if (activeOverlay !== noOverlay || scrollLock) return;
    const top = Math.max(0, Math.round(scrollY));
    const previous = history.state && typeof history.state === 'object' ? history.state : {};
    const current = previous[HISTORY_READING_POSITION];
    const path = routeKey();
    const position = { path, top };
    if (current?.path !== path || current.top !== top) {
      history.replaceState({
        ...previous,
        [HISTORY_READING_POSITION]: position,
      }, '', location.href);
    }
    // Quartz may replace a history-state object during a full document
    // traversal. Keep a same-tab fallback so the browser's native scroll
    // restoration cannot return a reader to the Explorer's last row.
    try {
      sessionStorage.setItem(storedReadingPositionKey(path), JSON.stringify(position));
    } catch {
      // History-state restoration remains available when storage is blocked.
    }
  }

  function queueReadingPositionPersistence() {
    if (readingPositionFrame || activeOverlay !== noOverlay || scrollLock) return;
    readingPositionFrame = requestAnimationFrame(() => {
      readingPositionFrame = undefined;
      persistReadingPosition();
    });
  }

  function focusModal(overlay) {
    requestAnimationFrame(() => {
      const modal = modalFor(overlay);
      if (!modal || root.dataset.overlay !== overlay) return;
      const target = overlay === 'search'
        ? modal.querySelector('input')
        : focusable(modal)[0] ?? modal;
      target.focus({ preventScroll: true });
    });
  }

  function closeNativeOverlay(overlay) {
    if (overlay === 'search') {
      const button = searchButton();
      if (button?.getAttribute('aria-expanded') === 'true') button.click();
      restoreSearch();
    }
    if (overlay === 'graph') {
      graphTrigger()?.click();
      restoreGraph();
    }
    if (overlay === 'image') {
      imageDialog?.remove();
      imageDialog = undefined;
    }
  }

  function isVisibleFocusTarget(target) {
    if (!target?.isConnected || target.hasAttribute('hidden') || target.closest('[inert]')) return false;
    const style = getComputedStyle(target);
    return style.display !== 'none'
      && style.visibility !== 'hidden'
      && target.getClientRects().length > 0;
  }

  function restoreOverlayFocus(closing) {
    const action = {
      navigation: 'navigation',
      outline: 'outline',
      search: 'search',
      graph: 'graph',
    }[closing];
    const candidates = [lastTrigger];
    if (action) {
      candidates.push(...document.querySelectorAll(`[data-brutalist-action="${action}"]`));
    }
    if (closing === 'graph') candidates.push(graphTrigger());
    // Browser history may restore its own focus after `popstate`. Defer one
    // frame so Back/resize cannot leave a keyboard user on a hidden drawer.
    requestAnimationFrame(() => {
      if (activeOverlay !== noOverlay) return;
      const target = candidates.find(isVisibleFocusTarget);
      if (target) {
        target.focus({ preventScroll: true });
        return;
      }
      const main = article();
      if (!main) return;
      main.tabIndex = -1;
      main.focus({ preventScroll: true });
    });
  }

  function closeOverlay({
    restoreFocus = true,
    restoreScroll = true,
    fromHistory = false,
    skipHistory = false,
  } = {}) {
    const closing = activeOverlay;
    if (closing === noOverlay) return;
    const restoreTop = scrollLock?.top ?? scrollY;
    closeNativeOverlay(closing);
    activeOverlay = noOverlay;
    root.dataset.overlay = noOverlay;
    setModalSemantics(noOverlay);
    setBackgroundInert(null);
    syncFocusedRailInteractivity();
    unlockDocument({ restoreScroll });
    syncControls();
    if (!fromHistory && !skipHistory && history.state?.pagesPublishBrutalistOverlay === closing) {
      history.back();
    }
    if (restoreScroll) restoreReadingPosition(restoreTop);
    if (restoreFocus) restoreOverlayFocus(closing);
    lastTrigger = undefined;
  }

  function openOverlay(overlay, trigger, { historyEntry = true } = {}) {
    ensureRuntimeChrome();
    const openingTop = pendingInteraction?.trigger === trigger
      ? pendingInteraction.top
      : scrollY;
    pendingInteraction = undefined;
    if (activeOverlay === overlay) {
      closeOverlay();
      return;
    }
    if (activeOverlay !== noOverlay) closeOverlay({ restoreFocus: false, skipHistory: true });
    activeOverlay = overlay;
    lastTrigger = trigger;
    root.dataset.overlay = overlay;
    syncFocusedRailInteractivity();
    const modal = setModalSemantics(overlay);
    setBackgroundInert(modal);
    lockDocument(openingTop);
    syncControls();
    if (historyEntry) {
      history.pushState({ ...history.state, pagesPublishBrutalistOverlay: overlay }, '', location.href);
    }
    focusModal(overlay);
  }

  function toggleNavigation(trigger) {
    if (viewport().desktop && !isFocused()) {
      const next = root.dataset.leftRail === 'expanded' ? 'hidden' : 'expanded';
      root.dataset.leftRail = next;
      safeStorage.set(STORAGE.left, next);
      syncControls();
      return;
    }
    openOverlay('navigation', trigger);
  }

  function toggleOutline(trigger) {
    if (!document.querySelector('.toc a[href]')) return;
    if (viewport().desktop && !isFocused()) {
      const next = root.dataset.rightRail === 'expanded' ? 'hidden' : 'expanded';
      root.dataset.rightRail = next;
      safeStorage.set(STORAGE.right, next);
      syncControls();
      return;
    }
    openOverlay('outline', trigger);
  }

  function toggleFocus(trigger) {
    if (activeOverlay !== noOverlay) closeOverlay({ restoreFocus: false, skipHistory: true });
    if (isFocused()) {
      safeStorage.set(STORAGE.reading, 'standard');
      root.dataset.readingMode = 'standard';
      applyViewport();
    } else {
      safeStorage.set(STORAGE.reading, 'focused');
      root.dataset.readingMode = 'focused';
      applyViewport();
    }
    lastTrigger = trigger;
    syncControls();
  }

  function openSearch(trigger) {
    const button = searchButton();
    if (!button) return;
    const panel = portalSearch();
    if (!panel) return;
    openOverlay('search', trigger);
    if (button?.getAttribute('aria-expanded') !== 'true') {
      button.dataset.brutalistNativeSearchOpening = 'true';
      button.click();
    }
    requestAnimationFrame(() => searchContainer()?.querySelector('input')?.focus({ preventScroll: true }));
  }

  function openGraph(trigger) {
    const button = graphTrigger();
    if (!button) return;
    button.click();
  }

  function promoteGraph(trigger) {
    const panel = portalGraph();
    if (!panel || activeOverlay === 'graph') return;
    openOverlay('graph', trigger);
  }

  function openImage(image, trigger) {
    if (!image.currentSrc && !image.src) return;
    imageDialog?.remove();
    const dialog = document.createElement('section');
    dialog.className = 'brutalist-image-dialog';
    dialog.innerHTML = '<button type="button" class="brutalist-image-dialog__close" aria-label="关闭图片预览">CLOSE</button>';
    const clone = image.cloneNode(true);
    clone.removeAttribute('id');
    clone.removeAttribute('tabindex');
    clone.removeAttribute('role');
    clone.removeAttribute('aria-haspopup');
    clone.removeAttribute('aria-label');
    clone.removeAttribute('title');
    delete clone.dataset.brutalistImagePreview;
    dialog.append(clone);
    const previewStatus = document.createElement('p');
    previewStatus.className = 'brutalist-image-dialog__status';
    previewStatus.setAttribute('role', 'status');
    previewStatus.setAttribute('aria-live', 'polite');
    previewStatus.textContent = '正在载入图片…';
    clone.before(previewStatus);
    const previewLoaded = () => previewStatus.remove();
    const previewFailed = () => {
      previewStatus.remove();
      if (!clone.isConnected) return;
      const fallback = document.createElement('p');
      fallback.className = 'brutalist-image-dialog__fallback';
      fallback.setAttribute('role', 'img');
      const description = image.alt?.trim() || '图片预览不可用';
      fallback.setAttribute('aria-label', description);
      fallback.textContent = `图片预览不可用：${description}`;
      clone.replaceWith(fallback);
    };
    clone.addEventListener('load', previewLoaded, { once: true });
    clone.addEventListener('error', previewFailed, { once: true });
    if (clone.complete) {
      queueMicrotask(() => {
        if (clone.naturalWidth > 0) previewLoaded();
        else previewFailed();
      });
    }
    if (image.alt) {
      const caption = document.createElement('p');
      caption.className = 'brutalist-image-dialog__caption';
      caption.textContent = image.alt;
      dialog.append(caption);
    }
    document.body.append(dialog);
    imageDialog = dialog;
    openOverlay('image', trigger);
  }

  function handleAction(event) {
    const trigger = event.target.closest('[data-brutalist-action]');
    if (!trigger) return false;
    event.preventDefault();
    const action = trigger.dataset.brutalistAction;
    if (action === 'navigation') toggleNavigation(trigger);
    else if (action === 'outline') toggleOutline(trigger);
    else if (action === 'focus') toggleFocus(trigger);
    else if (action === 'search') openSearch(trigger);
    else if (action === 'graph') openGraph(trigger);
    else if (
      action === 'close-navigation'
      || action === 'close-outline'
      || action === 'close-search'
      || action === 'close-graph'
    ) closeOverlay();
    return true;
  }

  function bindCloseControls() {
    for (const button of document.querySelectorAll('[data-brutalist-action^="close-"]')) {
      if (button.dataset.brutalistCloseBound === 'true') continue;
      button.dataset.brutalistCloseBound = 'true';
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        closeOverlay();
      });
    }
  }

  function bindNativeSearchTrigger() {
    const button = searchButton();
    if (!button || button.dataset.brutalistNativeSearchBound === 'true') return;
    button.dataset.brutalistNativeSearchBound = 'true';
    // The visible rail button belongs to Quartz. Route a reader's direct
    // activation through the same theme dialog owner as FIND; otherwise the
    // native button can recreate a panel that the state machine correctly
    // keeps hidden after a route transition.
    button.addEventListener('click', (event) => {
      if (button.dataset.brutalistNativeSearchOpening === 'true') {
        delete button.dataset.brutalistNativeSearchOpening;
        return;
      }
      if (activeOverlay === 'search') return;
      if (!searchContainer()) {
        // Quartz can mount Search one microtask after a client-side route
        // render. Let that first native click initialise its DOM, then take
        // ownership without issuing a second click that would close it again.
        queueMicrotask(() => {
          if (activeOverlay === noOverlay && searchContainer()) openSearch(button);
        });
        return;
      }
      event.preventDefault();
      event.stopImmediatePropagation();
      openSearch(button);
    }, true);
  }

  document.addEventListener('pointerdown', (event) => {
    if (!(event.target instanceof Element)) {
      pendingInteraction = undefined;
      return;
    }
    const trigger = event.target.closest([
      '[data-brutalist-action]',
      '.global-graph-icon',
      '.brutalist-main article img[data-brutalist-image-preview="true"]',
    ].join(','));
    pendingInteraction = trigger ? { trigger, top: scrollY } : undefined;
  }, { capture: true, passive: true });

  function bindOverlayRouteActivation() {
    for (const link of document.querySelectorAll([
      '#brutalist-site-navigation a[href]',
      '#brutalist-article-utilities a[href]',
    ].join(','))) {
      if (link.dataset.brutalistOverlayRouteBound === 'true') continue;
      link.dataset.brutalistOverlayRouteBound = 'true';
      const overlay = link.closest('#brutalist-site-navigation') ? 'navigation' : 'outline';
      link.addEventListener('click', (event) => {
        // Quartz's SPA router owns the destination and may stop bubbling at
        // `window`. Bind the link itself so the fixed modal lock is removed
        // before that router performs its route or hash transition.
        if (
          activeOverlay !== overlay
          || event.defaultPrevented
          || event.button > 0
          || event.metaKey
          || event.ctrlKey
          || event.shiftKey
          || event.altKey
        ) return;
        closeOverlay({ restoreFocus: false, restoreScroll: false, skipHistory: true });
      });
    }
  }

  function bindSearchResultRouteActivation() {
    const panel = searchContainer();
    if (!panel) return;
    for (const link of panel.querySelectorAll('.search-layout a[href]')) {
      if (link.dataset.brutalistSearchRouteBound === 'true') continue;
      link.dataset.brutalistSearchRouteBound = 'true';
      link.addEventListener('click', (event) => {
        // A search result is a route transition, not a dismissal. Release
        // the modal's fixed scroll lock before Quartz processes the link so
        // its new article can establish its own reading position.
        if (
          activeOverlay !== 'search'
          || event.defaultPrevented
          || event.button > 0
          || event.metaKey
          || event.ctrlKey
          || event.shiftKey
          || event.altKey
        ) return;
        closeOverlay({ restoreFocus: false, restoreScroll: false, skipHistory: true });
      });
    }
  }

  document.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return;
    if (handleAction(event)) return;
    if (event.target === backdrop) {
      closeOverlay();
      return;
    }
    if (event.target.closest('.brutalist-image-dialog__close')) {
      closeOverlay();
      return;
    }
    const image = event.target.closest('.brutalist-main article img');
    if (image && !image.closest('a')) {
      event.preventDefault();
      openImage(image, image);
      return;
    }
    const graph = event.target.closest('.global-graph-icon');
    if (graph) {
      // Closing the native graph clicks this trigger. While it is already
      // promoted, let Quartz close it without scheduling a second promotion.
      if (activeOverlay !== 'graph') {
        queueMicrotask(() => promoteGraph(graph));
      }
      return;
    }
  });

  document.addEventListener('error', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLImageElement) || !target.matches('.brutalist-main article img')) return;
    presentImageFailure(target);
  }, true);

  document.addEventListener('keydown', (event) => {
    if (activeOverlay === noOverlay) {
      const image = document.activeElement;
      if (
        image instanceof HTMLImageElement
        && image.dataset.brutalistImagePreview === 'true'
        && (event.key === 'Enter' || event.key === ' ')
      ) {
        event.preventDefault();
        openImage(image, image);
      }
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      closeOverlay();
      return;
    }
    if (event.key !== 'Tab') return;
    const modal = modalFor(activeOverlay);
    if (!modal) return;
    const targets = focusable(modal);
    if (targets.length === 0) {
      event.preventDefault();
      modal.focus({ preventScroll: true });
      return;
    }
    const first = targets[0];
    const last = targets.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  addEventListener('popstate', () => {
    if (activeOverlay !== noOverlay) {
      pendingHistoryRestore = undefined;
      closeOverlay({ fromHistory: true });
      return;
    }
    // Quartz owns SPA navigation, but a history traversal belongs to the
    // reader. Its stored position wins over Explorer's new-route reset.
    if (!location.hash) {
      pendingHistoryRestore = currentHistoryReadingPosition({ allowStored: true })
        ?? { path: routeKey(), top: 0 };
    }
  });
  addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (activeOverlay !== noOverlay) closeOverlay({ skipHistory: true });
      applyViewport();
      annotateScrollableTables();
    }, 80);
  }, { passive: true });

  const searchObserver = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target;
      if (
        activeOverlay === 'search'
        && target.matches?.('.search-button')
        && target.getAttribute('aria-expanded') === 'false'
      ) {
        queueMicrotask(() => {
          if (activeOverlay === 'search' && searchButton()?.getAttribute('aria-expanded') === 'false') {
            closeOverlay({ restoreFocus: true, skipHistory: true });
          }
        });
      }
    }
  });
  searchObserver.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-expanded'],
  });

  const searchResultObserver = new MutationObserver(() => {
    if (activeOverlay === 'search') {
      compactSearchResults();
      compactSearchPreview();
      bindSearchResultRouteActivation();
    }
  });
  searchResultObserver.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class'],
  });

  let explorerReset;
  let userMovedPage = false;
  const movementEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
  const cancelHashScrollRecovery = () => {
    hashRecoveryUntil = 0;
    if (hashRecoveryFrame) cancelAnimationFrame(hashRecoveryFrame);
    hashRecoveryFrame = undefined;
  };
  const markUserMovement = () => {
    userMovedPage = true;
    cancelHashScrollRecovery();
    cancelHistoryReadingRestore();
    explorerReset?.disconnect();
    for (const event of movementEvents) removeEventListener(event, markUserMovement);
  };
  const watchUserMovement = () => {
    for (const event of movementEvents) {
      removeEventListener(event, markUserMovement);
      addEventListener(event, markUserMovement, { passive: true, once: true });
    }
  };

  const resetExplorerPageScroll = () => {
    if (userMovedPage || activeOverlay !== noOverlay) return false;
    const active = document.querySelector('.explorer-ul a.active');
    if (!active) return false;
    if (location.hash) {
      if (!restoreHashScroll()) return false;
      scheduleHashScrollRecovery();
      explorerReset?.disconnect();
      return true;
    }
    const list = active.closest('.explorer-ul');
    const explorerScrollTop = list?.scrollTop ?? 0;
    scrollTo({ top: 0, left: 0, behavior: 'instant' });
    if (list) list.scrollTop = explorerScrollTop;
    explorerReset?.disconnect();
    return true;
  };

  function restoreHashScroll() {
    if (userMovedPage || activeOverlay !== noOverlay || !location.hash) return false;
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    if (!target) return false;
    target.scrollIntoView({ block: 'start', behavior: 'instant' });
    return true;
  }

  function scheduleHashScrollRecovery() {
    if (!location.hash || userMovedPage || activeOverlay !== noOverlay) return;
    hashRecoveryUntil = performance.now() + 1000;
    queueHashScrollRecovery();
  }

  function queueHashScrollRecovery() {
    if (hashRecoveryFrame) return;
    // Quartz's route hydration can apply the native hash position after the
    // theme script. During that short recovery window, each programmatic
    // Explorer scroll is corrected on its following animation frame. User
    // input clears the window above, so manual reading is never overridden.
    hashRecoveryFrame = requestAnimationFrame(() => {
      hashRecoveryFrame = undefined;
      restoreHashScroll();
    });
  }

  const armExplorerPageReset = () => {
    explorerReset?.disconnect();
    if (userMovedPage) return;
    const recovered = resetExplorerPageScroll();
    if (location.hash) {
      // Explorer fills its active link asynchronously and then calls its own
      // `scrollIntoView`. Observe that hydration even when an earlier recovery
      // succeeded, so the framework cannot subsequently cover the heading.
      explorerReset = new MutationObserver(() => {
        if (userMovedPage || activeOverlay !== noOverlay) {
          explorerReset?.disconnect();
          return;
        }
        if (!document.querySelector('.explorer-ul a.active')) return;
        if (restoreHashScroll()) {
          scheduleHashScrollRecovery();
          explorerReset?.disconnect();
        }
      });
      explorerReset.observe(document.body, { childList: true, subtree: true });
      return;
    }
    if (recovered) return;
    explorerReset = new MutationObserver(() => resetExplorerPageScroll());
    explorerReset.observe(document.body, { childList: true, subtree: true });
  };

  // Quartz hydrates the Explorer after this client script on some routes.
  // Keep semantic current-page state and native full-title affordances in
  // step with that asynchronous tree rather than depending on event order.
  const explorerAnnotationObserver = new MutationObserver(() => annotateExplorer());
  explorerAnnotationObserver.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
  });

  // Quartz's scroll spy marks the visible section with `.in-view`. Mirror the
  // visual state into one semantic current location as headings move or the
  // TOC rehydrates after client-side navigation.
  const tocAnnotationObserverOptions = {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
  };
  const tocAnnotationObserver = new MutationObserver((records) => {
    const tocTreeChanged = records.some((record) => {
      if (record.type !== 'childList') return false;
      const target = record.target;
      if (target.matches?.('.toc, .toc-content') || target.closest?.('.toc')) return true;
      return [...record.addedNodes].some((node) => (
        node.nodeType === 1
        && (node.matches?.('.toc, .toc-content') || node.querySelector?.('.toc, .toc-content'))
      ));
    });
    if (tocTreeChanged) {
      // The enhancement itself adds semantic classes and one branch button.
      // Do not observe those writes as another Quartz rehydration cycle.
      tocAnnotationObserver.disconnect();
      try {
        enhanceTableOfContents();
      } finally {
        tocAnnotationObserver.observe(document.body, tocAnnotationObserverOptions);
      }
    }
    scheduleTableOfContentsAnnotation();
  });
  tocAnnotationObserver.observe(document.body, tocAnnotationObserverOptions);

  // Quartz expands/collapses callouts by changing a CSS class on a div. Keep
  // the keyboard semantics in sync with that native interaction without
  // replacing the renderer-owned toggle behaviour.
  const calloutAnnotationObserver = new MutationObserver(() => annotateCollapsibleCallouts());
  calloutAnnotationObserver.observe(document.body, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['class'],
  });

  const updateProgress = () => {
    ensureRuntimeChrome();
    const length = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    const value = Math.max(0, Math.min(100, Math.round(scrollY / length * 100)));
    progress.style.setProperty('--brutalist-progress', `${value}%`);
    progress.setAttribute('aria-valuenow', String(value));
  };

  ensureRuntimeChrome();
  watchUserMovement();
  const navigation = performance.getEntriesByType('navigation')[0];
  document.addEventListener('nav', () => {
    ensureRuntimeChrome();
    cancelHashScrollRecovery();
    cancelHistoryReadingRestore();
    closeOverlay({ restoreFocus: false, restoreScroll: false, skipHistory: true });
    const historyRestore = !location.hash && pendingHistoryRestore?.path === routeKey()
      ? pendingHistoryRestore
      : undefined;
    pendingHistoryRestore = undefined;
    userMovedPage = false;
    watchUserMovement();
    applyViewport();
    assignArticleLabel();
    protectCjkTitlePhrases();
    syncReadingContext();
    annotateGraphTrigger();
    annotateImageFailures();
    annotateArticleImages();
    annotateScrollableTables();
    annotateCollapsibleCallouts();
    enhanceTagIndex();
    annotateExplorer();
    bindExplorerToggle();
    enhanceTableOfContents();
    annotateTableOfContents();
    bindOverlayRouteActivation();
    bindSearchResultRouteActivation();
    bindNativeSearchTrigger();
    bindCloseControls();
    compactSearchResults();
    compactSearchPreview();
    if (historyRestore) {
      restoreHistoryReadingPosition(historyRestore.top);
    } else {
      armExplorerPageReset();
      scheduleHashScrollRecovery();
      queueReadingPositionPersistence();
    }
    updateProgress();
  });
  document.addEventListener('render', () => {
    ensureRuntimeChrome();
    assignArticleLabel();
    protectCjkTitlePhrases();
    syncReadingContext();
    annotateGraphTrigger();
    annotateImageFailures();
    annotateArticleImages();
    annotateScrollableTables();
    annotateCollapsibleCallouts();
    enhanceTagIndex();
    annotateExplorer();
    bindExplorerToggle();
    enhanceTableOfContents();
    annotateTableOfContents();
    bindOverlayRouteActivation();
    bindNativeSearchTrigger();
    bindCloseControls();
    compactSearchResults();
    compactSearchPreview();
    syncControls();
    updateProgress();
  });
  addEventListener('scroll', () => {
    updateProgress();
    queueReadingPositionPersistence();
    scheduleTableOfContentsAnnotation();
    if (
      hashRecoveryUntil > performance.now()
      && !userMovedPage
      && activeOverlay === noOverlay
    ) queueHashScrollRecovery();
  }, { passive: true });
  addEventListener('pagehide', persistReadingPosition, { passive: true });
  addEventListener('pageshow', (event) => {
    if (location.hash || activeOverlay !== noOverlay) return;
    const position = currentHistoryReadingPosition({
      allowStored: event.persisted || navigation?.type === 'back_forward',
    });
    if (!position) return;
    userMovedPage = false;
    watchUserMovement();
    restoreHistoryReadingPosition(position.top);
  }, { passive: true });

  root.dataset.overlay = noOverlay;
  bindCloseControls();
  compactSearchResults();
  compactSearchPreview();
  applyViewport();
  assignArticleLabel();
  protectCjkTitlePhrases();
  syncReadingContext();
  annotateGraphTrigger();
  annotateImageFailures();
  annotateArticleImages();
  annotateScrollableTables();
  annotateCollapsibleCallouts();
  enhanceTagIndex();
  annotateExplorer();
  bindExplorerToggle();
  enhanceTableOfContents();
  annotateTableOfContents();
  bindOverlayRouteActivation();
  bindSearchResultRouteActivation();
  bindNativeSearchTrigger();
  updateProgress();
  scheduleHashScrollRecovery();
  const initialHistoryRestore = !location.hash
    ? currentHistoryReadingPosition({ allowStored: navigation?.type === 'back_forward' })
    : undefined;
  // A restored focused-reading preference changes the sticky-header geometry.
  // Settle it before restoring a hash so the heading's scroll margin is used.
  if (initialHistoryRestore) {
    // BFCache and full document history traversal do not necessarily emit an
    // in-document `popstate`, so bootstrap participates in restoration too.
    restoreHistoryReadingPosition(initialHistoryRestore.top);
  } else if (location.hash || navigation?.type === 'navigate') {
    armExplorerPageReset();
  }
  if (!initialHistoryRestore) queueReadingPositionPersistence();
})();
