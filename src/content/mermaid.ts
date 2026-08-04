import { renderMermaidSVG } from 'beautiful-mermaid';
import MarkdownIt from 'markdown-it';
import type { ArticleSourceSnapshot } from '../publication/article-metadata';

export interface MermaidIssue {
  severity: 'warning';
  code: 'unsafe-mermaid-directive' | 'mermaid-render-fallback';
  sourcePath: string;
  line: number;
  column: number;
  message: string;
  impact: string;
  dormant: boolean;
}

const mermaidParser = new MarkdownIt();
const maximumMermaidCharacters = 20_000;
const maximumMermaidLines = 200;

export function renderSafeMermaid(source: string): string | undefined {
  if (unsafeMermaidLine(source) !== undefined) return undefined;
  try {
    const rendered = renderMermaidSVG(source, {
      // Generated diagrams are emitted as external <img> assets. CSS custom
      // properties and currentColor do not cross that document boundary, so
      // give the asset its own neutral, high-contrast canvas.
      bg: '#f8f4eb',
      fg: '#151515',
      font: 'system-ui, sans-serif',
      transparent: false,
    }).replace(/^\s*@import[^\n]*(?:\n|$)/gimu, '');
    if (unsafeRenderedSvg(rendered)) return undefined;
    const annotated = rendered.replace(
      '<svg ',
      // SVG is XML, unlike HTML: a bare boolean data attribute makes the
      // generated asset invalid and Chromium renders it as a broken image.
      '<svg data-pages-mermaid="true" role="img" aria-label="Mermaid diagram" focusable="false" ',
    );
    // A standalone SVG cannot inherit the host page's background. Paint an
    // explicit neutral canvas before its chart primitives, so dark readers do
    // not get near-black edges and labels on a dark page.
    return annotated.replace(
      /(<svg\b[^>]*>)/u,
      '$1\n<rect width="100%" height="100%" fill="#f8f4eb"/>',
    );
  } catch {
    return undefined;
  }
}

export function inspectMermaid(
  snapshots: Map<string, ArticleSourceSnapshot>,
): MermaidIssue[] {
  const issues: MermaidIssue[] = [];
  for (const snapshot of snapshots.values()) {
    for (const token of mermaidParser.parse(snapshot.body, {})) {
      if (
        token.type !== 'fence' ||
        token.info.trim().split(/\s+/u, 1)[0]?.toLowerCase() !== 'mermaid' ||
        !token.map
      ) {
        continue;
      }
      const unsafeLine = unsafeMermaidLine(token.content);
      if (unsafeLine !== undefined) {
        issues.push({
          severity: 'warning',
          code: 'unsafe-mermaid-directive',
          sourcePath: snapshot.sourcePath,
          line: snapshot.bodyStartLine + token.map[0] + 1 + unsafeLine,
          column: 1,
          message: 'A Mermaid block contains an active or unsupported directive.',
          impact: 'The diagram will be shown as escaped source text.',
          dormant: snapshot.metadata.visibility.value === 'private',
        });
        continue;
      }
      if (renderSafeMermaid(token.content) !== undefined) continue;
      issues.push({
        severity: 'warning',
        code: 'mermaid-render-fallback',
        sourcePath: snapshot.sourcePath,
        line: snapshot.bodyStartLine + token.map[0],
        column: 1,
        message: 'A Mermaid block could not be rendered by the built-in renderer.',
        impact: 'The diagram will be shown as escaped source text.',
        dormant: snapshot.metadata.visibility.value === 'private',
      });
    }
  }
  return issues.sort(
    (left, right) =>
      left.sourcePath.localeCompare(right.sourcePath) || left.line - right.line,
  );
}

function unsafeMermaidLine(source: string): number | undefined {
  const lines = source.split(/\r?\n/u);
  if (
    source.length > maximumMermaidCharacters ||
    lines.length > maximumMermaidLines
  ) {
    return 0;
  }
  const unsafe =
    /%%\{|^\s*(?:click|href|classDef|linkStyle|style)\b|(?:javascript|vbscript|data)\s*:|<\/?[A-Za-z][^>]*>/iu;
  const index = lines.findIndex((line) => unsafe.test(line));
  return index < 0 ? undefined : index;
}

function unsafeRenderedSvg(svg: string): boolean {
  return (
    /<\s*(?:script|foreignObject|iframe|object|embed|image|a|use)\b/iu.test(
      svg,
    ) ||
    /\son[a-z][\w:.-]*\s*=/iu.test(svg) ||
    /\s(?:href|src)\s*=\s*["']\s*(?!#)/iu.test(svg) ||
    /url\(\s*["']?(?!#)/iu.test(svg) ||
    /(?:javascript|vbscript|data)\s*:/iu.test(svg)
  );
}
