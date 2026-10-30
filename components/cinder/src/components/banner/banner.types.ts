import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
/**
 * Visual + semantic variants for {@link Banner}.
 *
 * Note: `banner.svelte` uses `danger` (matching the semantic token
 * `--cinder-status-danger-solid`) where `alert.svelte` uses `error`. The divergence is
 * intentional and tracked in `banner.a11y.md`.
 */
export type BannerVariant = 'info' | 'success' | 'warning' | 'danger';
/**
 * Ready-made banner configurations for {@link Banner}. `'unreachable'` is the server or
 * connection is down: it uses the `warning` variant and the accessible name "Connection problem".
 */
export type BannerPreset = 'unreachable';
/**
 * Props for the page-level {@link Banner} component.
 *
 * Banner is distinct from `alert.svelte` (contextual card, `role="alert"`)
 * and the forthcoming `callout.svelte` (inline prose admonition). A banner
 * stretches full-width just inside the top of a layout and announces
 * site-wide conditions such as maintenance windows, trial expiry, or
 * cookie consent.
 *
 * `role` is `Omit`ted from the underlying `HTMLAttributes` because the
 * component enforces `role="region"`. Accepting a consumer-supplied role
 * would let callers silently turn the banner into `role="alert"`, which
 * defeats the landmark-based design (see `banner.a11y.md`).
 *
 * "Full-width" means the banner fills its parent container's inline size,
 * not the viewport. To bleed edge-to-edge, render the banner outside any
 * `max-inline-size` content column.
 */
export type BannerProps = Omit<HTMLAttributes<HTMLDivElement>, 'children' | 'class' | 'role'> & {
  /** Visual + semantic variant. Default `'info'`. @default "info" */
  variant?: BannerVariant;
  /** Whether the banner shows a dismiss (×) button. Default `true`. @default true */
  dismissible?: boolean;
  /** Called after the dismiss button is clicked. Use to persist state. */
  onDismiss?: () => void;
  /**
   * Applies a ready-made configuration. `'unreachable'` overrides `variant` with `'warning'` and
   * names the region "Connection problem" unless `aria-label` or `aria-labelledby` is passed.
   * Pair it with `onRetry` and `dataUpdatedAt`.
   */
  preset?: BannerPreset;
  /** Called when the Retry button is pressed. The button renders in the actions region, before `actions`, only when this is set. */
  onRetry?: () => void;
  /**
   * Label of the Retry button.
   * @default 'Retry'
   */
  retryLabel?: string;
  /**
   * When the data still on screen was last fetched. Adds a stale-data notice that reads
   * "Showing data from" followed by a live relative time such as "2 minutes ago".
   */
  dataUpdatedAt?: Date | string | number;
  /**
   * Text that precedes the relative time in the stale-data notice.
   * @default 'Showing data from'
   */
  staleDataLabel?: string;
  /** Banner body content. */
  children: Snippet;
  /** Optional trailing CTA region (e.g., "Renew now" button). */
  actions?: Snippet;
  /**
   * Extra classes appended to the root element. Pass via the explicit
   * `class` prop — it is excluded from rest-prop spread, so writing
   * `class="x"` inside spread attributes will not reach the root.
   */
  class?: string;
};
