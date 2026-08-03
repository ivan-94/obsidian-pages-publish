import { posix } from 'node:path';

/** Mirrors the pinned Quartz 5 `slugifyPath` behavior at the adapter boundary. */
export function quartzSlugRoute(route: string): string {
  if (route === '/') return '/';
  const trailingSlash = route.endsWith('/');
  const slug = route
    .replace(/^\//u, '')
    .replace(/\/$/u, '')
    .split('/')
    .map((segment) => segment
      .replace(/\s/gu, '-')
      .replace(/&/gu, '-and-')
      .replace(/%/gu, '-percent')
      .replace(/[?#]/gu, '')
      .replace(/[<>:"|*]/gu, '')
      .toLowerCase())
    .join('/');
  return `/${slug}${trailingSlash ? '/' : ''}`;
}

export function quartzRouteForContentPath(contentPath: string): string {
  const extensionless = contentPath.replace(/\.md$/u, '');
  const slugged = quartzSlugRoute(`/${extensionless}/`);
  if (['index', '_index'].includes(posix.basename(extensionless).toLowerCase())) {
    const parent = posix.dirname(slugged.replace(/\/$/u, ''));
    return parent === '/' ? '/' : `${parent}/`;
  }
  return slugged;
}
