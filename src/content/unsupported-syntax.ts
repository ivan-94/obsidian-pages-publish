import MarkdownIt, {
  type MarkdownIt as MarkdownItInstance,
  type StateInline,
} from 'markdown-it';
import type { ArticleSourceSnapshot } from '../publication/article-metadata';

export interface UnsupportedSyntaxIssue {
  severity: 'warning';
  code: 'unsupported-obsidian-comment';
  sourcePath: string;
  line: number;
  column: number;
  message: string;
  impact: string;
  dormant: boolean;
}

const tokenType = 'pages_publish_unsupported_obsidian_comment';
const degradedCommentMarker = '%%PAGES_PUBLISH_OBSIDIAN_COMMENT_REMOVED%%';
const unsupportedBlockParser = new MarkdownIt({ html: false });

export function installUnsupportedSyntaxRule(
  markdown: MarkdownItInstance,
): void {
  markdown.inline.ruler.before(
    'emphasis',
    'pages_publish_unsupported_obsidian_comment',
    obsidianCommentRule,
  );
  markdown.renderer.rules[tokenType] = () =>
    '<span data-pages-unsupported-syntax="obsidian-comment">Obsidian 注释已移除</span>';
}

export function degradeUnsupportedSyntax(source: string): string {
  const ranges = findObsidianCommentRanges(source);
  if (ranges.length === 0) return source;
  let output = '';
  let cursor = 0;
  for (const range of ranges) {
    output += source.slice(cursor, range.start);
    output += degradedCommentMarker;
    cursor = range.end;
  }
  return output + source.slice(cursor);
}

/** Removes Obsidian comments from immutable publication staging. */
export function removeUnsupportedSyntax(source: string): string {
  const ranges = findObsidianCommentRanges(source);
  if (ranges.length === 0) return source;
  let output = '';
  let cursor = 0;
  for (const range of ranges) {
    output += source.slice(cursor, range.start);
    cursor = range.end;
  }
  return output + source.slice(cursor);
}

export function inspectUnsupportedSyntax(
  snapshots: Map<string, ArticleSourceSnapshot>,
): UnsupportedSyntaxIssue[] {
  const issues: UnsupportedSyntaxIssue[] = [];
  for (const snapshot of snapshots.values()) {
    for (const range of findObsidianCommentRanges(snapshot.body)) {
      const before = snapshot.body.slice(0, range.start);
      const bodyLineIndex = before.match(/\n/gu)?.length ?? 0;
      const lineStart = before.lastIndexOf('\n') + 1;
      issues.push({
        severity: 'warning',
        code: 'unsupported-obsidian-comment',
        sourcePath: snapshot.sourcePath,
        line: snapshot.bodyStartLine + bodyLineIndex,
        column: range.start - lineStart + 1,
        message: 'Obsidian comments are not supported on published pages.',
        impact: 'The comment will be removed and replaced with a visible notice.',
        dormant: snapshot.metadata.visibility.value === 'private',
      });
    }
  }
  return issues.sort(
    (left, right) =>
      left.sourcePath.localeCompare(right.sourcePath) ||
      left.line - right.line ||
      left.column - right.column,
  );
}

function obsidianCommentRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (!state.src.startsWith(degradedCommentMarker, start)) return false;
  if (silent) {
    state.pos = start + degradedCommentMarker.length;
    return true;
  }
  state.push(tokenType, '', 0);
  state.pos = start + degradedCommentMarker.length;
  return true;
}

interface SourceRange {
  start: number;
  end: number;
}

function findObsidianCommentRanges(source: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  const markdownRanges = markdownSourceRanges(source);
  const protectedBlocks = markdownRanges.codeBlocks;
  let protectedIndex = 0;
  for (let cursor = 0; cursor < source.length; ) {
    while (
      protectedBlocks[protectedIndex] &&
      protectedBlocks[protectedIndex]!.end <= cursor
    ) {
      protectedIndex += 1;
    }
    const protectedBlock = protectedBlocks[protectedIndex];
    if (
      protectedBlock &&
      cursor >= protectedBlock.start &&
      cursor < protectedBlock.end
    ) {
      cursor = protectedBlock.end;
      continue;
    }
    if (source.startsWith('\\%%', cursor)) {
      const literalEnd = findUnescapedDoublePercent(
        source,
        cursor + 3,
        inlineBlockEnd(
          source,
          cursor,
          protectedBlock?.start,
          markdownRanges.inlineBlocks,
          markdownRanges.tableRows,
        ),
      );
      cursor = literalEnd === undefined ? cursor + 3 : literalEnd + 2;
      continue;
    }
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source[cursor] === '`') {
      const ticks = countRun(source, cursor, '`');
      const closing = findClosingBacktickRun(
        source,
        cursor + ticks,
        ticks,
        inlineBlockEnd(
          source,
          cursor,
          protectedBlock?.start,
          markdownRanges.inlineBlocks,
          markdownRanges.tableRows,
        ),
      );
      if (closing !== undefined) {
        cursor = closing + ticks;
        continue;
      }
    }
    if (source.startsWith('%%', cursor)) {
      const closing = findUnescapedDoublePercent(
        source,
        cursor + 2,
        source.length,
      );
      const end = closing === undefined ? source.length : closing + 2;
      ranges.push({ start: cursor, end });
      cursor = end;
      continue;
    }
    cursor += 1;
  }
  return ranges;
}

