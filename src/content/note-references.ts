import { posix } from 'path';
import MarkdownIt, {
  type MarkdownIt as MarkdownItInstance,
  type StateInline,
  type Token,
} from 'markdown-it';
import type { ArticleSourceSnapshot } from '../publication/article-metadata';
import type { SiteRoutePlan } from '../routing/route-planner';

export interface NoteReferenceResolution {
  kind: 'link' | 'text' | 'embed';
  text: string;
  url?: string;
  html?: string;
}

export type NoteReferenceResolver = (
  target: string,
  alias: string | undefined,
  embed: boolean,
) => NoteReferenceResolution;

export interface NoteReferenceIssue {
  severity: 'warning' | 'blocker';
  code: string;
  sourcePath: string;
  line: number;
  column: number;
  message: string;
  impact: string;
  dormant: boolean;
}

const resolverEnvironmentKey = 'pagesPublishNoteReferenceResolver';
const tokenMetadataKey = 'pagesPublishNoteReference';
const degradedReferenceTokenType = 'pages_publish_note_reference_text';

export const NOTE_EMBED_LIMITS = {
  maxDepth: 32,
  maxExpansions: 256,
  maxOutputCharacters: 1_000_000,
} as const;

export function installNoteReferenceRule(markdown: MarkdownItInstance): void {
  markdown.inline.ruler.before('link', 'pages_publish_note_reference', noteReferenceRule);
  markdown.renderer.rules[degradedReferenceTokenType] = (tokens, index) =>
    markdown.utils.escapeHtml(tokens[index]?.content ?? '');
}

const noteReferenceParser = new MarkdownIt({ html: false });
installNoteReferenceRule(noteReferenceParser);

export function createNoteReferenceResolver(
  sourcePath: string,
  snapshots: Map<string, ArticleSourceSnapshot>,
  routePlan: SiteRoutePlan,
  options: {
    renderEmbed?: (targetPath: string) => string | undefined;
  } = {},
): NoteReferenceResolver {
  const routes = new Map(
    routePlan.articles.map((article) => [article.sourcePath, article.url]),
  );
  const targetIndex = buildNoteTargetIndex(snapshots);
  return (target, alias, embed) => {
    const explicitText = alias?.trim();
    if (hasUnsupportedNoteAnchor(target)) {
      return { kind: 'text', text: explicitText || '不支持的定位链接' };
    }
    const targetResolution = resolveNoteTarget(
      sourcePath,
      target,
      snapshots,
      targetIndex,
    );
    const targetPath =
      targetResolution.status === 'resolved'
        ? targetResolution.sourcePath
        : undefined;
    const url = targetPath ? routes.get(targetPath) : undefined;
    if (!targetPath || !url) {
      return { kind: 'text', text: explicitText || '不可用链接' };
    }
    if (embed) {
      const html = options.renderEmbed?.(targetPath);
      return html === undefined
        ? { kind: 'text', text: explicitText || '嵌入已停止' }
        : { kind: 'embed', text: explicitText || '', html };
    }
    return {
      kind: 'link',
      text: explicitText || visibleReferenceText(target),
      url,
    };
  };
}

export function noteReferenceEnvironment(
  resolver: NoteReferenceResolver,
): Record<string, unknown> {
  return { [resolverEnvironmentKey]: resolver };
}

