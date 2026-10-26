import type { HTMLAttributes } from 'svelte/elements';

/** Visual treatment of an error state: a padded, boxed alert, or a flat block with no box or padding. */
export type ErrorStateVariant = 'default' | 'flat';

export type ErrorStateProps = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'title'> & {
  /** Primary heading text rendered as a heading element at the configured `headingLevel`. */
  title: string;
  /** Secondary descriptive text rendered as a paragraph below the title. */
  description: string;
  /** Optional technical detail, such as a fault code, rendered below the description. */
  detail?: string;
  /** Called when the retry button is activated. The retry button renders only when this is given. */
  onRetry?: () => void;
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
   * Visual treatment. `'default'` centres a boxed danger alert in padded space.
   * `'flat'` renders the same content as a start-aligned block with no box and
   * no padding of its own, for a page whose container already pads it. Either
   * way the error is announced as an alert.
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
  /** Optional technical detail, such as a fault code, rendered below the description. */
  detail?: string;
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
   * Visual treatment. `'default'` centres a boxed danger alert in padded space.
   * `'flat'` renders the same content as a start-aligned block with no box and
   * no padding of its own, for a page whose container already pads it. Either
   * way the error is announced as an alert.
   * @default 'default'
   */
  variant?: ErrorStateVariant;
  /** Additional class merged onto the `.cinder-error-state` root element. */
  class?: string;
}