function markdownSourceRanges(source: string): {
  codeBlocks: SourceRange[];
  inlineBlocks: SourceRange[];
  tableRows: SourceRange[];
} {
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') lineStarts.push(index + 1);
  }
  const codeBlocks: SourceRange[] = [];
  const inlineBlocks: SourceRange[] = [];
  const tableRows: SourceRange[] = [];
  for (const token of unsupportedBlockParser.parse(source, {})) {
    if (!token.map) continue;
    const range = {
      start: lineStarts[token.map[0]] ?? source.length,
      end: lineStarts[token.map[1]] ?? source.length,
    };
    if (token.type === 'fence' || token.type === 'code_block') {
      codeBlocks.push(range);
    } else if (token.type === 'tr_open') {
      tableRows.push(range);
    } else if (token.type === 'inline') {
      inlineBlocks.push(range);
    }
  }
  const byStart = (left: SourceRange, right: SourceRange): number =>
    left.start - right.start || left.end - right.end;
  return {
    codeBlocks: codeBlocks.sort(byStart),
    inlineBlocks: inlineBlocks.sort(byStart),
    tableRows: tableRows.sort(byStart),
  };
}

function inlineBlockEnd(
  source: string,
  start: number,
  nextProtectedStart: number | undefined,
  inlineBlocks: readonly SourceRange[],
  tableRows: readonly SourceRange[],
): number {
  const limit = Math.min(nextProtectedStart ?? source.length, source.length);
  const tableRow = tableRows.find(
    (row) => start >= row.start && start < row.end,
  );
  if (tableRow) {
    return Math.min(nextUnescapedTablePipe(source, start, tableRow.end), limit);
  }
  let blockEnd: number | undefined;
  for (const block of inlineBlocks) {
    if (block.start > start) break;
    if (start >= block.start && start < block.end) {
      blockEnd = Math.min(blockEnd ?? block.end, block.end);
    }
  }
  if (blockEnd !== undefined) return Math.min(blockEnd, limit);
  const lineEnd = source.indexOf('\n', start);
  return Math.min(lineEnd < 0 ? source.length : lineEnd + 1, limit);
}

function nextUnescapedTablePipe(
  source: string,
  start: number,
  rowEnd: number,
): number {
  for (let cursor = start; cursor < rowEnd; cursor += 1) {
    if (source[cursor] !== '|') continue;
    let backslashes = 0;
    for (
      let previous = cursor - 1;
      previous >= 0 && source[previous] === '\\';
      previous -= 1
    ) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return cursor;
  }
  return rowEnd;
}

function findUnescapedDoublePercent(
  source: string,
  start: number,
  end: number,
): number | undefined {
  for (let cursor = start; cursor + 1 < end; cursor += 1) {
    if (!source.startsWith('%%', cursor)) continue;
    let backslashes = 0;
    for (
      let previous = cursor - 1;
      previous >= 0 && source[previous] === '\\';
      previous -= 1
    ) {
      backslashes += 1;
    }
    if (backslashes % 2 === 0) return cursor;
    cursor += 1;
  }
  return undefined;
}

function countRun(source: string, start: number, marker: string): number {
  let length = 0;
  while (source[start + length] === marker) length += 1;
  return length;
}

function findClosingBacktickRun(
  source: string,
  start: number,
  length: number,
  end: number,
): number | undefined {
  for (let cursor = start; cursor < end; cursor += 1) {
    if (source[cursor] !== '`') continue;
    const candidateLength = countRun(source, cursor, '`');
    if (candidateLength === length) return cursor;
    cursor += candidateLength - 1;
  }
  return undefined;
}
