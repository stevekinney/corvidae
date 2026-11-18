<script lang="ts" module>
  export type { InspectorProps } from './inspector.types.ts';
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';
  import type { InspectorProps } from './inspector.types.ts';

  let { header, children, class: className, ...rest }: InspectorProps = $props();

  const generatedId = $props.id();
  const headerId = $derived(`${generatedId}-header`);
</script>

<div
  {...rest}
  class={classNames('cinder-inspector', className)}
  role={header ? 'group' : undefined}
  aria-labelledby={header ? headerId : undefined}
>
  {#if header}
    <p id={headerId} class="cinder-inspector__header">{header}</p>
  {/if}
  <dl class="cinder-inspector__group">
    {#if children}{@render children()}{/if}
  </dl>
</div>
