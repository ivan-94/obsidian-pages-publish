import { createHash } from 'crypto';
import { constants } from 'fs';
import {
  lstat,
  open,
  readdir,
  realpath,
  type FileHandle,
} from 'fs/promises';
import { extname, posix, relative, resolve, sep } from 'path';
import MarkdownIt, {
  type MarkdownIt as MarkdownItInstance,
  type StateInline,
  type Token,
} from 'markdown-it';
import { minimatch } from 'minimatch';
import type { ArticleSourceSnapshot } from '../publication/article-metadata';
import type { ExternalLinkCandidate } from './external-link-checker';
import {
  decodeWebpImage,
  type WebpDecoderBoundary,
} from './webp-decoder';

export interface PreviewAsset {
  content: Uint8Array;
  contentType: string;
}

export interface LocalAssetPlan {
  assets: Record<string, PreviewAsset>;
  issues: LocalAssetIssue[];
  externalLinks: ExternalLinkCandidate[];
  claimsObsidianAsset(sourcePath: string, reference: string): boolean;
  resolveImage(sourcePath: string, reference: string): string | undefined;
  shouldDegrade(sourcePath: string, reference: string): boolean;
}

export interface LocalAssetIssue {
  severity: 'warning' | 'blocker';
  code: string;
  sourcePath: string;
  line: number;
  column: number;
  message: string;
  impact: string;
  dormant: boolean;
}

export interface LocalAssetFileSystemBoundary {
  openFile(path: string, flags: number): Promise<FileHandle>;
}

const localAssetEnvironmentKey = 'pagesPublishLocalAssetEnvironment';
const obsidianAssetTokenMetadataKey = 'pagesPublishObsidianAsset';
const assetParser = new MarkdownIt({ html: false });
const largeImageThresholdBytes = 5 * 1024 * 1024;
const maximumLocalAssetBytes = 25 * 1024 * 1024;
const maximumLocalAssetTotalBytes = 100 * 1024 * 1024;
const maximumLocalAssetCount = 1_000;
const maximumVaultIndexEntries = 100_000;
assetParser.inline.ruler.before(
  'link',
  'pages_publish_obsidian_image',
  obsidianImageRule,
);