export function inspectNoteReferences(
  snapshots: Map<string, ArticleSourceSnapshot>,
): NoteReferenceIssue[] {
  const issues: NoteReferenceIssue[] = [];
  const references = new Map(
    [...snapshots.values()].map((snapshot) => [
      snapshot.sourcePath,
      extractNoteReferences(snapshot),
    ]),
  );
  const targetIndex = buildNoteTargetIndex(snapshots);
  const embedEdges = new Map<string, ResolvedEmbedEdge[]>();
  for (const snapshot of snapshots.values()) {
    const edges: ResolvedEmbedEdge[] = [];
    for (const reference of references.get(snapshot.sourcePath) ?? []) {
      if (!reference.embed || hasUnsupportedNoteAnchor(reference.target)) continue;
      const resolution = resolveNoteTarget(
        snapshot.sourcePath,
        reference.target,
        snapshots,
        targetIndex,
      );
      if (
        resolution.status !== 'resolved' ||
        snapshots.get(resolution.sourcePath)?.metadata.visibility.value === 'private'
      ) {
        continue;
      }
      edges.push({
        from: snapshot.sourcePath,
        to: resolution.sourcePath,
        reference,
      });
    }
    embedEdges.set(snapshot.sourcePath, edges);
  }
  const cyclicReferences = findCyclicEmbedReferences(embedEdges);
  for (const snapshot of snapshots.values()) {
    for (const reference of references.get(snapshot.sourcePath) ?? []) {
      if (hasUnsupportedNoteAnchor(reference.target)) {
        issues.push({
          severity: 'warning',
          code: 'unsupported-note-anchor',
          sourcePath: snapshot.sourcePath,
          line: reference.line,
          column: reference.column,
          message: 'Heading and block note references are not supported yet.',
          impact: 'The published page will show text until S07 adds anchor support.',
          dormant: snapshot.metadata.visibility.value === 'private',
        });
        continue;
      }
      const targetResolution = resolveNoteTarget(
        snapshot.sourcePath,
        reference.target,
        snapshots,
        targetIndex,
      );
      const targetPath =
        targetResolution.status === 'resolved'
          ? targetResolution.sourcePath
          : undefined;
      const privateEmbed =
        reference.embed &&
        targetPath !== undefined &&
        snapshots.get(targetPath)?.metadata.visibility.value === 'private';
      const cyclicEmbed =
        reference.embed &&
        targetPath !== undefined &&
        !privateEmbed &&
        cyclicReferences.has(reference);
      if (targetPath && !privateEmbed && !cyclicEmbed) continue;
      issues.push({
        severity: 'warning',
        code: privateEmbed
          ? 'private-note-embed'
          : cyclicEmbed
            ? 'cyclic-note-embed'
            : targetResolution.status === 'ambiguous'
              ? 'ambiguous-note-reference'
              : 'missing-note-reference',
        sourcePath: snapshot.sourcePath,
        line: reference.line,
        column: reference.column,
        message: privateEmbed
          ? 'A private note cannot be embedded in published content.'
          : cyclicEmbed
            ? 'A note embed participates in a recursive cycle.'
            : targetResolution.status === 'ambiguous'
              ? 'A note reference matches multiple files in the publishing scope.'
              : 'A note reference does not resolve inside the publishing scope.',
        impact: privateEmbed
          ? 'Private note content will not be embedded in the published page.'
          : cyclicEmbed
            ? 'The recursive embed will stop at the cycle boundary.'
            : targetResolution.status === 'ambiguous'
              ? 'The published page will show text instead of a guessed link.'
              : 'The published page will show text instead of a link.',
        dormant: snapshot.metadata.visibility.value === 'private',
      });
    }
  }
  addEmbedExpansionLimitIssues(issues, snapshots, embedEdges, cyclicReferences);
  return issues.sort(
    (left, right) =>
      left.sourcePath.localeCompare(right.sourcePath) ||
      left.line - right.line ||
      left.column - right.column,
  );
}

