(() => {
  const root = document.documentElement;
  if (root.dataset.brutalistReady === 'true') return;
  root.dataset.brutalistReady = 'true';

  let explorerReset;
  let userMovedPage = false;
  const movementEvents = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
  const markUserMovement = () => {
    userMovedPage = true;
    explorerReset?.disconnect();
    for (const event of movementEvents) {
      removeEventListener(event, markUserMovement);
    }
  };
  const watchUserMovement = () => {
    for (const event of movementEvents) {
      removeEventListener(event, markUserMovement);
      addEventListener(event, markUserMovement, { passive: true, once: true });
    }
  };
  watchUserMovement();

  const resetExplorerPageScroll = () => {
    if (userMovedPage) return false;
    const active = document.querySelector('.explorer-ul a.active');
    if (!active) return false;
    if (location.hash) {
      const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      if (!target) return false;
      target.scrollIntoView({ block: 'start', behavior: 'instant' });
      explorerReset?.disconnect();
      return true;
    }
    const list = active.closest('.explorer-ul');
    const explorerScrollTop = list?.scrollTop ?? 0;
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
    if (list) list.scrollTop = explorerScrollTop;
    explorerReset?.disconnect();
    return true;
  };

  const armExplorerPageReset = () => {
    explorerReset?.disconnect();
    if (userMovedPage || resetExplorerPageScroll()) return;
    explorerReset = new MutationObserver(() => resetExplorerPageScroll());
    explorerReset.observe(document.body, { childList: true, subtree: true });
  };

  const navigation = performance.getEntriesByType('navigation')[0];
  if (navigation?.type === 'navigate') armExplorerPageReset();
  document.addEventListener('nav', () => {
    userMovedPage = false;
    watchUserMovement();
    armExplorerPageReset();
  });

  const progress = document.createElement('div');
  progress.className = 'brutalist-reading-progress';
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-label', '阅读进度');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', '100');
  document.body.append(progress);

  const update = () => {
    const length = Math.max(1, document.documentElement.scrollHeight - innerHeight);
    const value = Math.max(0, Math.min(100, Math.round(scrollY / length * 100)));
    progress.style.setProperty('--brutalist-progress', `${value}%`);
    progress.setAttribute('aria-valuenow', String(value));
  };
  addEventListener('scroll', update, { passive: true });
  document.addEventListener('nav', update);
  document.addEventListener('render', update);
  update();
})();
