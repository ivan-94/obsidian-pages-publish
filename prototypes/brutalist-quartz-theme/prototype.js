// PROTOTYPE — three structural directions for an external Quartz theme.
// Switch with ?variant=A|B|C. Delete after the winning direction is captured.

const variants = [
  { key: 'A', name: '编辑部索引' },
  { key: 'B', name: '海报堆叠' },
  { key: 'C', name: '控制台' },
]

const root = document.querySelector('#prototype-root')
let colorMode = 'light'

function currentVariant() {
  const requested = new URLSearchParams(location.search).get('variant')?.toUpperCase()
  return variants.some(({ key }) => key === requested) ? requested : 'A'
}

function articleBody() {
  return `
    <p class="lede">数字花园不必光滑。它应该暴露结构、显示连接，也允许阅读者看见知识仍在施工。</p>
    <h2 id="boundary"><span>01</span> 边界先于装饰</h2>
    <p>真正可靠的公开知识库，先决定什么可以出现，再讨论页面应该长什么样。主题可以激进，但它不能改写内容的公开边界。</p>
    <aside class="callout"><strong>设计原则 / RULE 04</strong><p>让结构成为视觉。边框不是装饰，而是页面信息架构的可见证据。</p></aside>
    <h2 id="friction"><span>02</span> 保留必要的摩擦</h2>
    <p>野兽派界面拒绝过度柔化：链接需要像链接，导航需要像导航，当前状态要有足够强的对比度。</p>
    <pre><code>theme = {
  frame: "brutalist-grid",
  border: 4,
  radius: 0,
  motion: "direct"
}</code></pre>
    <blockquote>“深度定制”不是隐藏 Quartz，而是重新组织它已经拥有的组件。</blockquote>
    <h2 id="system"><span>03</span> 组件必须形成系统</h2>
    <p>Explorer、Search、Graph、Backlinks 和目录不是零散挂件。主题需要赋予它们共同的标题、编号、边框与状态语言。</p>
  `
}

function explorer() {
  return `
    <nav class="explorer quartz-panel" aria-label="文章目录">
      <div class="panel-title"><span>INDEX</span><b>07</b></div>
      <button class="folder" aria-expanded="true">− 设计系统</button>
      <ul>
        <li><a href="#boundary" aria-current="page">粗粝的边界</a></li>
        <li><a href="#friction">可见的摩擦</a></li>
        <li><a href="#system">组件纪律</a></li>
      </ul>
      <button class="folder" aria-expanded="true">− Quartz 研究</button>
      <ul>
        <li><a href="#">布局与 Frames</a></li>
        <li><a href="#">Graph 的公共边界</a></li>
      </ul>
      <button class="folder" aria-expanded="false">+ 工作日志</button>
      <ul hidden>
        <li><a href="#">第 31 周</a></li>
      </ul>
    </nav>
  `
}

function graph() {
  return `
    <section class="graph quartz-panel" aria-label="关系图谱">
      <div class="panel-title"><span>GRAPH</span><b>12</b></div>
      <svg viewBox="0 0 260 150" role="img" aria-label="文章关系示意">
        <path d="M34 91L102 42L151 83L225 31M102 42L116 124L211 112M151 83L116 124M151 83L225 31"/>
        <circle cx="34" cy="91" r="9"/><circle cx="102" cy="42" r="13"/>
        <circle cx="151" cy="83" r="17"/><circle cx="225" cy="31" r="8"/>
        <circle cx="116" cy="124" r="10"/><circle cx="211" cy="112" r="7"/>
      </svg>
      <p>当前：粗粝的边界<br>6 个公开连接</p>
    </section>
  `
}

function toc() {
  return `
    <nav class="toc quartz-panel" aria-label="本页目录">
      <div class="panel-title"><span>ON THIS PAGE</span><b>03</b></div>
      <a href="#boundary">01 / 边界先于装饰</a>
      <a href="#friction">02 / 保留必要的摩擦</a>
      <a href="#system">03 / 组件必须形成系统</a>
    </nav>
  `
}

function searchButton(label = 'SEARCH / ⌘K') {
  return `<button class="search-trigger" data-action="search">${label}</button>`
}

function modeButton() {
  return `<button class="mode-trigger" data-action="mode" aria-label="切换明暗模式">${colorMode === 'light' ? 'DARK ◐' : 'LIGHT ◑'}</button>`
}

