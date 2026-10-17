import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

export type TextVariant = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'caption' | 'body';

/**
 * Non-void element tags valid for the `as` prop. Void elements are excluded
 * because this primitive always renders a `children` snippet.
 */
export type TextElement = Exclude<
  keyof HTMLElementTagNameMap,
  | 'area'
  | 'base'
  | 'br'
  | 'col'
  | 'embed'
  | 'hr'
  | 'img'
  | 'input'
  | 'link'
  | 'meta'
  | 'param'
  | 'source'
  | 'track'
  | 'wbr'
>;

export type TextProps = Omit<HTMLAttributes<HTMLElement>, 'children' | 'class'> & {
  /** Typography variant. Headings render `h1` to `h5`; `caption` and `body` render paragraphs. @default 'body' */
  variant?: TextVariant;
  /** Element tag that overrides the variant's default element. */
  as?: TextElement;
  /** Additional classes merged onto the root element. */
  class?: string;
  /** Required text content. */
  children: Snippet;
};

export interface TextSchemaProps {
  /** Typography variant. Headings render `h1` to `h5`; `caption` and `body` render paragraphs. @default "body" */
  variant?: TextVariant;
  /** Element tag that overrides the variant's default element. */
  as?: TextElement;
  /** Additional classes merged onto the root element. */
  class?: string;
}