export async function collectLocalPreviewAssets(
  vaultRoot: string,
  snapshots: Map<string, ArticleSourceSnapshot>,
  excludePatterns: readonly string[] = [],
  includedSourcePaths?: ReadonlySet<string>,
  options: {
    fileSystem?: Partial<LocalAssetFileSystemBoundary>;
    signal?: AbortSignal;
    retainAssets?: boolean;
    webpDecoder?: WebpDecoderBoundary;
  } = {},
): Promise<LocalAssetPlan> {
  const fileSystem: LocalAssetFileSystemBoundary = {
    openFile: async (path, flags) => open(path, flags),
    ...options.fileSystem,
  };
  const assets: Record<string, PreviewAsset> = {};
  const issues: LocalAssetIssue[] = [];
  const externalLinks: ExternalLinkCandidate[] = [];
  const externalLinkKeys = new Set<string>();
  const resolvedReferences = new Map<string, string>();
  const degradedReferences = new Set<string>();
  const claimedObsidianAssets = new Set<string>();
  const selectedBudgetedPaths = new Set<string>();
  const dormantBudgetedPaths = new Set<string>();
  const verifiedAssetCache = new Map<
    string,
    {
      outputPath: string;
      contentType: string;
      content?: Buffer;
    }
  >();
  let selectedAssetBytes = 0;
  let dormantAssetBytes = 0;
  let selectedAssetReferences = 0;
  let dormantAssetReferences = 0;
  let selectedReferenceLimitReported = false;
  let dormantReferenceLimitReported = false;
  throwIfLocalAssetAborted(options.signal);
  const canonicalVaultRoot = await realpath(vaultRoot);
  const vaultIndex = [...snapshots.values()].some((snapshot) =>
    snapshot.body.includes('![['),
  )
    ? await listVaultFiles(canonicalVaultRoot, options.signal)
    : { files: [], complete: true };
  const vaultFiles = vaultIndex.files;
  for (const snapshot of snapshots.values()) {
    throwIfLocalAssetAborted(options.signal);
    const selected = includedSourcePaths
      ? includedSourcePaths.has(snapshot.sourcePath)
      : snapshot.metadata.visibility.value !== 'private';
    if (!selected && snapshot.metadata.visibility.value !== 'private') continue;
    const dormant = !selected;
    for (const image of extractMarkdownAssetReferences(snapshot)) {
      const referenceKeyValue = referenceKey(
        snapshot.sourcePath,
        image.reference,
      );
      if (
        image.obsidian &&
        resolvesSnapshotNote(snapshot.sourcePath, image.reference, snapshots)
      ) {
        continue;
      }
      if (image.obsidian && supportedImageReference(image.reference)) {
        claimedObsidianAssets.add(referenceKeyValue);
      }
      if (
        image.kind === 'cover' &&
        (externalHttpUrl(image.reference) ||
          !supportedImageReference(image.reference))
      ) {
        degradedReferences.add(referenceKeyValue);
        issues.push({
          severity: dormant ? 'warning' : 'blocker',
          code: 'invalid-publication-cover',
          sourcePath: snapshot.sourcePath,
          line: image.line,
          column: image.column,
          message:
            'publication.cover must reference a supported image inside the Vault.',
          impact: 'The cover cannot be included in the next site version.',
          dormant,
        });
        continue;
      }
      if (externalHttpUrl(image.reference)) {
        if (validExternalHttpUrl(image.reference)) {
          const key = [
            snapshot.sourcePath,
            image.line,
            image.column,
            image.reference,
          ].join('\0');
          if (!dormant && !externalLinkKeys.has(key)) {
            externalLinkKeys.add(key);
            externalLinks.push({
              url: image.reference,
              sourcePath: snapshot.sourcePath,
              line: image.line,
              column: image.column,
            });
          }
          continue;
        }
        degradedReferences.add(referenceKeyValue);
        issues.push({
          severity: 'warning',
          code: 'invalid-external-url',
          sourcePath: snapshot.sourcePath,
          line: image.line,
          column: image.column,
          message: 'An external resource URL is malformed.',
          impact: 'The external resource will be shown as text.',
          dormant,
        });
        continue;
      }
      const countsAsLocalAsset =
        image.kind !== 'link' || potentialLocalAttachmentLink(image.reference);
      if (countsAsLocalAsset) {
        if (dormant) {
          dormantAssetReferences += 1;
        } else {
          selectedAssetReferences += 1;
        }
        const exceedsReferenceLimit =
          (dormant ? dormantAssetReferences : selectedAssetReferences) >
          maximumLocalAssetCount;
        if (exceedsReferenceLimit) {
          const alreadyReported = dormant
            ? dormantReferenceLimitReported
            : selectedReferenceLimitReported;
          if (!alreadyReported) {
            if (dormant) {
              dormantReferenceLimitReported = true;
            } else {
              selectedReferenceLimitReported = true;
            }
            issues.push({
              severity: dormant ? 'warning' : 'blocker',
              code: 'local-image-resource-limit',
              sourcePath: snapshot.sourcePath,
              line: image.line,
              column: image.column,
              message:
                'The article set exceeds the safe local asset reference budget.',
              impact: 'Additional image references cannot be processed safely.',
              dormant,
            });
          }
          degradedReferences.add(referenceKeyValue);
          continue;
        }
      }
      if (image.kind === 'link') {
        if (!potentialLocalAttachmentLink(image.reference)) continue;
        if (!supportedImageReference(image.reference)) {
          degradedReferences.add(referenceKeyValue);
          issues.push({
            severity: 'warning',
            code: 'unsupported-local-attachment',
            sourcePath: snapshot.sourcePath,
            line: image.line,
            column: image.column,
            message: 'A referenced local attachment type is not hosted in v1.',
            impact:
              'The attachment will not be uploaded in the next site version.',
            dormant,
          });
          continue;
        }
      }
      if (!supportedImageReference(image.reference)) {
        if (image.obsidian) {
          const attachmentPath = await resolveLocalAssetPath(
            canonicalVaultRoot,
            snapshot.sourcePath,
            image.reference,
            {
              obsidian: true,
              vaultFiles,
              vaultIndexComplete: vaultIndex.complete,
            },
          );
          if (attachmentPath.status === 'missing') continue;
          claimedObsidianAssets.add(referenceKeyValue);
        }
        degradedReferences.add(referenceKeyValue);
        issues.push({
          severity: 'warning',
          code: 'unsupported-local-attachment',
          sourcePath: snapshot.sourcePath,
          line: image.line,
          column: image.column,
          message: 'A referenced local attachment type is not hosted in v1.',
          impact: 'The attachment will not be uploaded in the next site version.',
          dormant,
        });
        continue;
      }
      const pathResolution = await resolveLocalAssetPath(
        canonicalVaultRoot,
        image.kind === 'cover' ? '' : snapshot.sourcePath,
        image.reference,
        {
          obsidian: image.obsidian,
          vaultFiles,
          vaultIndexComplete: vaultIndex.complete,
        },
      );
      if (pathResolution.status === 'ambiguous') {
        degradedReferences.add(referenceKeyValue);
        issues.push({
          severity: dormant ? 'warning' : 'blocker',
          code: 'local-image-ambiguous',
          sourcePath: snapshot.sourcePath,
          line: image.line,
          column: image.column,
          message: 'An Obsidian image reference matches multiple Vault files.',
          impact: 'The image cannot be included without an explicit Vault path.',
          dormant,
        });
        continue;
      }
      if (pathResolution.status === 'missing') {
        degradedReferences.add(referenceKeyValue);
        issues.push({
          severity: dormant ? 'warning' : 'blocker',
          code: 'local-image-missing',
          sourcePath: snapshot.sourcePath,
          line: image.line,
          column: image.column,
          message: 'A referenced local image is missing.',
          impact: 'The image cannot be included in the next site version.',
          dormant,
        });
        continue;
      }
      if (pathResolution.status === 'unsafe') {
        degradedReferences.add(referenceKeyValue);
        issues.push({
          severity: dormant ? 'warning' : 'blocker',
          code: 'local-image-unsafe-path',
          sourcePath: snapshot.sourcePath,
          line: image.line,
          column: image.column,
          message: 'A referenced local image has an unsafe Vault path.',
          impact: 'The image cannot be included in the next site version.',
          dormant,
        });
        continue;
      }
      if (pathResolution.status === 'unreadable') {
        degradedReferences.add(referenceKeyValue);
        issues.push({
          severity: dormant ? 'warning' : 'blocker',
          code: 'local-image-unreadable',
          sourcePath: snapshot.sourcePath,
          line: image.line,
          column: image.column,
          message: 'A referenced local image is not a readable regular file.',
          impact: 'The image cannot be included in the next site version.',
          dormant,
        });
        continue;
      }
      if (pathResolution.status !== 'resolved') continue;
      const assetBytes = Number(pathResolution.size);
      const budgetedPaths = dormant
        ? dormantBudgetedPaths
        : selectedBudgetedPaths;
      const totalAssetBytes = dormant ? dormantAssetBytes : selectedAssetBytes;
      const newlyBudgeted = !budgetedPaths.has(pathResolution.sourcePath);
      if (
        assetBytes > maximumLocalAssetBytes ||
        (newlyBudgeted &&
          (budgetedPaths.size >= maximumLocalAssetCount ||
            totalAssetBytes + assetBytes > maximumLocalAssetTotalBytes))
      ) {
        degradedReferences.add(referenceKeyValue);
        issues.push({
          severity: dormant ? 'warning' : 'blocker',
          code: 'local-image-resource-limit',
          sourcePath: snapshot.sourcePath,
          line: image.line,
          column: image.column,
          message: 'A referenced local image exceeds the safe resource budget.',
          impact: 'The image cannot be included until it is reduced or removed.',
          dormant,
        });
        continue;
      }
      if (newlyBudgeted) {
        budgetedPaths.add(pathResolution.sourcePath);
        if (dormant) {
          dormantAssetBytes += assetBytes;
        } else {
          selectedAssetBytes += assetBytes;
        }
      }
      if (
        excludePatterns.some((pattern) =>
          matchesVaultGlob(pathResolution.vaultPath, pattern),
        )
      ) {
        degradedReferences.add(referenceKeyValue);
        issues.push({
          severity: dormant ? 'warning' : 'blocker',
          code: 'local-image-excluded',
          sourcePath: snapshot.sourcePath,
          line: image.line,
          column: image.column,
          message: 'A referenced local image is excluded by site configuration.',
          impact: 'The image cannot be included in the next site version.',
          dormant,
        });
        continue;
      }
      const format = supportedImageFormat(pathResolution.sourcePath);
      if (!format) continue;
      const cached = verifiedAssetCache.get(pathResolution.sourcePath);
      if (
        cached &&
        (dormant ||
          options.retainAssets === false ||
          cached.content !== undefined)
      ) {
        if (!dormant) {
          if (options.retainAssets !== false && cached.content) {
            assets[cached.outputPath] = {
              content: cached.content,
              contentType: cached.contentType,
            };
          }
          resolvedReferences.set(referenceKeyValue, cached.outputPath);
        }
        continue;
      }
      const readResult = await readVerifiedAsset(
        pathResolution,
        fileSystem,
        options.signal,
      );
      if (readResult.status !== 'read') {
        degradedReferences.add(referenceKeyValue);
        issues.push({
          severity: dormant ? 'warning' : 'blocker',
          code:
            readResult.status === 'unsafe'
              ? 'local-image-unsafe-path'
              : readResult.status === 'resource-limit'
                ? 'local-image-resource-limit'
                : 'local-image-unreadable',
          sourcePath: snapshot.sourcePath,
          line: image.line,
          column: image.column,
          message:
            readResult.status === 'unsafe'
              ? 'A referenced local image changed to an unsafe Vault path.'
              : readResult.status === 'resource-limit'
                ? 'A referenced local image expanded beyond the safe resource budget.'
                : 'A referenced local image is not readable.',
          impact:
            readResult.status === 'resource-limit'
              ? 'The image cannot be included until it is reduced or removed.'
              : 'The image cannot be included in the next site version.',
          dormant,
        });
        continue;
      }
      const content = readResult.content;
      if (format.extension === '.svg' && svgHasActiveContent(content)) {
        degradedReferences.add(referenceKeyValue);
        issues.push({
          severity: dormant ? 'warning' : 'blocker',
          code: 'unsafe-svg-active-content',
          sourcePath: snapshot.sourcePath,
          line: image.line,
          column: image.column,
          message: 'A referenced SVG contains active or externally loaded content.',
          impact: 'The SVG cannot be included in the next site version.',
          dormant,
        });
        continue;
      }
      if (
        !(await contentMatchesImageFormat(
          content,
          format.extension,
          options.signal,
          options.webpDecoder ?? decodeWebpImage,
        ))
      ) {
        degradedReferences.add(referenceKeyValue);
        issues.push({
          severity: dormant ? 'warning' : 'blocker',
          code: 'local-image-format-mismatch',
          sourcePath: snapshot.sourcePath,
          line: image.line,
          column: image.column,
          message: 'A referenced file does not match its image extension.',
          impact: 'The file cannot be included as a supported image.',
          dormant,
        });
        continue;
      }
      throwIfLocalAssetAborted(options.signal);
      if (content.byteLength > largeImageThresholdBytes) {
        issues.push({
          severity: 'warning',
          code: 'large-local-image',
          sourcePath: snapshot.sourcePath,
          line: image.line,
          column: image.column,
          message: 'A referenced local image is larger than 5 MiB.',
          impact: 'The image may make preview and deployment slower.',
          dormant,
        });
      }
      const digest = createHash('sha256').update(content).digest('hex');
      const outputPath = `/assets/${digest}${format.extension}`;
      verifiedAssetCache.set(pathResolution.sourcePath, {
        outputPath,
        contentType: format.contentType,
        ...(!dormant && options.retainAssets !== false ? { content } : {}),
      });
      if (dormant) continue;
      if (options.retainAssets !== false) {
        assets[outputPath] = { content, contentType: format.contentType };
      }
      resolvedReferences.set(
        referenceKey(snapshot.sourcePath, image.reference),
        outputPath,
      );
    }
  }
  return {
    assets,
    issues,
    externalLinks: externalLinks.sort(
      (left, right) =>
        left.sourcePath.localeCompare(right.sourcePath) ||
        left.line - right.line ||
        left.column - right.column ||
        left.url.localeCompare(right.url),
    ),
    claimsObsidianAsset: (sourcePath, reference) =>
      claimedObsidianAssets.has(referenceKey(sourcePath, reference)),
    resolveImage: (sourcePath, reference) =>
      resolvedReferences.get(referenceKey(sourcePath, reference)),
    shouldDegrade: (sourcePath, reference) =>
      degradedReferences.has(referenceKey(sourcePath, reference)),
  };
}

