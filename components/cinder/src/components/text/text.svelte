<script lang="ts" module>
  /**
   * @cinder
   * @category typography
   * @status stable
   * @purpose Run of text in one of the typography variants h1 to h5, caption, or body that inherits its color from its container.
   * @tag typography
   * @tag text
   * @useWhen Rendering a heading, paragraph, or caption in the design system's type scale.
   * @useWhen Overriding the rendered element while keeping a variant's visual style.
   * @avoidWhen Introducing a page section with an eyebrow, description, or actions — use section-heading instead.
   * @avoidWhen Rendering Markdown content — compose the Markdown renderer instead.
   * @related section-heading, label
   */
  export type { TextElement, TextProps, TextVariant } from './text.types.ts';
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';

  import type { TextElement, TextProps, TextVariant } from './text.types.ts';

  let { variant = 'body', as, class: className, children, ...rest }: TextProps = $props();

  const defaultElements = {
    h1: 'h1',
    h2: 'h2',
    h3: 'h3',
    h4: 'h4',
    h5: 'h5',
    caption: 'p',
    body: 'p',
  } as const satisfies Record<TextVariant, TextElement>;

  const element = $derived(as ?? defaultElements[variant]);
</script>

<svelte:element
  this={element}
  {...rest}
  class={classNames('cinder-text', className)}
  data-cinder-variant={variant}
>
  {@render children()}
</svelte:element>
