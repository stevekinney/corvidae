import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** Heading level of a section's title, from `h2` to `h6`. */
export type SectionLevel = 2 | 3 | 4 | 5 | 6;

/** Props for the Section component. */
export type SectionProps = Omit<HTMLAttributes<HTMLElement>, 'class' | 'children' | 'title'> & {
  /** The section's heading text. */
  title: string;
  /** Supporting line under the heading, in muted text. */
  description?: string;
  /**
   * Heading level of the title. Pick the level that fits the page outline.
   * @default 2
   */
  level?: SectionLevel;
  /** Controls aligned with the heading, such as an "Add" or "See all" button. They never make the header taller than its title. */
  actions?: Snippet;
  /** The section's content. Children never shrink inside a flex or scroll parent. */
  children?: Snippet;
  /** Custom class merged with `.cinder-section`. */
  class?: string;
};
