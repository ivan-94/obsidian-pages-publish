import type { PreviewAsset } from '../content/local-assets';
import type { WebpDecoderBoundary } from '../content/webp-decoder';
import type { PublicationVisibility } from '../publication/article-metadata';
import type { SiteRoutePlan } from '../routing/route-planner';

export interface PreviewPage {
  sourcePath: string;
  title: string;
  url: string;
}

/** Local-only article facts used by the publish center; never emitted to the site. */
export interface PreviewArticle {
  sourcePath: string;
  title: string;
  url?: string;
  onlineUrl?: string;
  visibility: PublicationVisibility;
  sourceDigest: string;
  /** Historical system facts retained even after a successful takedown. */
  firstPublishedAt?: string;
  lastPublishedAt?: string;
}

export interface LocalPreview {
  siteName: string;
  timeZone?: string;
  pages: PreviewPage[];
  articles: PreviewArticle[];
  files: Record<string, string>;
  assets: Record<string, PreviewAsset>;
  routePlan: SiteRoutePlan;
}

export interface ArticleLocalPreview extends LocalPreview {
  articlePath: string;
}

export interface SiteBuildRequest {
  vaultRoot: string;
  /** Production publication omits local-only review affordances. */
  renderMode: 'local' | 'published';
  webpDecoder?: WebpDecoderBoundary;
  /** Local article preview may stage one private note as unlisted without publishing it. */
  focusSourcePath?: string;
}

/**
 * Deep boundary for a complete static-site build. Application and deployment
 * code consume this contract without depending on a concrete rendering engine.
 */
export interface SiteBuilder {
  build(request: SiteBuildRequest): Promise<LocalPreview>;
}
