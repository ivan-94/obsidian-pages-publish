import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test('package is an install-script-free exact Quartz 5 theme', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.version, '1.0.0');
  assert.equal(manifest.pagesPublishTheme.quartzVersion, '5.0.0');
  for (const script of ['preinstall', 'install', 'postinstall', 'prepack', 'prepare']) {
    assert.equal(manifest.scripts[script], undefined);
  }
});

test('options schema is closed and provides defaults for every required option', async () => {
  const schema = JSON.parse(await readFile(join(root, 'src', 'options.schema.json'), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  for (const name of schema.required) assert.notEqual(schema.properties[name].default, undefined);
});

test('theme uses distinct poster, editorial and minimal frames', async () => {
  const source = await readFile(join(root, 'src', 'index.js'), 'utf8');
  assert.match(source, /name: 'brutalist-poster'/u);
  assert.match(source, /name: 'brutalist-editorial'/u);
  assert.match(source, /name: 'brutalist-minimal'/u);
  assert.match(source, /BrutalistMasthead/u);
  assert.match(source, /brutalist-reading-context/u);
  assert.match(source, /BrutalistPreferenceBoot/u);
  assert.match(source, /pages-publish:brutalist:reading-mode/u);
});

test('theme has ordered content-first style layers and a tablet drawer breakpoint', async () => {
  const source = await readFile(join(root, 'src', 'index.js'), 'utf8');
  const article = await readFile(join(root, 'src', 'styles', 'article.css'), 'utf8');
  const shell = await readFile(join(root, 'src', 'styles', 'shell.css'), 'utf8');
  const navigation = await readFile(join(root, 'src', 'styles', 'navigation.css'), 'utf8');
  const tokens = await readFile(join(root, 'src', 'styles', 'tokens.css'), 'utf8');
  const responsive = await readFile(join(root, 'src', 'styles', 'responsive.css'), 'utf8');
  assert.match(source, /'\.\/dist\/styles\/tokens\.css'/u);
  assert.match(source, /'\.\/dist\/styles\/responsive\.css'/u);
  assert.match(article, /word-break: auto-phrase/u);
  assert.match(article, /\.brutalist-image-fallback__label[\s\S]*color: var\(--brutalist-ink\)/u);
  assert.match(tokens, /html \{[\s\S]*width: 100%;[\s\S]*overflow-x: clip/u);
  assert.match(tokens, /html \{[\s\S]*font-size: 14px/u);
  assert.match(tokens, /html \{[\s\S]*scrollbar-width: none/u);
  assert.match(tokens, /html::-webkit-scrollbar,[\s\S]*body::-webkit-scrollbar \{[\s\S]*width: 0;[\s\S]*height: 0/u);
  assert.match(tokens, /body \{[\s\S]*font-size: 1rem/u);
  assert.match(tokens, /--rail-expanded: 335px/u);
  assert.match(responsive, /@media \(max-width: 1279px\)[\s\S]*:root\[data-overlay="navigation"\]/u);
  assert.match(
    responsive,
    /:root\[data-overlay="navigation"\] \.brutalist-poster-tools \.brutalist-index-label \{[\s\S]*display: none !important/u,
  );
  assert.match(responsive, /@media \(max-width: 759px\)[\s\S]*:root\[data-reading-mode="focused"\] \.brutalist-masthead[\s\S]*minmax\(0, 8\.5rem\)/u);
  assert.match(responsive, /:root\[data-reading-mode="focused"\] \.brutalist-wordmark__long[\s\S]*display: none/u);
  assert.match(responsive, /:root\[data-reading-mode="focused"\] \.brutalist-wordmark__short[\s\S]*display: block/u);
  assert.match(responsive, /@media \(max-width: 759px\)[\s\S]*:root\[data-overlay="outline"\] \.brutalist-editorial-tools[\s\S]*display: block/u);
  assert.match(responsive, /@media \(max-width: 759px\)[\s\S]*:root\[data-overlay="navigation"\] \.brutalist-editorial-index[\s\S]*display: block/u);
  assert.match(shell, /grid-template-areas:[\s\S]*masthead masthead masthead[\s\S]*navigation stage utility/u);
  assert.match(shell, /\.brutalist-frame-header[\s\S]*background: var\(--brutalist-panel\)/u);
  assert.match(shell, /\.brutalist-wordmark[\s\S]*isolation: isolate[\s\S]*transform: translateZ\(0\)/u);
  assert.match(shell, /\.brutalist-wordmark__long/u);
  assert.match(shell, /\.brutalist-frame-header :where\(a, button\):focus-visible[\s\S]*outline-offset: -5px/u);
  assert.match(navigation, /\.brutalist-tool-rail \.toc a[\s\S]*opacity: 1/u);
  assert.match(navigation, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/u);
  assert.match(navigation, /--brutalist-index-row-font/u);
  assert.match(navigation, /\[data-left-rail="hidden"\]/u);
  assert.match(
    navigation,
    /:is\(\.brutalist-poster-tools, \.brutalist-editorial-index\)\.brutalist-tool-rail \{[\s\S]*--brutalist-compact-control: 48px;[\s\S]*--brutalist-compact-row: 42px;[\s\S]*--brutalist-compact-gap: 12px;[\s\S]*padding: 16px 22px 16px 16px/u,
  );
  assert.match(
    navigation,
    /:is\(\.brutalist-poster-tools, \.brutalist-editorial-index\) \.brutalist-index-label \{[\s\S]*display: none/u,
  );
  assert.match(navigation, /content: 'SEARCH'/u);
  assert.match(navigation, /content: 'MODE'/u);
  assert.match(navigation, /content: 'BROWSE INDEX'/u);
  assert.match(
    responsive,
    /@media \(min-width: 1280px\)[\s\S]*\[data-reading-mode="standard"\]\[data-left-rail="expanded"\][\s\S]*overflow: hidden/u,
    'the desktop rail shell must not scroll its utility controls away while Quartz reveals the active Explorer page',
  );
  assert.match(
    responsive,
    /\.brutalist-tool-rail \.explorer-content[\s\S]*flex: 1 1 auto[\s\S]*overflow-y: auto/u,
    'only the Explorer tree, not the complete rail, may own deep-tree scrolling',
  );
  assert.match(shell, /\.brutalist-poster-frame > \.brutalist-frame-header[\s\S]*grid-area: masthead/u);
  assert.match(shell, /\.brutalist-poster-tools[\s\S]*grid-area: navigation/u);
  assert.match(shell, /\.brutalist-poster-stage[\s\S]*grid-area: stage/u);
  assert.match(shell, /\.brutalist-poster-utility[\s\S]*grid-area: utility/u);
  assert.match(shell, /\.brutalist-editorial-index[\s\S]*grid-column: 1/u);
  assert.match(shell, /\.brutalist-editorial-frame > \.brutalist-main[\s\S]*grid-column: 2/u);
  assert.match(shell, /\.brutalist-editorial-tools[\s\S]*grid-column: 3/u);
  assert.match(navigation, /\.brutalist-tool-rail \.explorer-ul[\s\S]*overflow-x: hidden/u);
  assert.match(navigation, /\.brutalist-tool-rail \.explorer-content,[\s\S]*scrollbar-width: none/u);
  assert.match(navigation, /font: 600 14px\/1\.25 var\(--bodyFont\) !important/u);
  assert.match(navigation, /min-height: var\(--brutalist-compact-row\)/u);
  assert.match(navigation, /padding: 10px 6px/u);
  assert.match(navigation, /grid-template-columns: 26px minmax\(0, 1fr\)/u);
  assert.match(navigation, /margin-left: 7px;[\s\S]*padding-left: 14px/u);
  assert.match(navigation, /\.explorer \.folder-title \{[\s\S]*font: inherit !important/u);
  assert.match(navigation, /\.folder-button \{[\s\S]*font-weight: 700 !important/u);
  assert.match(
    responsive,
    /\.brutalist-tool-rail \.explorer-ul \{[\s\S]*overflow-x: hidden !important;[\s\S]*overflow-y: auto !important/u,
  );
});

test('theme owns Quartz tag discovery while suppressing an empty folder-list shell', async () => {
  const article = await readFile(join(root, 'src', 'styles', 'article.css'), 'utf8');
  assert.match(article, /\.brutalist-main \.page-listing \{[\s\S]*border-top: var\(--stroke-emphasis\)/u);
  assert.match(article, /\.page-listing:not\(:has\(\.section-ul\)\)[\s\S]*display: none/u);
  assert.match(article, /\.page-listing \.section \.(?:meta):empty[\s\S]*display: none/u);
  assert.match(article, /\.page-listing \.section \.desc h3 a[\s\S]*min-height: 44px/u);
  assert.match(article, /\.page-listing \.section \.(?:tags) a:hover[\s\S]*background: var\(--brutalist-ink\)/u);
  assert.match(article, /body\[data-slug="tags\/index"\][\s\S]*h2[\s\S]*min-height: 44px/u);
  assert.match(article, /body\[data-slug="tags\/index"\][\s\S]*\.page-listing[\s\S]*margin-top: var\(--space-3\)/u);
  assert.match(article, /\.brutalist-tag-index-disclosure > summary[\s\S]*min-height: 44px/u);
  assert.match(article, /\.brutalist-tag-index-disclosure\[open\] > summary::after[\s\S]*content: '−'/u);
  const client = await readFile(join(root, 'src', 'client.js'), 'utf8');
  assert.match(client, /function enhanceTagIndex\(\)/u);
  assert.match(client, /document\.createElement\('details'\)/u);
  assert.match(client, /disclosure\.addEventListener\('toggle', sync\)/u);
  assert.match(client, /enhanceTagIndex\(\);/u);
});

test('theme serves an unlayered cascade guard from its own immutable assets', async () => {
  const source = await readFile(join(root, 'src', 'index.js'), 'utf8');
  const build = await readFile(join(root, 'scripts', 'build.mjs'), 'utf8');
  assert.match(source, /BrutalistCascadeGuard/u);
  assert.match(source, /brutalist-cascade\.css/u);
  assert.match(source, /rel: 'stylesheet'/u);
  assert.match(source, /'\.\/dist\/assets\/brutalist-cascade\.css'/u);
  assert.match(build, /brutalist-cascade\.css/u);
  assert.match(build, /readFile/u);
});

test('theme exposes semantic navigation and article utility landmarks', async () => {
  const source = await readFile(join(root, 'src', 'index.js'), 'utf8');
  assert.match(source, /id: 'brutalist-site-navigation'/u);
  assert.match(source, /id: 'brutalist-article-utilities'/u);
  assert.match(source, /'aria-label': '站点导航'/u);
  assert.match(source, /BrutalistNavigationControls/u);
  assert.match(source, /brutalist-outline-heading/u);
  assert.match(source, /brutalist-outline-heading__meta/u);
  assert.match(source, /control\('close-outline', '关闭本文目录', '×'/u);
  assert.match(source, /'data-mobile-label': mobileLabel/u);
  assert.match(source, /'TOC'/u);
  assert.match(source, /right: \['BrutalistUtilityControls', 'TableOfContents', 'Graph'\]/u);
});

test('theme cancels Explorer page scrolling without overriding hashes or user movement', async () => {
  const source = await readFile(join(root, 'src', 'client.js'), 'utf8');
  const boot = source.slice(source.indexOf('watchUserMovement();'));
  assert.match(source, /if \(location\.hash\) \{/u);
  assert.match(source, /target\.scrollIntoView\(\{ block: 'start', behavior: 'instant' \}\)/u);
  assert.match(source, /function scheduleHashScrollRecovery\(\)/u);
  assert.match(source, /User[\s/]+input clears the window above/u);
  assert.match(source, /hashRecoveryUntil > performance\.now\(\)/u);
  assert.match(source, /Explorer fills its active link asynchronously/u);
  assert.match(source, /else if \(location\.hash \|\| navigation\?\.type === 'navigate'\) \{[\s\S]*armExplorerPageReset\(\)/u);
  assert.match(source, /scrollTo\(\{ top: 0, left: 0, behavior: 'instant' \}\)/u);
  assert.match(source, /new MutationObserver\(\(\) => resetExplorerPageScroll\(\)\)/u);
  assert.match(source, /navigation\?\.type === 'navigate'/u);
  assert.match(source, /function annotateExplorer\(\)/u);
  const explorerAnnotation = source.slice(
    source.indexOf('function annotateExplorer()'),
    source.indexOf('function stabilizeExplorerRail()'),
  );
  assert.doesNotMatch(
    explorerAnnotation,
    /classList\.(?:add|remove|toggle)\(/u,
    'Explorer annotation observes class changes and must not write class state back into the same loop',
  );
  assert.match(source, /heading\.textContent\?\.trim\(\) !== '浏览索引'/u);
  assert.match(source, /function bindExplorerToggle\(\)/u);
  assert.match(source, /safeStorage\.set\(STORAGE\.index, String\(expanded\)\)/u);
  assert.match(source, /link\.setAttribute\('aria-current', 'page'\)/u);
  assert.match(source, /function scheduleExplorerRailStabilization\(\)/u);
  assert.match(source, /shell\.scrollTop = 0/u);
  assert.match(source, /const scroller = shell\?\.querySelector\('\.explorer-content'\)/u);
  assert.match(source, /const explorerAnnotationObserver = new MutationObserver/u);
  assert.match(source, /function annotateTableOfContents\(\)/u);
  assert.match(source, /function enhanceTableOfContents\(\)/u);
  assert.match(source, /brutalist-toc-branch-toggle/u);
  assert.match(source, /button\.setAttribute\('aria-expanded', String\(expanded\)\)/u);
  assert.match(source, /child\.hidden = !expanded/u);
  assert.match(source, /SECTIONS · \$\{minutes\} MIN READ/u);
  assert.match(source, /link\.setAttribute\('aria-current', 'location'\)/u);
  assert.match(source, /const tocAnnotationObserver = new MutationObserver/u);
  assert.match(source, /new MutationObserver\(\(records\) =>/u);
  assert.match(source, /record\.type !== 'childList'/u);
  assert.match(source, /tocAnnotationObserver\.disconnect\(\)/u);
  assert.match(source, /tocAnnotationObserver\.observe\(document\.body, tocAnnotationObserverOptions\)/u);
  assert.match(source, /heading\.getBoundingClientRect\(\)\.top <= readingLine/u);
  assert.match(source, /function scheduleTableOfContentsAnnotation\(\)/u);
  assert.match(source, /function annotateGraphTrigger\(\)/u);
  assert.match(source, /打开全局知识图谱/u);
  assert.match(source, /const outlineAvailable = Boolean\(document\.querySelector\('\.toc a\[href\]'\)\)/u);
  assert.match(source, /button\.hidden = !outlineAvailable/u);
  assert.match(source, /desktop && !isFocused\(\) && rightExpanded/u);
  assert.match(source, /function protectCjkTitlePhrases\(\)/u);
  assert.match(source, /new Segmenter\('zh-CN', \{ granularity: 'word' \}\)/u);
  assert.match(source, /function syncReadingContext\(\)/u);
  assert.match(source, /当前阅读：\$\{title\}/u);
  assert.match(source, /function ensureRuntimeChrome\(\)/u);
  assert.match(source, /if \(!backdrop\?\.isConnected\)/u);
  assert.match(source, /if \(!progress\?\.isConnected\)/u);
  assert.match(source, /ensureRuntimeChrome\(\);\n    const length/u);
  assert.match(source, /function openOverlay[\s\S]*ensureRuntimeChrome\(\)/u);
  assert.match(source, /function restoreReadingPosition\(top\)/u);
  assert.match(source, /if \(!Number\.isFinite\(top\) \|\| top < 0\) return;/u);
  assert.match(source, /const restoreTop = scrollLock\?\.top \?\? scrollY/u);
  assert.match(source, /function unlockDocument\(\{ restoreScroll = true \} = \{\}\)/u);
  assert.match(source, /if \(restoreScroll\) restoreReadingPosition\(restoreTop\)/u);
  assert.match(source, /function restoreOverlayFocus\(closing\)/u);
  assert.match(source, /Browser history may restore its own focus after `popstate`[\s\S]*requestAnimationFrame\(\(\) =>/u);
  assert.match(source, /main\.tabIndex = -1/u);
  assert.match(source, /restoreScroll: false, skipHistory: true/u);
  assert.match(source, /function bindOverlayRouteActivation\(\)/u);
  assert.match(source, /link\.addEventListener\('click', \(event\) => \{/u);
  assert.match(source, /before that router performs its route or hash transition/u);
  assert.match(source, /function bindSearchResultRouteActivation\(\)/u);
  assert.match(source, /search result is a route transition, not a dismissal/u);
  assert.match(source, /closeOverlay\(\{ restoreFocus: false, restoreScroll: false, skipHistory: true \}\)/u);
  assert.match(source, /searchResultObserver[\s\S]*bindSearchResultRouteActivation\(\)/u);
  assert.match(source, /const cancelHashScrollRecovery = \(\) =>/u);
  assert.match(source, /const HISTORY_READING_POSITION = 'pagesPublishBrutalistReadingPosition'/u);
  assert.match(source, /function readStoredReadingPosition\(\)/u);
  assert.match(source, /sessionStorage\.setItem\(storedReadingPositionKey\(path\), JSON\.stringify\(position\)\)/u);
  assert.match(source, /function currentHistoryReadingPosition\(\{ allowStored = false \} = \{\}\)/u);
  assert.match(source, /function persistReadingPosition\(\)/u);
  assert.match(source, /\[HISTORY_READING_POSITION\]: position/u);
  assert.match(source, /const historyRestore = !location\.hash && pendingHistoryRestore\?\.path === routeKey\(\)/u);
  assert.match(source, /function restoreHistoryReadingPosition\(top\)/u);
  assert.match(source, /historyRestoreUntil = performance\.now\(\) \+ 1000/u);
  assert.match(source, /if \(historyRestore\) \{[\s\S]*restoreHistoryReadingPosition\(historyRestore\.top\)/u);
  assert.match(source, /const initialHistoryRestore = !location\.hash[\s\S]*currentHistoryReadingPosition\(\{ allowStored: navigation\?\.type === 'back_forward' \}\)/u);
  assert.match(source, /if \(initialHistoryRestore\) \{[\s\S]*restoreHistoryReadingPosition\(initialHistoryRestore\.top\)/u);
  assert.match(source, /addEventListener\('pageshow',[\s\S]*event\.persisted \|\| navigation\?\.type === 'back_forward'/u);
  assert.match(source, /let pendingInteraction/u);
  assert.match(source, /function lockDocument\(requestedTop = scrollY\)/u);
  assert.match(source, /pendingInteraction\?\.trigger === trigger/u);
  assert.match(source, /function syncFocusedRailInteractivity\(\)/u);
  assert.match(source, /candidate\.inert = shouldHide/u);
  assert.match(source, /dataset\.brutalistFocusedRailInert/u);
  assert.ok(
    boot.indexOf('applyViewport();') < boot.indexOf('const initialHistoryRestore'),
    'initial viewport state must settle before a hash or history position is restored',
  );
});

test('theme client coordinates rails, focus, drawers and promoted Quartz dialogs', async () => {
  const source = await readFile(join(root, 'src', 'client.js'), 'utf8');
  const navigation = await readFile(join(root, 'src', 'styles', 'navigation.css'), 'utf8');
  const responsive = await readFile(join(root, 'src', 'styles', 'responsive.css'), 'utf8');
  const tokens = await readFile(join(root, 'src', 'styles', 'tokens.css'), 'utf8');
  const article = await readFile(join(root, 'src', 'styles', 'article.css'), 'utf8');
  assert.match(source, /pages-publish:brutalist:left-rail/u);
  assert.match(source, /pages-publish:brutalist:index-expanded/u);
  assert.match(source, /root\.dataset\.leftRail === 'expanded' \? 'hidden' : 'expanded'/u);
  assert.match(source, /root\.dataset\.readingMode = 'focused'/u);
  assert.match(source, /root\.dataset\.overlay = overlay/u);
  assert.match(source, /region\.setAttribute\('inert', ''\)/u);
  assert.match(source, /history\.pushState\(/u);
  assert.match(source, /function portalSearch\(\)/u);
  assert.match(source, /function bindNativeSearchTrigger\(\)/u);
  assert.match(source, /brutalistNativeSearchOpening/u);
  assert.match(source, /event\.stopImmediatePropagation\(\)/u);
  assert.match(source, /if \(!searchContainer\(\)\) \{[\s\S]*queueMicrotask\(/u);
  assert.match(source, /button\?\.getAttribute\('aria-expanded'\) !== 'true'/u);
  assert.match(source, /const space = panel\.querySelector\('\.search-space'\)/u);
  assert.match(source, /function compactSearchResults\(\)/u);
  assert.match(source, /description\.dataset\.brutalistCompact = 'true'/u);
  assert.match(source, /const cardTitle = decodeSearchText/u);
  assert.match(source, /function compactSearchPreview\(\)/u);
  assert.match(source, /brutalist-search-preview-summary/u);
  assert.match(source, /preview\.hidden = true/u);
  assert.match(source, /preview\.setAttribute\('aria-hidden', 'true'\)/u);
  assert.match(source, /element\.closest\('\[hidden\], \[aria-hidden="true"\], \[inert\]'\)/u);
  assert.match(source, /close\.dataset\.brutalistAction = 'close-search'/u);
  assert.match(source, /function portalGraph\(\)/u);
  assert.match(source, /close\.dataset\.brutalistAction = 'close-graph'/u);
  assert.match(source, /if \(activeOverlay !== 'graph'\)/u);
  assert.match(source, /function startGraphStatus\(panel\)/u);
  assert.match(source, /status\.setAttribute\('role', 'status'\)/u);
  assert.match(source, /status\.setAttribute\('aria-live', 'polite'\)/u);
  assert.match(source, /fetch\('\/static\/contentIndex\.json', \{ signal: abort\.signal \}\)/u);
  assert.match(source, /Graph could not load/u);
  assert.match(source, /RETRY \/ 重试/u);
  assert.match(source, /never lets focus escape an aria-modal dialog[\s\S]*\.focus\(\{ preventScroll: true \}\)/u);
  assert.match(source, /clone\.removeAttribute\('tabindex'\)/u);
  assert.match(source, /clone\.removeAttribute\('aria-haspopup'\)/u);
  assert.match(source, /brutalist-image-dialog__fallback/u);
  assert.match(source, /function presentImageFailure\(image\)/u);
  assert.match(source, /image\.dataset\.brutalistImageFailed = 'true'/u);
  assert.match(source, /image\.removeAttribute\('tabindex'\)[\s\S]*delete image\.dataset\.brutalistImagePreview/u);
  assert.match(source, /fallback\.setAttribute\('role', 'img'\)/u);
  assert.match(source, /function annotateArticleImages\(\)/u);
  assert.match(source, /image\.tabIndex = 0/u);
  assert.match(source, /image\.setAttribute\('role', 'button'\)/u);
  assert.match(source, /image\.setAttribute\('aria-haspopup', 'dialog'\)/u);
  assert.match(source, /event\.key === 'Enter' \|\| event\.key === ' '/u);
  assert.match(source, /function annotateScrollableTables\(\)/u);
  assert.match(source, /container\.scrollWidth > container\.clientWidth \+ 1/u);
  assert.match(source, /可横向滚动的表格；使用左右方向键浏览/u);
  assert.match(source, /function annotateCollapsibleCallouts\(\)/u);
  assert.match(source, /title\.setAttribute\('role', 'button'\)/u);
  assert.match(source, /title\.setAttribute\('aria-expanded'/u);
  assert.match(source, /event\.key !== 'Enter' && event\.key !== ' '/u);
  assert.match(source, /document\.addEventListener\('error',[\s\S]*true\)/u);
  assert.match(navigation, /\.toc a\[aria-current="location"\]/u);
  assert.match(navigation, /\.brutalist-outline-heading__label/u);
  assert.match(navigation, /\.brutalist-toc-branch-toggle/u);
  assert.match(navigation, /\.toc-content > li\.brutalist-toc-child::after/u);
  assert.match(navigation, /grid-template-columns: 32px minmax\(0, 1fr\)/u);
  assert.match(navigation, /font: 700 14px\/1\.3 var\(--bodyFont\)/u);
  assert.match(navigation, /\.toc a\.in-view:not\(:hover\):not\(\[aria-current="location"\]\)/u);
  assert.match(navigation, /content: 'CURRENT'/u);
  assert.match(navigation, /content: 'RELATION MAP \/ '/u);
  assert.match(navigation, /\.global-graph-icon::after[\s\S]*content: 'OPEN'/u);
  assert.match(navigation, /min-width: 76px !important/u);
  assert.match(navigation, /font: 700 0\.82rem\/1\.4 var\(--bodyFont\)/u);
  assert.match(navigation, /\.brutalist-rail-controls \.brutalist-shell-control[\s\S]*min-height: 44px/u);
  assert.match(responsive, /grid-template-rows: auto auto auto/u);
  assert.match(responsive, /height: clamp\(220px, 30dvh, 280px\)/u);
  assert.match(tokens, /button:not\(\.brutalist-toc-branch-toggle\)/u);
  assert.match(article, /img\[data-brutalist-image-preview="true"\][\s\S]*cursor: zoom-in/u);
  assert.match(article, /\.brutalist-main \.table-container[\s\S]*overflow-x: auto/u);
  assert.match(article, /\.brutalist-scroll-hint/u);
  assert.match(article, /\.callout\.is-collapsible > \.callout-title[\s\S]*cursor: pointer/u);
  assert.match(navigation + article + source, /brutalist-search-dialog-bar/u);
});

test('search keeps a visible exit path and selected results readable', async () => {
  const overlays = await readFile(join(root, 'src', 'styles', 'overlays.css'), 'utf8');
  assert.match(overlays, /\.brutalist-search-dialog-bar[\s\S]*min-height: 62px/u);
  assert.match(overlays, /\.brutalist-search-dialog-bar p[\s\S]*color: #151515 !important/u);
  assert.match(overlays, /\.brutalist-search-dialog-bar button[\s\S]*min-width: 44px[\s\S]*min-height: 44px/u);
  assert.match(overlays, /\.brutalist-graph-dialog-bar button[\s\S]*min-width: 44px[\s\S]*min-height: 44px/u);
  assert.match(overlays, /\.brutalist-graph-status[\s\S]*position: absolute[\s\S]*inset: 52px 0 0/u, 'Graph state styles must own the dialog canvas region');
  assert.match(overlays, /\.brutalist-graph-status\[data-state="error"\][\s\S]*brutalist-alert/u);
  assert.match(overlays, /\.brutalist-image-dialog__status,[\s\S]*\.brutalist-image-dialog__fallback/u);
  assert.match(overlays, /\.result-card:is\(:hover, :focus, :focus-within, \.focus\)[\s\S]*\.highlight[\s\S]*background: #151515 !important/u);
  assert.match(overlays, /\.search-layout:not\(\.display-results\)[\s\S]*display: none !important/u);
  assert.match(overlays, /\.search-container \{[\s\S]*display: none !important/u, 'a stale native Quartz search panel must never remain over reading content');
  assert.match(
    overlays,
    /\.brutalist-search-preview-summary[\s\S]*align-content: start/u,
    'the preview must render a compact theme-owned summary instead of an interactive second article',
  );
  assert.match(overlays, /:root\[data-overlay="search"\] \.search-container[\s\S]*grid-template-rows: auto minmax\(0, 1fr\)[\s\S]*overflow: hidden !important/u);
  assert.match(overlays, /\.brutalist-search-preview-summary__open[\s\S]*min-height: 44px/u);
  assert.match(overlays, /:root\[data-overlay="search"\] \.search-layout \.results-container,[\s\S]*:root\[data-overlay="search"\] \.search-layout \.preview-container[\s\S]*overflow: auto/u);
  assert.match(overlays, /@media \(max-width: 759px\)[\s\S]*:root\[data-overlay="search"\] \.search-layout \.results-container[\s\S]*height: 100% !important[\s\S]*overflow-y: auto !important/u);
});