export function installLocalAssetRule(markdown: MarkdownItInstance): void {
  markdown.inline.ruler.before(
    'link',
    'pages_publish_obsidian_image',
    obsidianImageRule,
  );
  const defaultImageRenderer =
    markdown.renderer.rules.image ??
    ((tokens, index, options, _environment, renderer) =>
      renderer.renderToken(tokens, index, options));
  markdown.renderer.rules.image = (
    tokens,
    index,
    options,
    environment,
    renderer,
  ) => {
    const token = tokens[index];
    const context = (environment ?? {})[localAssetEnvironmentKey] as
      | LocalAssetRenderEnvironment
      | undefined;
    const reference = token?.attrGet('src');
    if (token && context && typeof reference === 'string' && reference) {
      if (context.plan.shouldDegrade(context.sourcePath, reference)) {
        return markdown.utils.escapeHtml(token.content);
      }
      const outputPath = context.plan.resolveImage(
        context.sourcePath,
        reference,
      );
      if (outputPath) token.attrSet('src', outputPath);
      if (!outputPath && !externalHttpUrl(reference)) {
        return markdown.utils.escapeHtml(token.content);
      }
    }
    return defaultImageRenderer(tokens, index, options, environment, renderer);
  };
  const defaultLinkOpenRenderer =
    markdown.renderer.rules.link_open ??
    ((tokens, index, options, _environment, renderer) =>
      renderer.renderToken(tokens, index, options));
  const defaultLinkCloseRenderer =
    markdown.renderer.rules.link_close ??
    ((tokens, index, options, _environment, renderer) =>
      renderer.renderToken(tokens, index, options));
  markdown.renderer.rules.link_open = (
    tokens,
    index,
    options,
    environment,
    renderer,
  ) => {
    const context = (environment ?? {})[localAssetEnvironmentKey] as
      | LocalAssetRenderEnvironment
      | undefined;
    const reference = tokens[index]?.attrGet('href');
    if (
      context &&
      typeof reference === 'string' &&
      context.plan.shouldDegrade(context.sourcePath, reference)
    ) {
      context.suppressedLinkClosures += 1;
      return '';
    }
    if (context && typeof reference === 'string') {
      const outputPath = context.plan.resolveImage(
        context.sourcePath,
        reference,
      );
      if (outputPath) tokens[index]?.attrSet('href', outputPath);
    }
    return defaultLinkOpenRenderer(tokens, index, options, environment, renderer);
  };
  markdown.renderer.rules.link_close = (
    tokens,
    index,
    options,
    environment,
    renderer,
  ) => {
    const context = (environment ?? {})[localAssetEnvironmentKey] as
      | LocalAssetRenderEnvironment
      | undefined;
    if (context && context.suppressedLinkClosures > 0) {
      context.suppressedLinkClosures -= 1;
      return '';
    }
    return defaultLinkCloseRenderer(tokens, index, options, environment, renderer);
  };
}

function obsidianImageRule(state: StateInline, silent: boolean): boolean {
  if (!state.src.startsWith('![[', state.pos)) return false;
  const end = state.src.indexOf(']]', state.pos + 3);
  if (end < 0) return false;
  const raw = state.src.slice(state.pos + 3, end);
  const separator = raw.indexOf('|');
  const target = (separator < 0 ? raw : raw.slice(0, separator)).trim();
  if (!target || !isObsidianLocalAssetTarget(target)) return false;
  const context = state.env[localAssetEnvironmentKey] as
    | LocalAssetRenderEnvironment
    | undefined;
  if (
    context &&
    !context.plan.claimsObsidianAsset(context.sourcePath, target)
  ) {
    return false;
  }
  const alt =
    (separator < 0 ? undefined : raw.slice(separator + 1).trim()) ||
    posix.basename(target, extname(target));
  if (silent) {
    state.pos = end + 2;
    return true;
  }
  const token = state.push('image', 'img', 0);
  token.attrs = [
    ['src', target],
    ['alt', ''],
  ];
  const altToken = new state.Token('text', '', 0);
  altToken.content = alt;
  token.children = [altToken];
  token.content = alt;
  token.meta = {
    ...(token.meta ?? {}),
    [obsidianAssetTokenMetadataKey]: true,
  };
  state.pos = end + 2;
  return true;
}

