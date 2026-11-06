import type { Snippet } from 'svelte';
export type FormSectionHeadingLevel = 2 | 3 | 4 | 5 | 6;
type FormSectionSharedProps = {
  /** Optional descriptive paragraph rendered under the heading/legend. */
  description?: string;
  /**
   * A short muted note beside the heading, on its baseline ("Read with every chat", "3 of 9").
   * It says what the section is for or how much is in it; a sentence of guidance is the
   * `description`.
   */
  meta?: string;
  /** Column ceiling. Container queries pick the actual rendered count. Default 2. */
  columns?: 1 | 2 | 3 | 4;
  /**
   * Draws the children as one bordered card, each child separated from the next by a divider, under
   * a larger heading and description. For a page of settings: the children are `SettingRow`s, and a
   * grouped section is always one column.
   */
  grouped?: boolean;
  /** Additional class merged with `.cinder-form-section`. */
  class?: string;
  /**
   * Children (FormField instances or arbitrary content). Optional: a section with none draws its
   * heading and description alone, for a list that is empty and says so in the page's own words.
   */
  children?: Snippet;
};
/**
 * Discriminated union: `as="fieldset"` requires `heading` (a legend-less fieldset
 * has no accessible group name). `as="section"` (default) treats heading as optional.
 * This makes the inaccessible state unrepresentable in TypeScript.
 */
export type FormSectionProps =
  | (FormSectionSharedProps & {
      /** Wrapper element. Default. */
      as?: 'section';
      /** Heading text rendered as `<h{level}>`. */
      heading?: string;
      /** Heading level. Default 2. */
      headingLevel?: FormSectionHeadingLevel;
    })
  | (FormSectionSharedProps & {
      /** Wrapper element. Use for grouped related inputs. */
      as: 'fieldset';
      /** Required heading — rendered as `<legend>`. */
      heading: string;
      /** Ignored for fieldset (legend is the only heading). */
      headingLevel?: never;
    });
