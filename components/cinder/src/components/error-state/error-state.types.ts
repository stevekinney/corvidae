import type { HTMLAttributes } from 'svelte/elements';

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
  /** Additional class merged onto the `.cinder-error-state` root element. */
  class?: string;
}