export function isObsidianLocalAssetTarget(target: string): boolean {
  const extension = extname(safelyDecodeUri(target)).toLowerCase();
  return extension.length > 0 && extension !== '.md';
}

export function obsidianAssetClaimFromEnvironment(
  environment: Record<string, unknown>,
  target: string,
): boolean | undefined {
  const context = environment[localAssetEnvironmentKey] as
    | LocalAssetRenderEnvironment
    | undefined;
  return context?.plan.claimsObsidianAsset(context.sourcePath, target);
}

export function localAssetEnvironment(
  sourcePath: string,
  plan: LocalAssetPlan,
): Record<string, unknown> {
  return {
    [localAssetEnvironmentKey]: {
      sourcePath,
      plan,
      suppressedLinkClosures: 0,
    } satisfies LocalAssetRenderEnvironment,
  };
}

interface LocalAssetRenderEnvironment {
  sourcePath: string;
  plan: LocalAssetPlan;
  suppressedLinkClosures: number;
}

interface ExtractedMarkdownAssetReference {
  kind: 'image' | 'link' | 'cover';
  reference: string;
  obsidian: boolean;
  line: number;
  column: number;
}

function extractMarkdownAssetReferences(
  snapshot: ArticleSourceSnapshot,
): ExtractedMarkdownAssetReference[] {
  const references: ExtractedMarkdownAssetReference[] = [];
  if (snapshot.metadata.cover) {
    const sourceLines = snapshot.source.split(/\r?\n/u);
    const coverLineIndex = sourceLines.findIndex((line) => /^\s*cover\s*:/u.test(line));
    const coverLine = sourceLines[coverLineIndex] ?? '';
    references.push({
      kind: 'cover',
      reference: snapshot.metadata.cover.value,
      obsidian: false,
      line: coverLineIndex < 0 ? 1 : coverLineIndex + 1,
      column: Math.max(1, coverLine.indexOf('cover') + 1),
    });
  }
  const bodyLines = snapshot.body.split(/\r?\n/u);
  for (const inline of assetParser.parse(snapshot.body, {})) {
    if (inline.type !== 'inline' || !inline.children || !inline.map) continue;
    const semanticReferences = flattenAssetTokens(inline.children);
    const candidates = findAssetMarkupCandidates(inline.content);
    let candidateIndex = 0;
    for (const semantic of semanticReferences) {
      let candidate: AssetMarkupCandidate | undefined;
      while (candidateIndex < candidates.length) {
        const current = candidates[candidateIndex]!;
        candidateIndex += 1;
        if (current.kind !== semantic.kind) continue;
        const followingOffset =
          candidates[candidateIndex]?.offset ?? inline.content.length;
        const markup = inline.content.slice(current.offset, followingOffset);
        const normalizedMarkup = assetParser.utils.unescapeAll(markup);
        if (
          markup.includes(semantic.reference) ||
          markup.includes(safelyDecodeUri(semantic.reference)) ||
          normalizedMarkup.includes(semantic.reference) ||
          normalizedMarkup.includes(safelyDecodeUri(semantic.reference))
        ) {
          candidate = current;
          break;
        }
        if (
          current.referenceLabel !== undefined &&
          current.referenceLabel === semantic.referenceLabel
        ) {
          candidate = current;
          break;
        }
      }
      const offset = candidate?.offset ?? 0;
      const precedingInline = inline.content.slice(0, offset);
      const inlineLineOffset = precedingInline.match(/\n/gu)?.length ?? 0;
      const bodyLineIndex = inline.map[0] + inlineLineOffset;
      const inlineLineStart = precedingInline.lastIndexOf('\n') + 1;
      const markerOffsetInInlineLine = offset - inlineLineStart;
      const inlineLineEnd = inline.content.indexOf('\n', inlineLineStart);
      const inlineLine = inline.content.slice(
        inlineLineStart,
        inlineLineEnd < 0 ? undefined : inlineLineEnd,
      );
      const originalLine = bodyLines[bodyLineIndex] ?? '';
      const inlineColumn = Math.max(0, originalLine.indexOf(inlineLine));
      references.push({
        kind: semantic.kind,
        reference: semantic.reference,
        obsidian: semantic.obsidian,
        line: snapshot.bodyStartLine + bodyLineIndex,
        column: inlineColumn + markerOffsetInInlineLine + 1,
      });
    }
  }
  return references;
}

interface AssetMarkupCandidate {
  kind: 'image' | 'link';
  offset: number;
  referenceLabel?: string;
}

function flattenAssetTokens(tokens: Token[]): Array<{
  kind: 'image' | 'link';
  reference: string;
  obsidian: boolean;
  referenceLabel?: string;
}> {
  const references: Array<{
    kind: 'image' | 'link';
    reference: string;
    obsidian: boolean;
    referenceLabel?: string;
  }> = [];
  for (const token of tokens) {
    if (token.type === 'image' || token.type === 'link_open') {
      const kind = token.type === 'image' ? 'image' : 'link';
      const reference = token.attrGet(kind === 'image' ? 'src' : 'href');
      if (typeof reference === 'string' && reference) {
        references.push({
          kind,
          reference,
          obsidian: token.meta?.[obsidianAssetTokenMetadataKey] === true,
          ...(typeof token.meta?.label === 'string'
            ? { referenceLabel: token.meta.label }
            : {}),
        });
      }
    }
    if (token.children) references.push(...flattenAssetTokens(token.children));
  }
  return references;
}

function resolvesSnapshotNote(
  sourcePath: string,
  target: string,
  snapshots: Map<string, ArticleSourceSnapshot>,
): boolean {
  const withoutAnchor = target.split('#', 1)[0]?.trim();
  if (!withoutAnchor || withoutAnchor.includes('\\')) return false;
  const withoutLeadingSlash = withoutAnchor.replace(/^\/+/, '');
  const notePath = (
    withoutLeadingSlash.toLocaleLowerCase('en-US').endsWith('.md')
      ? withoutLeadingSlash
      : `${withoutLeadingSlash}.md`
  ).normalize('NFC');
  const exactCandidates = [
    notePath,
    posix.join(posix.dirname(sourcePath), notePath).normalize('NFC'),
  ];
  if (
    exactCandidates.some((candidate) =>
      [...snapshots.keys()].some(
        (snapshotPath) => snapshotPath.normalize('NFC') === candidate,
      ),
    )
  ) {
    return true;
  }
  const suffix = `/${notePath}`;
  return (
    [...snapshots.keys()].filter((snapshotPath) =>
      `/${snapshotPath.normalize('NFC')}`.endsWith(suffix),
    ).length === 1
  );
}

