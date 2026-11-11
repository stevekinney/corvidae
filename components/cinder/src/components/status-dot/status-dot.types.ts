import type { HTMLAttributes } from 'svelte/elements';
import type { StatusDotWordLabel } from './status-dot.words.ts';

/**
 * Semantic status values understood by StatusDot.
 *
 * The string values are stamped onto the root as `data-cinder-status` and
 * drive color exclusively via CSS — there are no hard-coded color classes
 * on the component. The token mapping (e.g. `online` → `--cinder-status-success-solid`,
 * `danger` → `--cinder-status-danger-solid`) lives in `status-dot.css` so consumers can
 * theme without forking the component.
 *
 * - `success` maps to `--cinder-status-success-solid` (same hue as `online`).
 * - `info` maps to `--cinder-status-info-solid`, a solid blue dot (Running).
 * - `pending` is a hollow ring: a 1.5px ring in `--cinder-border-control` over a transparent fill.
 * - `accent` maps to `--cinder-accent-solid`.
 *
 * Exported so host components (e.g. `stacked-list-item.svelte`) can type
 * their own `status` prop against this union rather than restating it.
 */
export type StatusDotStatus =
  | 'online'
  | 'offline'
  | 'warning'
  | 'danger'
  | 'info'
  | 'pending'
  | 'neutral'
  | 'success'
  | 'accent';

export type StatusDotSize = 'sm' | 'md';

/**
 * How the visible word is coloured. `muted` (the default) leaves a success, neutral or pending word
 * muted so the dot carries the tone, as every status word on a list row does. `status` also paints
 * the word in its status's text colour, for a result sentence beside the dot, such as a green
 * "Found 3 tools" after a successful connection test.
 */
export type StatusDotWordTone = 'muted' | 'status';

/** Realtime connection states that StatusDot can render as a live-region preset. */
export type StatusDotConnectionState = 'connected' | 'connecting' | 'disconnected' | 'error';

/**
 * Props for StatusDot.
 *
 * The component manages the accessible name itself so the status is never
 * communicated by color alone (WCAG 1.4.1): the visible label text wins,
 * then a hidden but provided `label`, then the word derived from `status`
 * (a dot with only `status` renders that word). A consumer-supplied
 * `aria-label` always takes priority over the automatic fallback.
 */
export type StatusDotProps = Omit<HTMLAttributes<HTMLSpanElement>, 'class'> & {
  /** Semantic status. Drives color via `data-cinder-status`; defaults to a neutral dot or derives from `connectionState`. */
  status?: StatusDotStatus;
  /** A status word from the word-to-tone table, such as "Waiting on you" or "Failed". It sets both the tone and the visible word, so a page never picks its own tone; a qualifier after a comma ("Running, checking the result") rides along. An explicit `status` or `label` wins over what the word supplies. */
  word?: StatusDotWordLabel;
  /** Realtime connection preset. Sets status, default label, and live-region semantics. */
  connectionState?: StatusDotConnectionState;
  /** Human label. Rendered visibly when `labelVisible` is true; used as the accessible name either way. Defaults to a word derived from `status` (for example "Online"), so a bare StatusDot is a dot and a word, never a dot alone. */
  label?: string;
  /** Use role="status" with polite live-region attributes. Defaults true when connectionState is provided. */
  live?: boolean;
  /**
   * Whether to render the visible label.
   * @default true
   */
  labelVisible?: boolean;
  /** Dot size. Default `'md'`. */
  size?: StatusDotSize;
  /** How the visible word is coloured: `muted` (the default) leaves a success, neutral or pending word muted so the dot carries the tone; `status` paints it in the status's text colour, for a result sentence such as a green "Found 3 tools". Warning, danger and info words are always coloured. */
  wordTone?: StatusDotWordTone;
  /** Extra classes appended to the root element. */
  class?: string;
};

export interface StatusDotSchemaProps {
  /** Semantic status. Drives color via `data-cinder-status`; defaults to a neutral dot or derives from `connectionState`. `success` maps to `--cinder-status-success-solid`; `info` maps to `--cinder-status-info-solid`; `pending` is a hollow ring; `accent` maps to `--cinder-accent-solid`. */
  status?: StatusDotStatus;
  /** A status word from the word-to-tone table, such as "Waiting on you" or "Failed". It sets both the tone and the visible word, so a page never picks its own tone; a qualifier after a comma ("Running, checking the result") rides along. An explicit `status` or `label` wins over what the word supplies. */
  word?: StatusDotWordLabel;
  /** Realtime connection preset. Sets status, default label, and live-region semantics. */
  connectionState?: StatusDotConnectionState;
  /** Human label. Rendered visibly when `labelVisible` is true; used as the accessible name either way. Defaults to a word derived from `status` (for example "Online"), so a bare StatusDot is a dot and a word, never a dot alone. */
  label?: string;
  /**
   * Whether to render the visible label.
   * @default true
   */
  labelVisible?: boolean;
  /** Use role="status" with polite live-region attributes. Defaults true when connectionState is provided. */
  live?: boolean;
  /** Dot size. @default "md" */
  size?: StatusDotSize;
  /** How the visible word is coloured: `muted` (the default) leaves a success, neutral or pending word muted so the dot carries the tone; `status` paints it in the status's text colour, for a result sentence such as a green "Found 3 tools". Warning, danger and info words are always coloured. @default "muted" */
  wordTone?: StatusDotWordTone;
  /** Extra classes appended to the root element. */
  class?: string;
}
