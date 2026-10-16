import { TOKEN_REGISTRY } from '@lostgradient/cinder';

/**
 * The custom properties a theme may set on the preview frame: the public `--cinder-*`
 * surface of the shipped token registry. The count is derived, never hardcoded, so the
 * registry stays the single source of truth.
 */
export const PUBLIC_THEME_PROPERTIES: ReadonlySet<string> = new Set(
  TOKEN_REGISTRY.entries.filter((entry) => entry.public).map((entry) => entry.cssProperty),
);
