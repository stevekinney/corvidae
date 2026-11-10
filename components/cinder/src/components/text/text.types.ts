import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

import type { NonMetadataHTMLElementTagName } from '../../utilities/html-element-types.ts';

export type TextVariant = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'caption' | 'body';

/** Element tags valid for the `as` prop: visible, non-void content elements. */
export type TextElement = NonMetadataHTMLElementTagName;

type TextBaseProps = Omit<HTMLAttributes<HTMLElement>, 'children' | 'class'> & {
  /** Typography variant. Headings render `h1` to `h5`; `caption` and `body` render paragraphs. @default 'body' */
  variant?: TextVariant;
  /** Element tag that overrides the variant's default element. */
  as?: TextElement;
  /** Additional classes merged onto the root element. */
  class?: string;
  /**
   * Holds the text to this many lines, so a long reply keeps the shape of the page. A "Show all"
   * button appears under it only while the text is actually cut off, and opens the rest in place.
   */
  clamp?: number;
  /** Whether a clamped run is open to its full length. Bindable; ignored without `clamp`. @default false */
  expanded?: boolean;
  /**
   * Content that sits beside the "Show all" button on the line under a clamped run, separated from
   * it by a middle dot, such as a "Show raw payloads" link. Ignored without `clamp`.
   */
  actions?: Snippet;
  /** With `truncate="middle"`, how many characters at the end of the text stay visible. @default 4 */
  tailLength?: number;
};

/** The text to show: rich content, or a plain string that can be cut in the middle or at its end. */
type TextContentProps =
  | {
      /** Required text content. */
      children: Snippet;
      truncate?: undefined;
      text?: undefined;
    }
  | {
      /**
       * Cuts the text in the middle when it is too long for one line, so the end stays visible
       * ("payments-worker-eu-w…3a68"), for an identifier whose end tells one from another. Needs
       * `text`. The full text is a tooltip, reachable by keyboard and touch because the cut text takes focus, unless `title` is set.
       */
      truncate: 'middle';
      /** The plain text to cut in the middle. */
      text: string;
      children?: undefined;
    }
  | {
      /**
       * Keeps the text on one line and ends it with an ellipsis when it is too long, for a long value
       * in a narrow place: a name above its detail in a table row, an identifier in a list. The line
       * takes the typography of what holds it, so it reads as part of that text, and the full text is
       * its `title` unless `title` is set. Needs `text`.
       */
      truncate: 'end';
      /** The plain text to end with an ellipsis. */
      text: string;
      children?: undefined;
    };

export type TextProps = TextBaseProps & TextContentProps;

export interface TextSchemaProps {
  /** Typography variant. Headings render `h1` to `h5`; `caption` and `body` render paragraphs. @default "body" */
  variant?: TextVariant;
  /** Element tag that overrides the variant's default element. */
  as?: TextElement;
  /** Additional classes merged onto the root element. */
  class?: string;
  /** Holds the text to this many lines; a "Show all" button appears only while the text is cut off. */
  clamp?: number;
  /** Whether a clamped run is open to its full length. @default false */
  expanded?: boolean;
  /** Cuts the text in the middle, or ends it with an ellipsis, when it is too long for one line. Needs `text`. */
  truncate?: 'middle' | 'end';
  /** The plain text to cut with `truncate`. */
  text?: string;
  /** With `truncate="middle"`, how many characters at the end of the text stay visible. @default 4 */
  tailLength?: number;
}
