<script lang="ts" module>
  /**
   * @cinder
   * @category layout
   * @status beta
   * @purpose Heading, optional description and action, and content, separated from neighbouring sections by space instead of a box.
   * @tag section
   * @tag heading
   * @tag layout
   * @useWhen Grouping content under a heading on a page or in a panel without drawing a boxed surface around it.
   * @useWhen Pairing a heading with an action such as "Add" or "See all" above a list.
   * @avoidWhen The content needs its own raised surface or an edge — use card.
   * @avoidWhen Introducing a whole page with eyebrow label and tabs — use section-heading.
   * @related grouped-list, section-heading, card
   * @rationale Nearest alternative: Card — Section draws no box; space separates it from the next section.
   */
  export type { SectionLevel, SectionProps } from './section.types.ts';
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';
  import type { SectionProps } from './section.types.ts';

  let {
    title,
    description,
    level = 2,
    actions,
    children,
    class: className,
    ...rest
  }: SectionProps = $props();

  const generatedId = $props.id();
  const headingId = `${generatedId}-heading`;
</script>

<section {...rest} class={classNames('cinder-section', className)} aria-labelledby={headingId}>
  <div class="cinder-section__header">
    <div class="cinder-section__heading">
      <svelte:element this={`h${level}`} id={headingId} class="cinder-section__title"
        >{title}</svelte:element
      >
      {#if description}
        <p class="cinder-section__description">{description}</p>
      {/if}
    </div>
    {#if actions}
      <div class="cinder-section__actions">{@render actions()}</div>
    {/if}
  </div>
  {#if children}
    <div class="cinder-section__content">{@render children()}</div>
  {/if}
</section>