function variantA() {
  return `
    <div class="prototype variant-a" data-color="${colorMode}">
      <header class="a-masthead">
        <a class="wordmark" href="#">FIELD<br>NOTES</a>
        <p>一个公开的设计与技术观察站<br><b>ISSUE 007 / 2026</b></p>
        <div class="mast-actions">${searchButton()}${modeButton()}</div>
      </header>
      <div class="a-status"><span>● ONLINE / 49 PUBLIC PAGES</span><span>ZH-CN · UTC+8</span><span>QUARTZ 5</span></div>
      <div class="a-grid">
        <aside class="a-left">${explorer()}</aside>
        <main class="a-article">
          <div class="breadcrumbs">ROOT / 设计系统 / <strong>粗粝的边界</strong></div>
          <article>
            <div class="article-kicker"><span>ARTICLE 07</span><span>8 MIN READ</span></div>
            <h1>为什么知识库<br>需要粗粝的边界</h1>
            <div class="article-meta"><span>更新于 2026-08-03</span><span>#设计系统</span><span>#Quartz</span></div>
            ${articleBody()}
          </article>
          <section class="backlinks"><div class="panel-title"><span>BACKLINKS</span><b>04</b></div><a href="#">Quartz 迁移决策</a><a href="#">公开性的三个层级</a></section>
        </main>
        <aside class="a-right">${graph()}${toc()}<div class="issue-card"><b>NEXT / 08</b><span>为搜索建立一种视觉语法 →</span></div></aside>
      </div>
      ${prototypeSwitcher('A')}
      ${searchOverlay()}
    </div>
  `
}

function variantB() {
  return `
    <div class="prototype variant-b" data-color="${colorMode}">
      <header class="b-header">
        <a class="b-logo" href="#">观察站<span>↗</span></a>
        <nav><a href="#">文章</a><a href="#">主题</a><a href="#">关于</a></nav>
        <div>${searchButton('搜索')}${modeButton()}</div>
      </header>
      <div class="ticker"><span>FIELD NOTES / PUBLIC KNOWLEDGE / QUARTZ 5 / NO SMOOTH EDGES / </span><span>FIELD NOTES / PUBLIC KNOWLEDGE / QUARTZ 5 / NO SMOOTH EDGES / </span></div>
      <main class="b-main">
        <section class="b-hero">
          <div class="hero-number">07</div>
          <div class="hero-copy"><p>DESIGN SYSTEMS · 2026/08/03</p><h1>为什么知识库<br>需要粗粝的<br><em>边界</em></h1></div>
          <aside><b>摘要</b><p>主题可以重写阅读体验，但不能修改什么内容被公开。</p><span>阅读时间 08:42</span></aside>
        </section>
        <section class="b-jump">
          <b>IN THIS ESSAY</b><a href="#boundary">01 边界</a><a href="#friction">02 摩擦</a><a href="#system">03 系统</a>
        </section>
        <div class="b-content">
          <article>${articleBody()}</article>
          <aside class="b-notes">
            <section><b>连接 / 06</b>${graph()}</section>
            <section><b>标签</b><div class="tag-wall"><a>#QUARTZ</a><a>#UI</a><a>#PUBLIC</a></div></section>
          </aside>
        </div>
        <section class="b-related">
          <div><small>READ NEXT / 08</small><h2>为搜索建立一种视觉语法</h2><span>→</span></div>
          <div><small>FROM THE INDEX</small><h2>所有设计系统文章</h2><span>↗</span></div>
        </section>
      </main>
      <footer class="b-footer"><strong>FIELD NOTES</strong><span>49 PUBLIC / 01 UNLISTED</span><span>BUILT WITH QUARTZ</span></footer>
      ${prototypeSwitcher('B')}
      ${searchOverlay()}
    </div>
  `
}