function findAssetMarkupCandidates(source: string): AssetMarkupCandidate[] {
  const candidates: AssetMarkupCandidate[] = [];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1;
      continue;
    }
    if (source[index] === '`') {
      let markerLength = 1;
      while (source[index + markerLength] === '`') markerLength += 1;
      const marker = '`'.repeat(markerLength);
      const closing = source.indexOf(marker, index + markerLength);
      if (closing >= 0) {
        index = closing + markerLength - 1;
        continue;
      }
    }
    if (source.startsWith('![[', index)) {
      candidates.push({ kind: 'image', offset: index });
      const end = source.indexOf(']]', index + 3);
      if (end >= 0) index = end + 1;
      continue;
    }
    if (source.startsWith('![', index)) {
      const markdownReference = markdownReferenceCandidate(source, index + 1);
      candidates.push({
        kind: 'image',
        offset: index,
        ...(markdownReference
          ? { referenceLabel: markdownReference.label }
          : {}),
      });
      index = markdownReference?.end ?? index + 1;
      continue;
    }
    if (source[index] === '<') {
      const end = source.indexOf('>', index + 1);
      if (
        end >= 0 &&
        /^<https?:\/\/[^<>\s]+>$/iu.test(source.slice(index, end + 1))
      ) {
        candidates.push({ kind: 'link', offset: index });
        index = end;
        continue;
      }
    }
    if (source[index] === '[') {
      const markdownReference = markdownReferenceCandidate(source, index);
      candidates.push({
        kind: 'link',
        offset: index,
        ...(markdownReference
          ? { referenceLabel: markdownReference.label }
          : {}),
      });
      if (markdownReference) index = markdownReference.end;
    }
  }
  return candidates;
}

function markdownReferenceCandidate(
  source: string,
  labelStart: number,
): { end: number; label: string } | undefined {
  const labelEnd = findUnescapedClosingBracket(source, labelStart + 1);
  if (labelEnd === undefined) return undefined;
  const inlineLabel = source.slice(labelStart + 1, labelEnd);
  let referenceStart = labelEnd + 1;
  while (source[referenceStart] === ' ' || source[referenceStart] === '\t') {
    referenceStart += 1;
  }
  if (source[referenceStart] === '(') return undefined;
  if (source[referenceStart] !== '[') {
    return {
      end: labelEnd,
      label: normalizeMarkdownReference(inlineLabel),
    };
  }
  const referenceEnd = findUnescapedClosingBracket(source, referenceStart + 1);
  if (referenceEnd === undefined) return undefined;
  const explicitLabel = source.slice(referenceStart + 1, referenceEnd);
  return {
    end: referenceEnd,
    label: normalizeMarkdownReference(explicitLabel || inlineLabel),
  };
}

function normalizeMarkdownReference(value: string): string {
  return assetParser.utils
    .unescapeAll(value)
    .trim()
    .replace(/\s+/gu, ' ')
    .toUpperCase();
}

function findUnescapedClosingBracket(
  source: string,
  start: number,
): number | undefined {
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === '\\') {
      index += 1;
      continue;
    }
    if (source[index] === '\n') return undefined;
    if (source[index] === ']') return index;
  }
  return undefined;
}

function safelyDecodeUri(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}

type LocalAssetPathResolution =
  | {
      status: 'resolved';
      sourcePath: string;
      vaultPath: string;
      device: bigint;
      inode: bigint;
      size: bigint;
    }
  | { status: 'missing' }
  | { status: 'ambiguous' }
  | { status: 'unsafe' }
  | { status: 'unreadable' };

async function resolveLocalAssetPath(
  canonicalVaultRoot: string,
  sourcePath: string,
  reference: string,
  options: {
    obsidian?: boolean;
    vaultFiles?: readonly string[];
    vaultIndexComplete?: boolean;
  } = {},
): Promise<LocalAssetPathResolution> {
  let decoded: string;
  try {
    decoded = decodeURI(reference);
  } catch {
    return { status: 'unsafe' };
  }
  if (!decoded || decoded.includes('\\') || decoded.includes('\0')) {
    return { status: 'unsafe' };
  }
  const withoutLeadingSlash = decoded.replace(/^\/+/, '');
  const candidates = options.obsidian
    ? [
        withoutLeadingSlash,
        posix.join(posix.dirname(sourcePath), withoutLeadingSlash),
      ]
    : [
        decoded.startsWith('/')
          ? withoutLeadingSlash
          : posix.join(posix.dirname(sourcePath), decoded),
      ];
  for (const vaultRelative of [...new Set(candidates)]) {
    const resolution = await resolveVaultRelativeAssetPath(
      canonicalVaultRoot,
      vaultRelative,
    );
    if (resolution.status !== 'missing') return resolution;
  }
  if (options.obsidian) {
    const normalizedTarget = withoutLeadingSlash.normalize('NFC');
    const suffix = `/${normalizedTarget}`;
    const matches = (options.vaultFiles ?? []).filter((vaultPath) => {
      const normalizedPath = vaultPath.normalize('NFC');
      return normalizedPath === normalizedTarget || normalizedPath.endsWith(suffix);
    });
    if (matches.length > 1) return { status: 'ambiguous' };
    if (options.vaultIndexComplete === false) return { status: 'ambiguous' };
    if (matches[0]) {
      return resolveVaultRelativeAssetPath(canonicalVaultRoot, matches[0]);
    }
  }
  return { status: 'missing' };
}

async function resolveVaultRelativeAssetPath(
  canonicalVaultRoot: string,
  vaultRelative: string,
): Promise<LocalAssetPathResolution> {
  const candidate = resolve(canonicalVaultRoot, ...vaultRelative.split('/'));
  if (outsideRoot(canonicalVaultRoot, candidate)) return { status: 'unsafe' };
  try {
    const candidateStatus = await lstat(candidate, { bigint: true });
    if (candidateStatus.isSymbolicLink()) return { status: 'unsafe' };
    if (!candidateStatus.isFile()) return { status: 'unreadable' };
    const canonicalCandidate = await realpath(candidate);
    if (outsideRoot(canonicalVaultRoot, canonicalCandidate)) {
      return { status: 'unsafe' };
    }
    return {
      status: 'resolved',
      sourcePath: canonicalCandidate,
      vaultPath: relative(canonicalVaultRoot, canonicalCandidate).split(sep).join('/'),
      device: candidateStatus.dev,
      inode: candidateStatus.ino,
      size: candidateStatus.size,
    };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { status: 'missing' }
      : { status: 'unreadable' };
  }
}

