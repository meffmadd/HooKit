/**
 * Prefix one site-root URL with an explicit deployment base. Relative,
 * hash-only, and external URLs are already context-safe and pass through
 * unchanged. Already-prefixed URLs are idempotent.
 */
export function withBasePathFor(baseUrl: string, href: string): string {
  const basePath = baseUrl.replace(/\/$/, '');

  if (!basePath || !href.startsWith('/') || href.startsWith('//')) return href;
  if (
    href === basePath ||
    href.startsWith(`${basePath}/`) ||
    href.startsWith(`${basePath}#`) ||
    href.startsWith(`${basePath}?`)
  ) {
    return href;
  }

  return `${basePath}${href}`;
}

/** Prefix one site-root URL with Astro's configured deployment base. */
export function withBasePath(href: string): string {
  return withBasePathFor(import.meta.env.BASE_URL, href);
}