function noteReferenceRule(state: StateInline, silent: boolean): boolean {
  const referenceStart = state.pos;
  const embed = state.src.startsWith('![[', state.pos);
  const markerLength = embed ? 3 : 2;
  if (!embed && !state.src.startsWith('[[', state.pos)) return false;
  const end = state.src.indexOf(']]', state.pos + markerLength);
  if (end < 0) return false;
  const raw = state.src.slice(state.pos + markerLength, end);
  const separator = raw.indexOf('|');
  const target = (separator < 0 ? raw : raw.slice(0, separator)).trim();
  const alias = separator < 0 ? undefined : raw.slice(separator + 1);
  if (!target) return false;
  if (silent) {
    state.pos = end + 2;
    return true;
  }
  const resolver = state.env[resolverEnvironmentKey] as
    | NoteReferenceResolver
    | undefined;
  const resolution = resolver?.(target, alias, embed) ?? {
    kind: 'text' as const,
    text: alias?.trim() || '不可用链接',
  };
  let firstToken: Token;
  if (resolution.kind === 'link' && resolution.url) {
    const open = state.push('link_open', 'a', 1);
    firstToken = open;
    open.attrSet('href', resolution.url);
    state.push('text', '', 0).content = resolution.text;
    state.push('link_close', 'a', -1);
  } else if (resolution.kind === 'embed' && resolution.html !== undefined) {
    firstToken = state.push('html_inline', '', 0);
    firstToken.content = resolution.html;
  } else {
    firstToken = state.push(degradedReferenceTokenType, '', 0);
    firstToken.content = resolution.text;
  }
  firstToken.meta = {
    ...(firstToken.meta ?? {}),
    [tokenMetadataKey]: {
      target,
      embed,
      rawMarkup: state.src.slice(referenceStart, end + 2),
      offset: referenceStart,
    } satisfies NoteReferenceTokenMetadata,
  };
  state.pos = end + 2;
  return true;
}

interface ExtractedNoteReference {
  target: string;
  embed: boolean;
  line: number;
  column: number;
}

interface NoteReferenceTokenMetadata {
  target: string;
  embed: boolean;
  rawMarkup: string;
  offset: number;
}

function extractNoteReferences(
  snapshot: ArticleSourceSnapshot,
): ExtractedNoteReference[] {
  const references: ExtractedNoteReference[] = [];
  const bodyLines = snapshot.body.split(/\r?\n/u);
  for (const token of noteReferenceParser.parse(snapshot.body, {})) {
    if (token.type !== 'inline' || !token.children || !token.map) continue;
    for (const child of token.children) {
      const metadata = child.meta?.[tokenMetadataKey] as
        | NoteReferenceTokenMetadata
        | undefined;
      if (!metadata) continue;
      const precedingInline = token.content.slice(0, metadata.offset);
      const inlineLineOffset = precedingInline.match(/\n/gu)?.length ?? 0;
      const bodyLineIndex = token.map[0] + inlineLineOffset;
      const originalLine = bodyLines[bodyLineIndex] ?? '';
      const inlineLineStart = precedingInline.lastIndexOf('\n') + 1;
      const markerOffsetInInlineLine = metadata.offset - inlineLineStart;
      const inlineLineEnd = token.content.indexOf('\n', inlineLineStart);
      const inlineLine = token.content.slice(
        inlineLineStart,
        inlineLineEnd < 0 ? undefined : inlineLineEnd,
      );
      const inlineLineColumn = originalLine.indexOf(inlineLine);
      const markerColumn =
        inlineLineColumn < 0
          ? originalLine.indexOf(metadata.rawMarkup, markerOffsetInInlineLine)
          : inlineLineColumn + markerOffsetInInlineLine;
      references.push({
        target: metadata.target,
        embed: metadata.embed,
        line: snapshot.bodyStartLine + bodyLineIndex,
        column: markerColumn < 0 ? 1 : markerColumn + 1,
      });
    }
  }
  return references;
}

interface ResolvedEmbedEdge {
  from: string;
  to: string;
  reference: ExtractedNoteReference;
}

