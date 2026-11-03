import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** Presentation mode for the access gate. */
export type AccessGateVariant = 'inline' | 'section';

/**
 * Layout of a denied `'section'` gate: `'inline'` is a compact, bordered card that replaces one
 * region while the rest of the page stays readable; `'page'` is the borderless full-page state,
 * centred in the region it fills, for a page with nothing readable.
 */
export type AccessGateLayout = 'inline' | 'page';

/** Props for the AccessGate component. */
export type AccessGateProps = Omit<
  HTMLAttributes<HTMLElement>,
  'aria-describedby' | 'aria-labelledby' | 'children' | 'class' | 'role'
> & {
  /** Whether the consumer-authorized action or section is available. */
  granted: boolean;
  /**
   * Presentation mode.
   * @default "inline"
   */
  variant?: AccessGateVariant;
  /** Human-readable explanation shown to users and wired to assistive technology. */
  reason: string;
  /** Named scope, permission, or policy requirement. A section gate shows it small and monospaced on its own line, as "requires <requirement>". */
  requirement?: string;
  /**
   * Heading of a denied `'section'` gate, in the person's words, such as "Your sign-in can't
   * open Hooks". Ignored by the inline variant.
   * @default "Section locked"
   */
  title?: string;
  /**
   * Heading level of the section title.
   * @default 3
   */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /**
   * Layout of a denied `'section'` gate. Ignored by the inline variant.
   * @default 'inline'
   */
  layout?: AccessGateLayout;
  /** Gated content. Rendered untouched when access is granted. */
  children?: Snippet;
  /**
   * Actions rendered under a denied `'section'` gate, such as "See your scopes" or "Back to
   * Home". Give them the secondary button variant: a gate has no primary action.
   */
  actions?: Snippet;
  /** Custom class merged with the denied-state wrapper or section placeholder. */
  class?: string;
};

/** Cinder-specific props for AccessGate, used by the schema generator. */
export interface AccessGateSchemaProps {
  /** Whether the consumer-authorized action or section is available. */
  granted: boolean;
  /**
   * Presentation mode.
   * @default "inline"
   */
  variant?: AccessGateVariant;
  /** Human-readable explanation shown to users and wired to assistive technology. */
  reason: string;
  /** Named scope, permission, or policy requirement. A section gate shows it small and monospaced on its own line, as "requires <requirement>". */
  requirement?: string;
  /**
   * Heading of a denied `'section'` gate, in the person's words, such as "Your sign-in can't
   * open Hooks". Ignored by the inline variant.
   * @default "Section locked"
   */
  title?: string;
  /**
   * Heading level of the section title.
   * @default 3
   */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6;
  /**
   * Layout of a denied `'section'` gate. Ignored by the inline variant.
   * @default 'inline'
   */
  layout?: AccessGateLayout;
  /** Gated content. Rendered untouched when access is granted. */
  children?: Snippet;
  /** Custom class merged with the denied-state wrapper or section placeholder. */
  class?: string;
}
