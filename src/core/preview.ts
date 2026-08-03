import type { WebpDecoderBoundary } from '../content/webp-decoder';
import type {
  LocalPreview,
  SiteBuilder,
} from '../site-builder/site-builder';

export type {
  ArticleLocalPreview,
  LocalPreview,
  PreviewArticle,
  PreviewPage,
} from '../site-builder/site-builder';

export interface LocalPreviewFacadeOptions {
  siteBuilder: SiteBuilder;
  webpDecoder?: WebpDecoderBoundary;
  /** Production publication omits local-only review affordances. */
  renderMode?: 'local' | 'published';
}

/**
 * Stable upper facade for callers that do not own the application composition
 * root. Rendering is always delegated to the injected site builder; this
 * module intentionally contains no Markdown, HTML, theme, or Quartz logic.
 */
export function prepareLocalPreviewFromDirectory(
  vaultRoot: string,
  options: LocalPreviewFacadeOptions,
): Promise<LocalPreview> {
  return options.siteBuilder.build({
    vaultRoot,
    renderMode: options.renderMode ?? 'local',
    ...(options.webpDecoder === undefined
      ? {}
      : { webpDecoder: options.webpDecoder }),
  });
}
