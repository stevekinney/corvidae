<script lang="ts" module>
  export type { SectionLevel, SectionProps } from './section.types.ts';
</script>

<script lang="ts">
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
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
      <!-- A title steps down with its level below 2; a level-2 title carries no attribute. -->
      <svelte:element
        this={`h${level}`}
        id={headingId}
        class="cinder-section__title"
        data-level={level >= 3 ? level : undefined}>{title}</svelte:element
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