function findCyclicEmbedReferences(
  edgesBySource: Map<string, ResolvedEmbedEdge[]>,
): Set<ExtractedNoteReference> {
  const graph = new Map<string, string[]>();
  const reverseGraph = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const [sourcePath, edges] of edgesBySource) {
    nodes.add(sourcePath);
    for (const edge of edges) {
      nodes.add(edge.to);
      appendUnique(graph, sourcePath, edge.to);
      appendUnique(reverseGraph, edge.to, sourcePath);
    }
  }
  for (const node of nodes) {
    if (!graph.has(node)) graph.set(node, []);
    if (!reverseGraph.has(node)) reverseGraph.set(node, []);
  }

  const finishingOrder: string[] = [];
  const visited = new Set<string>();
  for (const start of nodes) {
    if (visited.has(start)) continue;
    visited.add(start);
    const stack: Array<{ node: string; nextIndex: number }> = [
      { node: start, nextIndex: 0 },
    ];
    while (stack.length > 0) {
      const frame = stack.at(-1)!;
      const neighbours = graph.get(frame.node) ?? [];
      const next = neighbours[frame.nextIndex];
      if (next !== undefined) {
        frame.nextIndex += 1;
        if (!visited.has(next)) {
          visited.add(next);
          stack.push({ node: next, nextIndex: 0 });
        }
        continue;
      }
      finishingOrder.push(frame.node);
      stack.pop();
    }
  }

  const componentByNode = new Map<string, number>();
  const componentSizes = new Map<number, number>();
  let component = 0;
  for (let index = finishingOrder.length - 1; index >= 0; index -= 1) {
    const start = finishingOrder[index]!;
    if (componentByNode.has(start)) continue;
    const stack = [start];
    componentByNode.set(start, component);
    let size = 0;
    while (stack.length > 0) {
      const node = stack.pop()!;
      size += 1;
      for (const previous of reverseGraph.get(node) ?? []) {
        if (componentByNode.has(previous)) continue;
        componentByNode.set(previous, component);
        stack.push(previous);
      }
    }
    componentSizes.set(component, size);
    component += 1;
  }

  const cyclicReferences = new Set<ExtractedNoteReference>();
  for (const edges of edgesBySource.values()) {
    for (const edge of edges) {
      const sourceComponent = componentByNode.get(edge.from);
      if (
        sourceComponent !== undefined &&
        sourceComponent === componentByNode.get(edge.to) &&
        ((componentSizes.get(sourceComponent) ?? 0) > 1 || edge.from === edge.to)
      ) {
        cyclicReferences.add(edge.reference);
      }
    }
  }
  return cyclicReferences;
}

function appendUnique(
  graph: Map<string, string[]>,
  source: string,
  target: string,
): void {
  const neighbours = graph.get(source) ?? [];
  if (!neighbours.includes(target)) neighbours.push(target);
  graph.set(source, neighbours);
}

function addEmbedExpansionLimitIssues(
  issues: NoteReferenceIssue[],
  snapshots: Map<string, ArticleSourceSnapshot>,
  edgesBySource: Map<string, ResolvedEmbedEdge[]>,
  cyclicReferences: Set<ExtractedNoteReference>,
): void {
  const issueKeys = new Set(
    issues.map((issue) =>
      [issue.code, issue.sourcePath, issue.line, issue.column].join(':'),
    ),
  );
  const roots = [...snapshots.values()].sort(
    (left, right) =>
      Number(left.metadata.visibility.value === 'private') -
        Number(right.metadata.visibility.value === 'private') ||
      left.sourcePath.localeCompare(right.sourcePath),
  );
  for (const root of roots) {
    let expansions = 0;
    let outputCharacters = 0;
    const stack: Array<{
      sourcePath: string;
      depth: number;
      ancestors: Set<string>;
      nextEdgeIndex: number;
    }> = [
      {
        sourcePath: root.sourcePath,
        depth: 0,
        ancestors: new Set([root.sourcePath]),
        nextEdgeIndex: 0,
      },
    ];
    while (stack.length > 0) {
      const state = stack.at(-1)!;
      const edges = edgesBySource.get(state.sourcePath) ?? [];
      const edge = edges[state.nextEdgeIndex];
      if (!edge) {
        stack.pop();
        continue;
      }
      state.nextEdgeIndex += 1;
      if (cyclicReferences.has(edge.reference) || state.ancestors.has(edge.to)) {
        continue;
      }
      const targetCharacters = snapshots.get(edge.to)?.body.length ?? 0;
      if (
        state.depth >= NOTE_EMBED_LIMITS.maxDepth ||
        expansions >= NOTE_EMBED_LIMITS.maxExpansions ||
        outputCharacters + targetCharacters >
          NOTE_EMBED_LIMITS.maxOutputCharacters
      ) {
        const issueKey = [
          'embed-expansion-limit',
          edge.from,
          edge.reference.line,
          edge.reference.column,
        ].join(':');
        if (!issueKeys.has(issueKey)) {
          issueKeys.add(issueKey);
          issues.push({
            severity: 'warning',
            code: 'embed-expansion-limit',
            sourcePath: edge.from,
            line: edge.reference.line,
            column: edge.reference.column,
            message: 'A nested note embed exceeds the safe expansion budget.',
            impact: 'Nested note content will stop at the safe expansion limit.',
            dormant: root.metadata.visibility.value === 'private',
          });
        }
        continue;
      }
      expansions += 1;
      outputCharacters += targetCharacters;
      const ancestors = new Set(state.ancestors);
      ancestors.add(edge.to);
      stack.push({
        sourcePath: edge.to,
        depth: state.depth + 1,
        ancestors,
        nextEdgeIndex: 0,
      });
    }
  }
}

