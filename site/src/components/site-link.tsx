import FumadocsLink from 'fumadocs-core/link';
import type { ComponentProps } from 'react';
import { withBasePath } from '@/lib/site-path';

type SiteLinkProps = ComponentProps<typeof FumadocsLink>;

/** Render authored site-root MDX links beneath Astro's deployment base. */
export function SiteLink({ href, ...props }: SiteLinkProps) {
  return <FumadocsLink href={href ? withBasePath(href) : href} {...props} />;
}
