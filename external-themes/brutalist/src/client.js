(() => {
  const root = document.documentElement;
  if (root.dataset.brutalistReady === 'true') return;
  root.dataset.brutalistReady = 'true';

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
