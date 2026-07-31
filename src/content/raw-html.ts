import MarkdownIt, {
  type MarkdownIt as MarkdownItInstance,
} from 'markdown-it';
import type { ArticleSourceSnapshot } from '../publication/article-metadata';

export interface RawHtmlIssue {
  severity: 'warning';
  code: 'unsafe-raw-html';
  sourcePath: string;
  line: number;
  column: number;
  message: string;
  impact: string;
  dormant: boolean;
}

const rawHtmlParser = new MarkdownIt({ html: true });

export function installRawHtmlSafetyRule(markdown: MarkdownItInstance): void {
  markdown.renderer.rules.html_block = (tokens, index) =>
    markdown.utils.escapeHtml(stripRawHtml(tokens[index]?.content ?? ''));
  markdown.renderer.rules.html_inline = (tokens, index) =>
    markdown.utils.escapeHtml(stripRawHtml(tokens[index]?.content ?? ''));
}

export function inspectRawHtml(
  snapshots: Map<string, ArticleSourceSnapshot>,
): RawHtmlIssue[] {
  const issues: RawHtmlIssue[] = [];
  for (const snapshot of snapshots.values()) {
    const dormant = snapshot.metadata.visibility.value === 'private';
    const bodyLines = snapshot.body.split(/\r?\n/u);
    const candidateLines = new Set<number>();
    for (const token of rawHtmlParser.parse(snapshot.body, {})) {
      if (token.type === 'html_block' && token.map) {
        for (let line = token.map[0]; line < token.map[1]; line += 1) {
          candidateLines.add(line);
        }
      }
      if (token.type !== 'inline' || !token.children || !token.map) continue;
      if (token.children.some((child) => child.type === 'html_inline')) {
        for (let line = token.map[0]; line < token.map[1]; line += 1) {
          candidateLines.add(line);
        }
      }
    }
    const finalCandidateLine = Math.max(...candidateLines, -1);
    for (const bodyLineIndex of candidateLines) {
      const sourceLine = bodyLines[bodyLineIndex] ?? '';
      const candidateSource = bodyLines
        .slice(bodyLineIndex, finalCandidateLine + 1)
        .join('\n');
      const column = findRawHtmlColumn(sourceLine, candidateSource);
      if (column < 0) continue;
      issues.push({
        severity: 'warning',
        code: 'unsafe-raw-html',
        sourcePath: snapshot.sourcePath,
        line: snapshot.bodyStartLine + bodyLineIndex,
        column: column + 1,
        message: 'Raw HTML is disabled by the publishing safety policy.',
        impact: 'Unsafe HTML will be removed from the rendered page.',
        dormant,
      });
    }
  }
  return issues.sort(
    (left, right) =>
      left.sourcePath.localeCompare(right.sourcePath) || left.line - right.line,
  );
}

function findRawHtmlColumn(
  sourceLine: string,
  sourceFromLine: string,
): number {
  let searchFrom = 0;
  while (searchFrom < sourceLine.length) {
    const column = sourceLine.indexOf('<', searchFrom);
    if (column < 0) return -1;
    const candidate = sourceFromLine.slice(column);
    if (
      /^<\s*\/?[A-Za-z][\w:.-]*(?:\s[\s\S]*?|\/?)>/u.test(candidate) ||
      /^<\s*[!?][\s\S]*?>/u.test(candidate)
    ) {
      return column;
    }
    searchFrom = column + 1;
  }
  return -1;
}

const activeHtmlElements = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'foreignobject',
  'template',
  'audio',
  'video',
]);

function stripRawHtml(source: string): string {
  let output = '';
  const suppressedElements: string[] = [];
  for (let index = 0; index < source.length; ) {
    if (source[index] !== '<') {
      if (suppressedElements.length === 0) output += source[index];
      index += 1;
      continue;
    }
    const tagEnd = findHtmlTagEnd(source, index + 1);
    if (tagEnd < 0) break;
    const tag = source.slice(index, tagEnd + 1);
    const match = /^<\s*(\/?)\s*([A-Za-z][\w:.-]*)/u.exec(tag);
    if (match) {
      const closing = match[1] === '/';
      const localName = (match[2]?.split(':').at(-1) ?? '').toLowerCase();
      if (closing) {
        if (suppressedElements.at(-1) === localName) suppressedElements.pop();
      } else if (
        activeHtmlElements.has(localName) &&
        !/\/\s*>$/u.test(tag)
      ) {
        suppressedElements.push(localName);
      }
    }
    index = tagEnd + 1;
  }
  return output;
}

function findHtmlTagEnd(source: string, start: number): number {
  let quote: '"' | "'" | undefined;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return index;
  }
  return -1;
}