type NoteTargetResolution =
  | { status: 'resolved'; sourcePath: string }
  | { status: 'ambiguous' }
  | { status: 'missing' };

interface NoteTargetIndex {
  exact: Map<string, string>;
  suffix: Map<string, string | null>;
}

function resolveNoteTarget(
  sourcePath: string,
  target: string,
  snapshots: Map<string, ArticleSourceSnapshot>,
  index: NoteTargetIndex = buildNoteTargetIndex(snapshots),
): NoteTargetResolution {
  const notePath = normalizeNoteTarget(target);
  if (!notePath) return { status: 'missing' };
  const exact = index.exact.get(notePath.normalize('NFC'));
  if (exact) return { status: 'resolved', sourcePath: exact };
  const relative = index.exact.get(
    posix.join(posix.dirname(sourcePath), notePath).normalize('NFC'),
  );
  if (relative) return { status: 'resolved', sourcePath: relative };
  const suffixMatch = index.suffix.get(notePath.normalize('NFC'));
  if (suffixMatch === null) return { status: 'ambiguous' };
  return suffixMatch === undefined
    ? { status: 'missing' }
    : { status: 'resolved', sourcePath: suffixMatch };
}

function normalizeNoteTarget(target: string): string | undefined {
  const withoutHeading = target.split('#', 1)[0]?.trim();
  if (!withoutHeading || withoutHeading.includes('\\')) return undefined;
  const withoutLeadingSlash = withoutHeading.replace(/^\/+/, '');
  const withExtension = withoutLeadingSlash.toLocaleLowerCase('en-US').endsWith('.md')
    ? withoutLeadingSlash
    : `${withoutLeadingSlash}.md`;
  const segments = withExtension.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return undefined;
  }
  return segments.join('/').normalize('NFC');
}

function hasUnsupportedNoteAnchor(target: string): boolean {
  return target.includes('#') || target.includes('^');
}

function buildNoteTargetIndex(
  snapshots: Map<string, ArticleSourceSnapshot>,
): NoteTargetIndex {
  const exact = new Map<string, string>();
  const suffix = new Map<string, string | null>();
  for (const sourcePath of snapshots.keys()) {
    const normalized = sourcePath.normalize('NFC');
    exact.set(normalized, sourcePath);
    const segments = normalized.split('/');
    for (let index = 0; index < segments.length; index += 1) {
      const candidate = segments.slice(index).join('/');
      const existing = suffix.get(candidate);
      if (existing === undefined) {
        suffix.set(candidate, sourcePath);
      } else if (existing !== sourcePath) {
        suffix.set(candidate, null);
      }
    }
  }
  return { exact, suffix };
}

function visibleReferenceText(target: string): string {
  const withoutHeading = target.split('#', 1)[0]?.trim() ?? target;
  return withoutHeading.replace(/\.md$/iu, '');
}
