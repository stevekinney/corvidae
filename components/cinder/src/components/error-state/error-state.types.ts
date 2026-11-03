import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** Layout of an error state: the centred page layout with a tinted disc, or a flat block with no disc or padding. */
export type ErrorStateVariant = 'default' | 'flat';

/**
 * What kind of problem the state reports. `'danger'` is a failure (a red disc with a warning glyph,
 * announced as an alert); `'neutral'` is a state where nothing failed, such as a thing that no longer
 * exists (a neutral disc with a search glyph, not announced).
 */
export type ErrorStateTone = 'danger' | 'neutral';

export type ErrorStateProps = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'title'> & {
  /** Primary heading text rendered as a heading element at the configured `headingLevel`. */
  title: string;
  /** Secondary descriptive text rendered as a paragraph below the title. */
  description: string;
  /**
   * Optional technical detail, such as a fault code. It sits behind a disclosure labelled
   * `detailsLabel`, so the plain-words description stays the first thing a person reads.
   */
  detail?: string;
  /**
   * Label of the disclosure that holds `detail`.
   * @default "Show the error details"
   */
  detailsLabel?: string;
  /**
   * A line of progress under the description, such as "Retrying in 8 s (attempt 3 of 8)". It
   * renders in tabular figures and is not a live region, so a countdown never announces itself
   * every second.
   */
  retryStatus?: string;
  /**
   * What kind of problem this reports. `'danger'` is a failure and is announced as an alert;
   * `'neutral'` is a state where nothing failed, such as a missing page, and is a plain group.
   * @default 'danger'
   */
  tone?: ErrorStateTone;
  /** Called when the retry button is activated. The retry button renders only when this is given. It is the page's primary action. */
  onRetry?: () => void;
  /**
   * A second action rendered after the retry button, such as an "Open Health" link or a
   * "Back to chats" button. Give it the secondary or ghost button variant so the retry button
   * stays the only primary on the page.
   */
  secondaryAction?: Snippet;
  /**
   * Replaces the glyph in the disc. The default is a warning triangle for the `'danger'` tone and
   * a magnifying glass for `'neutral'`. Decorative, so it is hidden from assistive technology.
   */
  icon?: Snippet;
  /**
   * Label of the retry button.
   * @default "Try again"
   */
  retryLabel?: string;
  /**
   * Heading level for the title element.
   * @default 2
   */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /**
   * Layout. `'default'` is the centred page layout: a 48px tinted disc with a glyph, the title,
   * the description, the progress line, then the actions, centred in the region it fills.
   * `'flat'` renders the same text as a start-aligned block with no disc and no padding of its
   * own, for a card or tab whose container already pads it.
   * @default 'default'
   */
  variant?: ErrorStateVariant;
  /** Additional class merged onto the `.cinder-error-state` root element. */
  class?: string;
};

/**
 * Cinder-specific props for the ErrorState component, used by the schema generator.
 * Excludes the inherited HTML attribute surface that consumers can spread via `...rest`.
 */
export interface ErrorStateSchemaProps {
  /** Primary heading text rendered as a heading element at the configured `headingLevel`. */
  title: string;
  /** Secondary descriptive text rendered as a paragraph below the title. */
  description: string;
  /**
   * Optional technical detail, such as a fault code. It sits behind a disclosure labelled
   * `detailsLabel`, so the plain-words description stays the first thing a person reads.
   */
  detail?: string;
  /**
   * Label of the disclosure that holds `detail`.
   * @default "Show the error details"
   */
  detailsLabel?: string;
  /**
   * A line of progress under the description, such as "Retrying in 8 s (attempt 3 of 8)". It
   * renders in tabular figures and is not a live region, so a countdown never announces itself
   * every second.
   */
  retryStatus?: string;
  /**
   * What kind of problem this reports. `'danger'` is a failure and is announced as an alert;
   * `'neutral'` is a state where nothing failed, such as a missing page, and is a plain group.
   * @default 'danger'
   */
  tone?: ErrorStateTone;
  /**
   * Label of the retry button.
   * @default "Try again"
   */
  retryLabel?: string;
  /**
   * Heading level for the title element.
   * @default 2
   */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /**
   * Layout. `'default'` is the centred page layout: a 48px tinted disc with a glyph, the title,
   * the description, the progress line, then the actions, centred in the region it fills.
   * `'flat'` renders the same text as a start-aligned block with no disc and no padding of its
   * own, for a card or tab whose container already pads it.
   * @default 'default'
   */
  variant?: ErrorStateVariant;
  /** Additional class merged onto the `.cinder-error-state` root element. */
  class?: string;
}
