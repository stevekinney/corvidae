<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status beta
   * @purpose Group of quiet property rows for a detail page: a label, a value and an affordance, with each editable row becoming an editor on activation.
   * @tag properties
   * @tag detail
   * @tag inspector
   * @useWhen Showing the properties of one record on a detail page as a right rail on a desktop and a grouped section on a phone.
   * @useWhen Letting a person change a property in place instead of through a stack of always-editable fields.
   * @avoidWhen Showing read-only facts with no editing at all — use description-list.
   * @avoidWhen Editing many fields at once and saving them together — use a form with form-field.
   * @related inspector-row, description-list, grouped-list, setting-row
   * @rationale Nearest alternative: DescriptionList — an inspector's rows are editable on activation, and read-only rows are drawn distinctly from editable ones.
   */
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
