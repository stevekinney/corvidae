import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';
import type { BannerPreset, BannerPresetFacts } from './banner-presets.ts';

/**
 * Visual + semantic variants for {@link Banner}.
 *
 * `neutral` is a plain notice that is not a problem and not a status, such as a setting the
 * person chose. Note: `banner.svelte` uses `danger` (matching the semantic token
 * `--cinder-status-danger-solid`) where `alert.svelte` uses `error`. The divergence is
 * intentional and tracked in `banner.a11y.md`.
 */
export type BannerVariant = 'neutral' | 'info' | 'success' | 'warning' | 'danger';
export type { BannerPreset } from './banner-presets.ts';
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
  /**
   * Whether the banner shows a dismiss (×) button. Default `true`. A banner with a `preset` is
   * never dismissible: the connection and restart states cannot be hidden.
   * @default true
   */
  dismissible?: boolean;
  /** Called after the dismiss button is clicked. Use to persist state. */
  onDismiss?: () => void;
  /**
   * Applies a ready-made configuration: the tone, the accessible name, the words, a glyph and the
   * actions of a connection or restart state (see {@link BannerPreset}). The preset overrides
   * `variant`, makes the banner non-dismissible and, when `children` is omitted, writes its copy
   * from `dataUpdatedAt`, `subject`, `retryInSeconds`, `attempt` and `consequence`. Passing
   * `children` replaces the generated words and keeps the rest.
   */
  preset?: BannerPreset;
  /**
   * Called when the Retry button is pressed. The button renders in the actions region, before
   * `actions`, only when this is set. A preset that retries (`offline`, `unreachable`, `stopped`,
   * `refresh-failed`, `reconnecting`) offers it only when this is set; `restarting`,
   * `restart-failed` and `back-online` never offer it.
   */
  onRetry?: () => void;
  /**
   * Label of the Retry button. A preset labels it "Retry now" unless this says otherwise.
   * @default 'Retry'
   */
  retryLabel?: string;
  /**
   * How prominent the Retry button is. A preset makes it `primary` where Retry now is the way back
   * (`stopped`) and `secondary` everywhere else, so one action at a time looks primary.
   */
  retryVariant?: 'primary' | 'secondary';
  /**
   * When the data still on screen was last loaded. With a `preset` and no `children` the copy names
   * it as an absolute time with its zone ("as of 10:44 AM CST"). Otherwise it adds a stale-data
   * notice that reads "Showing data from" followed by a live relative time such as "2 minutes ago".
   */
  dataUpdatedAt?: Date | string | number;
  /**
   * Text that precedes the relative time in the stale-data notice.
   * @default 'Showing data from'
   */
  staleDataLabel?: string;
  /**
   * What the page is showing, completing the preset's "Showing … as of …" sentence.
   * @default 'what loaded'
   */
  subject?: BannerPresetFacts['subject'];
  /** Seconds until the next automatic retry. A preset writes "Retrying in 4 s". */
  retryInSeconds?: BannerPresetFacts['retryInSeconds'];
  /** The attempt under way, counted from 1. A preset writes "(attempt 3 of 8)". */
  attempt?: BannerPresetFacts['attempt'];
  /**
   * How many attempts there are.
   * @default 8
   */
  maxAttempts?: BannerPresetFacts['maxAttempts'];
  /**
   * The sentence that says what is off while the banner shows, replacing the preset's own. Pass
   * `false` to leave the sentence out.
   */
  consequence?: BannerPresetFacts['consequence'];
  /** IANA time zone of the preset's "as of" time. Defaults to the viewer's zone. */
  timeZone?: BannerPresetFacts['timeZone'];
  /**
   * A bold lead for the banner, such as "1 change waits for a restart". With a `preset` it
   * replaces the preset's lead and sits inline before the words; otherwise it sits on its own line
   * above them.
   */
  title?: string;
  /**
   * Where the title sits. A preset runs it inline, as the first words of its sentence; a banner
   * without a preset puts it on its own line above the message.
   */
  titleLayout?: 'inline' | 'stacked';
  /**
   * A glyph at the start of the banner, drawn decoratively (`aria-hidden`). The `offline`,
   * `unreachable` and `stopped` presets supply their own connection glyph, and a `success` banner
   * leads with a check-circle unless this draws another.
   */
  icon?: Snippet;
  /** Keeps the banner at the top of its scroll container while the page scrolls under it. */
  sticky?: boolean;
  /**
   * Below 640px, puts the actions on a row of their own under the words, one above the next, each
   * a full-width 44px button. A phone's restart notice does this, so its buttons are targets
   * wide enough to press; without it the actions stay at the right of their line, at 44px.
   * @default false
   */
  stackActions?: boolean;
  /** Called when the `restart-failed` preset's primary action, "Restart again", is pressed. */
  onRestart?: () => void;
  /** Called when the `restart-failed` preset's secondary action, "Open Health", is pressed. */
  onOpenHealth?: () => void;
  /** Makes "Open Health" a link to this address instead of a button. */
  healthHref?: string;
  /** Banner body content. Optional with a `preset`, which writes its own words. */
  children?: Snippet;
  /** Optional trailing CTA region (e.g., "Renew now" button). */
  actions?: Snippet;
  /**
   * Extra classes appended to the root element. Pass via the explicit
   * `class` prop — it is excluded from rest-prop spread, so writing
   * `class="x"` inside spread attributes will not reach the root.
   */
  class?: string;
};
