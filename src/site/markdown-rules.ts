import type { MarkdownIt, Token } from 'markdown-it';
import { renderSafeMermaid } from '../content/mermaid';

export function installDefaultMarkdownRules(markdown: MarkdownIt): void {
  markdown.renderer.rules.pages_task_checkbox = (tokens, index) =>
    tokens[index]?.content ?? '';
  markdown.renderer.rules.pages_callout_title = (tokens, index) =>
    tokens[index]?.content ?? '';
  installTaskListRule(markdown);
  installCalloutRule(markdown);
  installMermaidFence(markdown);
}

function installTaskListRule(markdown: MarkdownIt): void {
  markdown.core.ruler.after('inline', 'pages_publish_task_lists', (state) => {
    for (let index = 0; index < state.tokens.length; index += 1) {
      const inline = state.tokens[index];
      if (inline?.type !== 'inline' || !inline.children) continue;
      const first = inline.children[0];
      if (first?.type !== 'text') continue;
      const match = /^\[([ xX])\]\s+/u.exec(first.content);
      if (!match || !insideListItem(state.tokens, index)) continue;
      const checked = match[1]?.toLowerCase() === 'x';
      first.content = first.content.slice(match[0].length);
      inline.content = inline.content.slice(match[0].length);
      const checkbox = new state.Token('pages_task_checkbox', '', 0);
      checkbox.content = `<input class="task-list-item-checkbox" type="checkbox" disabled${
        checked ? ' checked' : ''
      } aria-label="${checked ? '已完成任务' : '待办任务'}"> `;
      inline.children.unshift(checkbox);
      const listItem = nearestOpenListItem(state.tokens, index);
      listItem?.attrJoin('class', 'task-list-item');
    }
  });
}

function insideListItem(tokens: Token[], index: number): boolean {
  return nearestOpenListItem(tokens, index) !== undefined;
}

function nearestOpenListItem(tokens: Token[], index: number): Token | undefined {
  for (let current = index - 1; current >= 0; current -= 1) {
    const token = tokens[current];
    if (token?.type === 'list_item_close') return undefined;
    if (token?.type === 'list_item_open') return token;
  }
  return undefined;
}

function installCalloutRule(markdown: MarkdownIt): void {
  markdown.core.ruler.after('pages_publish_task_lists', 'pages_publish_callouts', (state) => {
    for (let index = 0; index + 2 < state.tokens.length; index += 1) {
      const open = state.tokens[index];
      const paragraph = state.tokens[index + 1];
      const inline = state.tokens[index + 2];
      if (
        open?.type !== 'blockquote_open' ||
        paragraph?.type !== 'paragraph_open' ||
        inline?.type !== 'inline' ||
        !inline.children
      ) {
        continue;
      }
      const marker = /^\[!([A-Za-z][\w-]{0,31})\](?:[ \t]+([^\n]*))?(?:\n|$)/u.exec(
        inline.content,
      );
      if (!marker) continue;
      const type = marker[1]!.toLowerCase();
      const title = marker[2]?.trim() || marker[1]!;
      open.tag = 'aside';
      open.attrJoin('class', 'callout');
      open.attrSet('data-callout', type);
      paragraph.attrJoin('class', 'callout-content');
      const close = matchingBlockquoteClose(state.tokens, index, open.level);
      if (close) close.tag = 'aside';
      removeCalloutMarker(inline, marker[0]);
      const titleToken = new state.Token('pages_callout_title', '', 0);
      titleToken.content = `<strong class="callout-title">${markdown.utils.escapeHtml(
        title,
      )}</strong>${inline.children.length > 0 ? '<br>' : ''}`;
      inline.children.unshift(titleToken);
    }
  });
}

function matchingBlockquoteClose(
  tokens: Token[],
  start: number,
  level: number,
): Token | undefined {
  for (let index = start + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token?.type === 'blockquote_close' && token.level === level) return token;
  }
  return undefined;
}

function removeCalloutMarker(inline: Token, marker: string): void {
  inline.content = inline.content.slice(marker.length);
  let remaining = marker.length;
  while (remaining > 0 && inline.children && inline.children.length > 0) {
    const child = inline.children[0]!;
    const representedLength = child.type === 'softbreak' ? 1 : child.content.length;
    if (representedLength <= remaining) {
      remaining -= representedLength;
      inline.children.shift();
      continue;
    }
    child.content = child.content.slice(remaining);
    remaining = 0;
  }
}

function installMermaidFence(markdown: MarkdownIt): void {
  const renderFence =
    markdown.renderer.rules.fence ??
    ((tokens, index, options, _environment, renderer) =>
      renderer.renderToken(tokens, index, options));
  markdown.renderer.rules.fence = (
    tokens,
    index,
    options,
    environment,
    renderer,
  ) => {
    const token = tokens[index];
    const language = token?.info.trim().split(/\s+/u, 1)[0]?.toLowerCase();
    if (token && language === 'mermaid') {
      const rendered = renderSafeMermaid(token.content);
      return rendered
        ? `<figure class="mermaid-diagram">${rendered}</figure>\n`
        : `<pre class="mermaid-fallback" data-pages-mermaid-fallback><code>${markdown.utils.escapeHtml(
            token.content,
          )}</code></pre>\n`;
    }
    return renderFence(tokens, index, options, environment, renderer);
  };
}
