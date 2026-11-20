import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** One block of rendered Markdown that a `markdownNode` override can replace. */
export type MarkdownNode = {
  /** What the block is: a fenced code block, a table or a Mermaid diagram. */
  kind: 'code-block' | 'table' | 'mermaid';
  /** The sanitized markup the renderer produced for the block. */
  html: string;
  /** The block's plain text, such as a code block's source. */
  text: string;
  /** The fence's language, when it names one. */
  language?: string | undefined;
  /** The block's position among the rendered document's nodes. */
  index: number;
};

/**
 * Replaces how one block renders. Call `renderDefault` with the node to draw the default markup
 * inside the override.
 */
export type MarkdownNodeOverride = Snippet<
  [node: MarkdownNode, renderDefault: Snippet<[MarkdownNode]>]
>;

/** Props for the Markdown component. */
export type MarkdownProps = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'children'> & {
  /** The Markdown source. Without `math` it renders at once in a browser; with `math` the raw text shows until the renderer has loaded, then the formatted result replaces it. */
  content: string;
  /** Custom class merged with `.cinder-markdown-content`. */
  class?: string;
  /** Replaces how each code block, table or Mermaid diagram renders. */
  markdownNode?: MarkdownNodeOverride | undefined;
  /** `false` renders each image as its alt text, so the content loads nothing. Default `true`. */
  images?: boolean | undefined;
  /** `false` renders each link as its text, so the content navigates nowhere. Default `true`. */
  links?: boolean | undefined;
  /**
   * `true` loads the math renderer lazily, so `$…$` and `$$…$$` render as KaTeX, and the formatted
   * result replaces the raw text after first paint. Default `false`: the Markdown renders
   * synchronously on first mount and dollar signs stay literal, so "$25–$100" is a price range.
   */
  math?: boolean | undefined;
};