function variantC() {
  return `
    <div class="prototype variant-c" data-color="${colorMode}">
      <header class="c-topbar"><a href="#">FN://KNOWLEDGE</a><span>BUILD 007</span><span class="live">● LIVE</span><div>${searchButton('FIND [ / ]')}${modeButton()}</div></header>
      <div class="c-shell">
        <nav class="c-rail" aria-label="主导航"><button aria-label="首页">F</button><button class="active" aria-label="文章">01</button><button aria-label="图谱">02</button><button aria-label="标签">03</button><span></span><button aria-label="关于">?</button></nav>
        <aside class="c-index">
          <div class="terminal-title"><span>EXPLORER</span><b>49</b></div>
          <label>FILTER_<input value="" placeholder="type to filter"></label>
          ${explorer()}
          <div class="c-log"><span>13:42</span><p>INDEX REBUILT</p><span>13:41</span><p>ROUTES VERIFIED</p></div>
        </aside>
        <main class="c-main">
          <div class="c-path"><span>/ROOT/DESIGN-SYSTEMS/</span><b>ARTICLE_07</b></div>
          <article>
            <div class="c-label">DOCUMENT / PUBLIC</div>
            <h1>为什么知识库<br>需要粗粝的边界<span>_</span></h1>
            <div class="c-meta"><b>UPDATED</b><span>2026-08-03 13:37</span><b>TAGS</b><span>QUARTZ / UI / SYSTEM</span></div>
            ${articleBody()}
          </article>
          <div class="c-end">END_OF_DOCUMENT // 07</div>
        </main>
        <aside class="c-tools">
          ${graph()}
          ${toc()}
          <section class="c-backlinks quartz-panel"><div class="panel-title"><span>REFERENCES</span><b>04</b></div><a href="#">→ ROUTE CONTRACT</a><a href="#">→ VISIBILITY MODEL</a><a href="#">→ THEME API</a></section>
        </aside>
      </div>
      ${prototypeSwitcher('C')}
      ${searchOverlay()}
    </div>
  `
}

function prototypeSwitcher(active) {
  const activeVariant = variants.find(({ key }) => key === active)
  return `
    <div class="prototype-switcher" aria-label="原型方向切换">
      <button data-action="previous" aria-label="上一个方向">←</button>
      <span><small>THROWAWAY PROTOTYPE</small><b>${activeVariant.key} — ${activeVariant.name}</b></span>
      <button data-action="next" aria-label="下一个方向">→</button>
    </div>
  `
}

function searchOverlay() {
  return `
    <dialog class="search-dialog">
      <form method="dialog"><button aria-label="关闭搜索">×</button></form>
      <label>SEARCH THE PUBLIC INDEX<input autofocus placeholder="输入标题、标签或正文…"></label>
      <div class="search-results">
        <a href="#"><b>01</b><span>为什么知识库需要粗粝的边界<small>设计系统 · 当前文章</small></span></a>
        <a href="#"><b>02</b><span>Quartz 迁移决策<small>架构 · 8 分钟</small></span></a>
        <a href="#"><b>03</b><span>公开性的三个层级<small>安全 · 12 分钟</small></span></a>
      </div>
    </dialog>
  `
}

function render() {
  const variant = currentVariant()
  root.innerHTML = variant === 'A' ? variantA() : variant === 'B' ? variantB() : variantC()
  document.title = `PROTOTYPE ${variant} — ${variants.find(({ key }) => key === variant).name}`
}

function cycle(offset) {
  const active = currentVariant()
  const index = variants.findIndex(({ key }) => key === active)
  const next = variants[(index + offset + variants.length) % variants.length]
  const url = new URL(location.href)
  url.searchParams.set('variant', next.key)
  history.replaceState({}, '', url)
  render()
}

document.addEventListener('click', (event) => {
  const action = event.target.closest('[data-action]')?.dataset.action
  if (action === 'previous') cycle(-1)
  if (action === 'next') cycle(1)
  if (action === 'mode') {
    colorMode = colorMode === 'light' ? 'dark' : 'light'
    render()
  }
  if (action === 'search') document.querySelector('.search-dialog')?.showModal()

  const folder = event.target.closest('.folder')
  if (folder) {
    const list = folder.nextElementSibling
    const expanded = folder.getAttribute('aria-expanded') === 'true'
    folder.setAttribute('aria-expanded', String(!expanded))
    folder.textContent = `${expanded ? '+' : '−'} ${folder.textContent.slice(2)}`
    list.hidden = expanded
  }
})

document.addEventListener('keydown', (event) => {
  if (['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable) return
  if (event.key === 'ArrowLeft') cycle(-1)
  if (event.key === 'ArrowRight') cycle(1)
  if (event.key === '/') {
    event.preventDefault()
    document.querySelector('.search-dialog')?.showModal()
  }
})

render()
