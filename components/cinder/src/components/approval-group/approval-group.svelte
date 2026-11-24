<script lang="ts" module>
  export type { ApprovalGroupProps } from './approval-group.types.ts';
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';

  import type { ApprovalGroupProps } from './approval-group.types.ts';

  let {
    class: customClassName,
    heading,
    headingLevel = 3,
    children,
    ...rest
  }: ApprovalGroupProps = $props();

  const generatedId = $props.id();
  const headingId = $derived(`${generatedId}-heading`);
</script>

<!--
  One surface, one border: the heading, then each row one inset separator below the last. The rows
  are the host's (an ApprovalCard each), so the group names itself by its heading and adds no
  landmark of its own.
-->
<section
  {...rest}
  class={classNames('cinder-approval-group', customClassName)}
  aria-labelledby={headingId}
>
  <svelte:element this={`h${headingLevel}`} id={headingId} class="cinder-approval-group__heading">
    {heading}
  </svelte:element>
  <div class="cinder-approval-group__rows">
    {@render children()}
  </div>
</section>
