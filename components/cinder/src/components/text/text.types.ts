import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

import type { NonMetadataHTMLElementTagName } from '../../utilities/html-element-types.ts';

export type TextVariant = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'caption' | 'body';

/** Element tags valid for the `as` prop: visible, non-void content elements. */
export type TextElement = NonMetadataHTMLElementTagName;

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