async function listVaultFiles(
  canonicalVaultRoot: string,
  signal?: AbortSignal,
): Promise<{ files: string[]; complete: boolean }> {
  const files: string[] = [];
  let entriesSeen = 0;
  let complete = true;
  const visit = async (directory: string): Promise<void> => {
    throwIfLocalAssetAborted(signal);
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      throwIfLocalAssetAborted(signal);
      entriesSeen += 1;
      if (entriesSeen > maximumVaultIndexEntries) {
        complete = false;
        return;
      }
      const absolutePath = resolve(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        if (!complete) return;
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(
          relative(canonicalVaultRoot, absolutePath).split(sep).join('/'),
        );
      }
    }
  };
  await visit(canonicalVaultRoot);
  files.sort((left, right) => left.localeCompare(right));
  return { files, complete };
}

async function readVerifiedAsset(
  resolution: Extract<LocalAssetPathResolution, { status: 'resolved' }>,
  fileSystem: LocalAssetFileSystemBoundary,
  signal?: AbortSignal,
): Promise<
  | { status: 'read'; content: Buffer }
  | { status: 'unsafe' }
  | { status: 'resource-limit' }
  | { status: 'unreadable' }
> {
  let handle: FileHandle | undefined;
  try {
    throwIfLocalAssetAborted(signal);
    handle = await fileSystem.openFile(
      resolution.sourcePath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    throwIfLocalAssetAborted(signal);
    const openedStatus = await handle.stat({ bigint: true });
    if (
      !openedStatus.isFile() ||
      openedStatus.dev !== resolution.device ||
      openedStatus.ino !== resolution.inode
    ) {
      return { status: 'unsafe' };
    }
    if (openedStatus.size > BigInt(maximumLocalAssetBytes)) {
      return { status: 'resource-limit' };
    }
    if (openedStatus.size !== resolution.size) return { status: 'unsafe' };
    throwIfLocalAssetAborted(signal);
    const content = Buffer.alloc(Number(resolution.size));
    let offset = 0;
    while (offset < content.length) {
      throwIfLocalAssetAborted(signal);
      const { bytesRead } = await handle.read(
        content,
        offset,
        Math.min(1024 * 1024, content.length - offset),
        offset,
      );
      if (bytesRead === 0) return { status: 'unreadable' };
      offset += bytesRead;
    }
    throwIfLocalAssetAborted(signal);
    const finalStatus = await handle.stat({ bigint: true });
    if (finalStatus.size > BigInt(maximumLocalAssetBytes)) {
      return { status: 'resource-limit' };
    }
    if (finalStatus.size !== resolution.size) return { status: 'unsafe' };
    return { status: 'read', content };
  } catch (error) {
    if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw error;
    }
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ELOOP' ? { status: 'unsafe' } : { status: 'unreadable' };
  } finally {
    await handle?.close();
  }
}

function throwIfLocalAssetAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Local asset scan aborted.');
  error.name = 'AbortError';
  throw error;
}

function outsideRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === '..' || pathFromRoot.startsWith(`..${sep}`);
}

function externalHttpUrl(reference: string): boolean {
  return /^https?:\/\//iu.test(reference);
}

function validExternalHttpUrl(reference: string): boolean {
  try {
    const url = new URL(reference);
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.hostname.length > 0
    );
  } catch {
    return false;
  }
}

function referenceKey(sourcePath: string, reference: string): string {
  return `${sourcePath}\0${reference}`;
}

function supportedImageFormat(
  sourcePath: string,
): { extension: string; contentType: string } | undefined {
  const extension = extname(sourcePath).toLowerCase();
  const contentTypes: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
  };
  const contentType = contentTypes[extension];
  return contentType ? { extension, contentType } : undefined;
}

function supportedImageReference(reference: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURI(reference);
  } catch {
    return false;
  }
  return supportedImageFormat(decoded) !== undefined;
}

function potentialLocalAttachmentLink(reference: string): boolean {
  if (reference.startsWith('#') || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(reference)) {
    return false;
  }
  const extension = extname(safelyDecodeUri(reference)).toLowerCase();
  return extension.length > 0 && extension !== '.md';
}

function matchesVaultGlob(vaultPath: string, pattern: string): boolean {
  return minimatch(vaultPath.normalize('NFC'), pattern.normalize('NFC'), {
    dot: true,
    nonegate: true,
  });
}

