<script lang="ts" module>
  /**
   * @cinder
   * @category domain
   * @status beta
   * @purpose One bordered group of compact approval rows under a heading such as "2 approvals waiting", for two or more approvals that wait together.
   * @tag approval
   * @tag group
   * @useWhen Two or more tool approvals wait on the same person at once, such as a batch an agent asked for in one turn.
   * @avoidWhen A single approval waits: draw one ApprovalCard in the `decision` layout on its own.
   * @related approval-card, grouped-list
   * @rationale Nearest alternative: GroupedList — a grouped list carries tone and no border, and its rows are GroupedListItems; an approval group is one bordered surface whose rows are ApprovalCards in the `row` layout, each answerable on its own.
   */
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
