import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** Props for the ApprovalGroup component. */
export type ApprovalGroupProps = Omit<HTMLAttributes<HTMLDivElement>, 'class'> & {
  /** Custom class merged with `.cinder-approval-group`. */
  class?: string;
  /**
   * The group's heading, which also names it, such as `2 approvals waiting`. Written at the top of
   * the one bordered surface the rows share.
   */
  heading: string;
  /** The heading's level, so the group slots into the page's outline. Default `3`. */
  headingLevel?: 2 | 3 | 4 | 5 | 6;
  /**
   * The rows: ApprovalCards in the `row` layout, each in an element of its own. They lose their own
   * border and stand one inset separator apart on the group's surface.
   */
  children: Snippet;
};