function svgHasActiveContent(content: Uint8Array): boolean {
  let source: string;
  try {
    source = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return true;
  }
  if (
    [...source].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 && codePoint !== 9 && codePoint !== 10 && codePoint !== 13;
    })
  ) {
    return true;
  }
  const withoutXmlDeclaration = source.replace(
    /^\uFEFF?\s*<\?xml\s[^?]*\?>/iu,
    '',
  );
  if (/<!\s*(?:DOCTYPE|ENTITY)\b|<\?/iu.test(withoutXmlDeclaration)) {
    return true;
  }
  if (
    /<\s*(?:[\w-]+:)?(?:script|style|foreignObject|iframe|object|embed|audio|video|animate|animateMotion|animateTransform|set)\b/iu.test(
      source,
    )
  ) {
    return true;
  }
  if (/\son[a-z][\w:.-]*\s*=/iu.test(source)) return true;
  if (/\sstyle\s*=/iu.test(source)) return true;
  if (/\sxml:base\s*=/iu.test(source)) return true;
  if (/@import\b|expression\s*\(|(?:javascript|vbscript|data)\s*:/iu.test(source)) {
    return true;
  }
  const resourceAttribute = /\s(?:href|xlink:href|src)\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/gisu;
  for (const match of source.matchAll(resourceAttribute)) {
    const value = (match[2] ?? match[3] ?? '').trim();
    if (value && !value.startsWith('#')) return true;
  }
  const cssUrl = /url\(\s*(["']?)(.*?)\1\s*\)/gisu;
  for (const match of source.matchAll(cssUrl)) {
    const value = (match[2] ?? '').trim();
    if (value && !value.startsWith('#')) return true;
  }
  return false;
}

async function contentMatchesImageFormat(
  content: Uint8Array,
  extension: string,
  signal: AbortSignal | undefined,
  decodeWebp: WebpDecoderBoundary,
): Promise<boolean> {
  const startsWith = (signature: readonly number[]): boolean =>
    signature.every((byte, index) => content[index] === byte);
  if (extension === '.png') {
    return (
      startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) &&
      validPngStructure(content)
    );
  }
  if (extension === '.jpg' || extension === '.jpeg') {
    return startsWith([0xff, 0xd8, 0xff]) && validJpegStructure(content);
  }
  if (extension === '.gif') {
    return (
      (startsWith([...Buffer.from('GIF87a')]) ||
        startsWith([...Buffer.from('GIF89a')])) &&
      validGifStructure(content)
    );
  }
  if (extension === '.webp') {
    return (
      startsWith([...Buffer.from('RIFF')]) &&
      content.length >= 12 &&
      Buffer.from(content.subarray(8, 12)).toString('ascii') === 'WEBP' &&
      (await validWebpStructure(content, signal, decodeWebp))
    );
  }
  if (extension === '.svg') {
    try {
      const source = new TextDecoder('utf-8', { fatal: true })
        .decode(content)
        .replace(/^\uFEFF/u, '')
        .trimStart()
        .replace(/^<\?xml\s[^?]*\?>\s*/iu, '')
        .replace(/^(?:<!--[\s\S]*?-->\s*)+/u, '');
      return /^<svg(?:\s|>)/iu.test(source);
    } catch {
      return false;
    }
  }
  return false;
}

function validPngStructure(content: Uint8Array): boolean {
  if (content.length < 45) return false;
  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  let offset = 8;
  let firstChunk = true;
  let hasImageData = false;
  while (offset + 12 <= content.length) {
    const length = view.getUint32(offset);
    const end = offset + 12 + length;
    if (end > content.length) return false;
    const type = Buffer.from(content.subarray(offset + 4, offset + 8)).toString(
      'ascii',
    );
    const expectedCrc = view.getUint32(offset + 8 + length);
    const actualCrc = crc32(content.subarray(offset + 4, offset + 8 + length));
    if (actualCrc !== expectedCrc) return false;
    if (firstChunk) {
      if (type !== 'IHDR' || length !== 13) return false;
      if (view.getUint32(offset + 8) === 0 || view.getUint32(offset + 12) === 0) {
        return false;
      }
      firstChunk = false;
    }
    if (type === 'IDAT') hasImageData = true;
    if (type === 'IEND') {
      return length === 0 && hasImageData && end === content.length;
    }
    offset = end;
  }
  return false;
}

function validJpegStructure(content: Uint8Array): boolean {
  if (content.length < 12 || content[0] !== 0xff || content[1] !== 0xd8) {
    return false;
  }
  let offset = 2;
  let hasFrame = false;
  while (offset < content.length) {
    while (content[offset] === 0xff) offset += 1;
    const marker = content[offset];
    offset += 1;
    if (marker === undefined || marker === 0x00) return false;
    if (marker === 0xd9) return hasFrame && offset === content.length;
    if (marker === 0xda) {
      if (offset + 2 > content.length) return false;
      const scanHeaderLength = (content[offset]! << 8) | content[offset + 1]!;
      if (scanHeaderLength < 6 || offset + scanHeaderLength >= content.length) {
        return false;
      }
      const scanStart = offset + scanHeaderLength;
      for (let index = scanStart; index + 1 < content.length; index += 1) {
        if (content[index] === 0xff && content[index + 1] === 0xd9) {
          return hasFrame && index > scanStart && index + 2 === content.length;
        }
      }
      return false;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > content.length) return false;
    const length = (content[offset]! << 8) | content[offset + 1]!;
    if (length < 2 || offset + length > content.length) return false;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      if (length < 8) return false;
      const height = (content[offset + 3]! << 8) | content[offset + 4]!;
      const width = (content[offset + 5]! << 8) | content[offset + 6]!;
      if (width === 0 || height === 0) return false;
      const components = content[offset + 7] ?? 0;
      if (components === 0 || length !== 8 + 3 * components) return false;
      hasFrame = true;
    }
    offset += length;
  }
  return false;
}

function validGifStructure(content: Uint8Array): boolean {
  if (content.length < 14) return false;
  const width = content[6]! | (content[7]! << 8);
  const height = content[8]! | (content[9]! << 8);
  if (width === 0 || height === 0) return false;
  let offset = 13;
  if ((content[10]! & 0x80) !== 0) {
    offset += 3 * 2 ** ((content[10]! & 0x07) + 1);
  }
  let hasImage = false;
  while (offset < content.length) {
    const marker = content[offset++];
    if (marker === 0x3b) return hasImage && offset === content.length;
    if (marker === 0x21) {
      offset += 1;
      offset = skipGifSubBlocks(content, offset);
      if (offset < 0) return false;
      continue;
    }
    if (marker !== 0x2c || offset + 9 > content.length) return false;
    hasImage = true;
    const packed = content[offset + 8]!;
    offset += 9;
    if ((packed & 0x80) !== 0) offset += 3 * 2 ** ((packed & 0x07) + 1);
    if (offset >= content.length) return false;
    offset += 1;
    offset = skipGifSubBlocks(content, offset);
    if (offset < 0) return false;
  }
  return false;
}

function skipGifSubBlocks(content: Uint8Array, start: number): number {
  let offset = start;
  while (offset < content.length) {
    const length = content[offset++]!;
    if (length === 0) return offset;
    offset += length;
    if (offset > content.length) return -1;
  }
  return -1;
}

interface WebpChunk {
  type: string;
  offset: number;
  payloadOffset: number;
  length: number;
  paddedEnd: number;
}

interface WebpDimensions {
  width: number;
  height: number;
}

const maximumDecodedWebpPixels = 25_000_000;
const maximumDecodedWebpFramePixels = 100_000_000;
const maximumDecodedWebpFrames = 1_000;

async function validWebpStructure(
  content: Uint8Array,
  signal: AbortSignal | undefined,
  decodeWebp: WebpDecoderBoundary,
): Promise<boolean> {
  throwIfLocalAssetAborted(signal);
  if (content.length < 20) return false;
  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  if (view.getUint32(4, true) + 8 !== content.length) return false;
  const chunks = parseWebpChunks(content, 12, content.length);
  if (!chunks) return false;
  const extendedChunks = chunks.filter((chunk) => chunk.type === 'VP8X');
  if (extendedChunks.length > 1) return false;
  const extended = extendedChunks[0];
  const extendedHeader = extended
    ? readWebpExtendedHeader(content, extended)
    : undefined;
  if (extended && (!extendedHeader || chunks[0] !== extended)) return false;

  const animationChunks = chunks.filter((chunk) => chunk.type === 'ANIM');
  const frames = chunks.filter((chunk) => chunk.type === 'ANMF');
  if (animationChunks.length > 0 || frames.length > 0) {
    if (
      !extendedHeader ||
      (extendedHeader.flags & 0x02) === 0 ||
      animationChunks.length !== 1 ||
      animationChunks[0]!.length !== 6 ||
      frames.length === 0 ||
      frames.length > maximumDecodedWebpFrames ||
      chunks.some((chunk) => chunk.type === 'VP8 ' || chunk.type === 'VP8L')
    ) {
      return false;
    }
    if (
      extendedHeader.width * extendedHeader.height > maximumDecodedWebpPixels
    ) {
      return false;
    }
    let decodedPixels = 0;
    for (const frame of frames) {
      throwIfLocalAssetAborted(signal);
      const frameDimensions = readAnimationFrameDimensions(content, frame);
      if (!frameDimensions) return false;
      const { x, y, width, height } = frameDimensions;
      if (
        x + width > extendedHeader.width ||
        y + height > extendedHeader.height ||
        width * height > maximumDecodedWebpPixels
      ) {
        return false;
      }
      decodedPixels += width * height;
      if (decodedPixels > maximumDecodedWebpFramePixels) return false;
      const frameChunks = parseWebpChunks(
        content,
        frame.payloadOffset + 16,
        frame.payloadOffset + frame.length,
      );
      if (!frameChunks || !validAnimationFrameChunks(frameChunks)) return false;
      const frameContainer = createWebpFrameContainer(
        content,
        frameChunks,
        width,
        height,
      );
      const decoded = await decodeWebp(frameContainer, signal);
      throwIfLocalAssetAborted(signal);
      if (!decoded || decoded.width !== width || decoded.height !== height) {
        return false;
      }
    }
    return true;
  }

  if (extendedHeader && (extendedHeader.flags & 0x02) !== 0) return false;
  const imageChunks = chunks.filter(
    (chunk) => chunk.type === 'VP8 ' || chunk.type === 'VP8L',
  );
  if (imageChunks.length !== 1) return false;
  if (!extendedHeader && chunks.length !== 1) return false;
  const imageDimensions = readWebpImageDimensions(content, imageChunks[0]!);
  if (!imageDimensions) return false;
  const expectedDimensions = extendedHeader ?? imageDimensions;
  if (
    expectedDimensions.width !== imageDimensions.width ||
    expectedDimensions.height !== imageDimensions.height ||
    expectedDimensions.width * expectedDimensions.height >
      maximumDecodedWebpPixels
  ) {
    return false;
  }
  throwIfLocalAssetAborted(signal);
  const decoded = await decodeWebp(content, signal);
  throwIfLocalAssetAborted(signal);
  return (
    decoded?.width === expectedDimensions.width &&
    decoded.height === expectedDimensions.height
  );
}

function parseWebpChunks(
  content: Uint8Array,
  start: number,
  boundary: number,
): WebpChunk[] | undefined {
  const view = new DataView(content.buffer, content.byteOffset, content.byteLength);
  const chunks: WebpChunk[] = [];
  let offset = start;
  while (offset + 8 <= boundary) {
    const type = Buffer.from(content.subarray(offset, offset + 4)).toString('ascii');
    const length = view.getUint32(offset + 4, true);
    const payloadOffset = offset + 8;
    const payloadEnd = payloadOffset + length;
    const paddedEnd = payloadEnd + (length % 2);
    if (paddedEnd > boundary) return undefined;
    if (length % 2 === 1 && content[payloadEnd] !== 0) return undefined;
    chunks.push({ type, offset, payloadOffset, length, paddedEnd });
    offset = paddedEnd;
  }
  return offset === boundary && chunks.length > 0 ? chunks : undefined;
}

function readWebpExtendedHeader(
  content: Uint8Array,
  chunk: WebpChunk,
): (WebpDimensions & { flags: number }) | undefined {
  if (chunk.length !== 10) return undefined;
  const offset = chunk.payloadOffset;
  const flags = content[offset]!;
  if (
    (flags & 0xc1) !== 0 ||
    content[offset + 1] !== 0 ||
    content[offset + 2] !== 0 ||
    content[offset + 3] !== 0
  ) {
    return undefined;
  }
  return {
    flags,
    width: readUint24(content, offset + 4) + 1,
    height: readUint24(content, offset + 7) + 1,
  };
}

function readAnimationFrameDimensions(
  content: Uint8Array,
  frame: WebpChunk,
): (WebpDimensions & { x: number; y: number }) | undefined {
  if (frame.length < 24) return undefined;
  const offset = frame.payloadOffset;
  if ((content[offset + 15]! & 0xfc) !== 0) return undefined;
  const dimensions = {
    x: readUint24(content, offset) * 2,
    y: readUint24(content, offset + 3) * 2,
    width: readUint24(content, offset + 6) + 1,
    height: readUint24(content, offset + 9) + 1,
  };
  return dimensions.width > 0 && dimensions.height > 0
    ? dimensions
    : undefined;
}

function validAnimationFrameChunks(chunks: readonly WebpChunk[]): boolean {
  if (chunks.length === 1) {
    return chunks[0]!.type === 'VP8 ' || chunks[0]!.type === 'VP8L';
  }
  return (
    chunks.length === 2 &&
    chunks[0]!.type === 'ALPH' &&
    chunks[1]!.type === 'VP8 '
  );
}

function createWebpFrameContainer(
  content: Uint8Array,
  chunks: readonly WebpChunk[],
  width: number,
  height: number,
): Uint8Array {
  const hasAlphaChunk = chunks[0]!.type === 'ALPH';
  const rawChunks = Buffer.concat(
    chunks.map((chunk) =>
      Buffer.from(content.subarray(chunk.offset, chunk.paddedEnd)),
    ),
  );
  let payload = rawChunks;
  if (hasAlphaChunk) {
    const extended = Buffer.alloc(18);
    extended.write('VP8X', 0, 'ascii');
    extended.writeUInt32LE(10, 4);
    extended[8] = 0x10;
    writeUint24(extended, 12, width - 1);
    writeUint24(extended, 15, height - 1);
    payload = Buffer.concat([extended, rawChunks]);
  }
  const container = Buffer.alloc(12 + payload.length);
  container.write('RIFF', 0, 'ascii');
  container.writeUInt32LE(container.length - 8, 4);
  container.write('WEBP', 8, 'ascii');
  payload.copy(container, 12);
  return container;
}

function readWebpImageDimensions(
  content: Uint8Array,
  chunk: WebpChunk,
): WebpDimensions | undefined {
  if (chunk.type === 'VP8 ') {
    const offset = chunk.payloadOffset;
    if (
      chunk.length < 10 ||
      (content[offset]! & 1) !== 0 ||
      content[offset + 3] !== 0x9d ||
      content[offset + 4] !== 0x01 ||
      content[offset + 5] !== 0x2a
    ) {
      return undefined;
    }
    const width =
      (content[offset + 6]! | (content[offset + 7]! << 8)) & 0x3fff;
    const height =
      (content[offset + 8]! | (content[offset + 9]! << 8)) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : undefined;
  }
  if (chunk.type !== 'VP8L' || chunk.length < 5) return undefined;
  const offset = chunk.payloadOffset;
  if (content[offset] !== 0x2f) return undefined;
  const dimensionsAndFlags =
    content[offset + 1]! |
    (content[offset + 2]! << 8) |
    (content[offset + 3]! << 16) |
    (content[offset + 4]! << 24);
  if ((dimensionsAndFlags >>> 29) !== 0) return undefined;
  return {
    width: (dimensionsAndFlags & 0x3fff) + 1,
    height: ((dimensionsAndFlags >>> 14) & 0x3fff) + 1,
  };
}

function readUint24(content: Uint8Array, offset: number): number {
  return (
    content[offset]! |
    (content[offset + 1]! << 8) |
    (content[offset + 2]! << 16)
  );
}

function writeUint24(content: Uint8Array, offset: number, value: number): void {
  content[offset] = value & 0xff;
  content[offset + 1] = (value >>> 8) & 0xff;
  content[offset + 2] = (value >>> 16) & 0xff;
}

function crc32(content: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of content) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
