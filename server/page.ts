import type { Request } from 'express';

// Link previews need absolute URLs, but the deployment's address isn't known at build time.
// PUBLIC_URL wins (for a custom domain); Render sets RENDER_EXTERNAL_URL on its own.
export const siteOrigin = (req: Request) =>
  (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
// Makes the share tags' /-relative URLs (og:url, og:image, twitter:image) point at origin.
export const withSiteUrls = (html: string, origin: string) =>
  html.replace(/(<meta (?:property|name)="(?:og:url|og:image|twitter:image)" content=")\//g, `$1${origin}/`);
