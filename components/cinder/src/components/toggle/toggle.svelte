<script lang="ts" module>
  /**
   * @cinder
   * @category form
   * @status stable
   * @purpose Sliding switch implementing the WAI-ARIA switch pattern for a single on or off setting that applies immediately.
   * @tag form
   * @tag switch
   * @useWhen Flipping a single setting on or off with immediate effect such as notifications or dark mode.
   * @avoidWhen Picking one option from a small fixed set — use segmented-control instead.
   * @avoidWhen Collecting a deferred boolean (agreement, opt-in) in a Submit-style form — a switch implies immediate effect; use checkbox instead.
   * @related checkbox, segmented-control
   */
  export type { ToggleProps } from './toggle.types.ts';
</script>

<script lang="ts">
  import type { ToggleProps } from './toggle.types.ts';
  import { getFormFieldContext } from '../../_internal/form-field-context.ts';
  import {
    getStaleRegionContext,
    isStaleInert,
    mergeDescribedBy,
  } from '../../_internal/stale-region-context.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { commitValue } from '../../utilities/value-change.ts';

  let {
    id,
    checked = $bindable(false),
    onValueChangeRequest,
    onValueChange,
    label,
    disabled,
    readonly = false,
    description,
    mutating = false,
    labelVisible = true,
    standalone = false,
    labelPosition = 'end',
    name,
    value = 'on',
    form,
    class: customClassName,
  }: ToggleProps = $props();

  // A switch implies an immediate-effect setting, so Toggle deliberately does
  // NOT take on `required`/`error` validation semantics — a deferred boolean in
  // a submit form should use Checkbox instead (see the module docstring). It
  // does, however, inherit `disabled` from a wrapping FormField so a disabled
  // field group greys out the switch alongside its peers.
  // A standalone switch is its own field: it is named and labelled by its own label even inside a
  // `<FormField>`, so it is one of several switches in a field rather than the field's one control.
  const fieldContext = getFormFieldContext();
  const context = $derived(standalone ? undefined : fieldContext);
  const generatedId = $props.id();
  const resolvedDisabled = $derived(disabled ?? context?.disabled ?? false);

  const ownLabelId = $derived(label ? `${id ?? generatedId}-label` : undefined);
  const labelId = $derived(context?.labelId ?? ownLabelId);
  const descriptionId = $derived(description ? `${id ?? generatedId}-description` : undefined);
  const resolvedId = $derived(context?.controlId ?? id);

  // A switch that changes something (`mutating`) under a stale `<StaleRegion>` is inert but still
  // focusable: `aria-disabled` (not the native `disabled`), described by the region's reason, and
  // it ignores a press on the track or on its label.
  const staleRegion = getStaleRegionContext();
  const staleInert = $derived(isStaleInert(staleRegion, mutating));
  const describedBy = $derived(
    mergeDescribedBy(
      mergeDescribedBy(context?.describedBy, descriptionId),
      staleInert ? staleRegion?.reasonId : undefined,
    ),
  );

  // A read-only switch keeps its place in the tab order and its value in the form, but a press
  // changes nothing: it shows a setting that something else owns.
  function toggle(): void {
    if (!resolvedDisabled && !staleInert && !readonly) {
      commitValue(
        !checked,
        onValueChangeRequest,
        (next) => {
          checked = next;
        },
        onValueChange,
      );
    }
  }
</script>

{#snippet control()}
  <button
    id={resolvedId}
    type="button"
    role="switch"
    aria-checked={checked}
    aria-labelledby={labelId}
    aria-describedby={describedBy}
    aria-readonly={readonly ? 'true' : undefined}
    disabled={resolvedDisabled}
    aria-disabled={staleInert ? 'true' : undefined}
    onclick={toggle}
    class={classNames('cinder-toggle', customClassName)}
    data-cinder-checked={checked ? '' : undefined}
    data-cinder-readonly={readonly ? '' : undefined}
  >
    <span aria-hidden="true" class="cinder-toggle__thumb"></span>
  </button>
  {#if name}
    <!--
      Form participation: a `hidden` checkbox mirrors `checked` so the toggle
      submits with a native form. The <button role="switch"> stays the only thing
      users tab to or operate. We use the `hidden` attribute (display:none) rather
      than a visually-hidden + aria-hidden + tabindex="-1" input: a display:none
      control is genuinely non-focusable and out of the accessibility tree, so it
      avoids the aria-hidden-focus WCAG violation (aria-hidden on a still-focusable
      element). `hidden` form controls STILL submit when named, checked, and not
      disabled — only `disabled` excludes a control from the form data set.
      Rendered only when `name` is set, so a client-side-only toggle pays nothing.
    -->
    <input type="checkbox" hidden {name} {value} {form} disabled={resolvedDisabled} bind:checked />
  {/if}
{/snippet}

{#snippet descriptionText()}
  {#if description}
    <span id={descriptionId} class="cinder-toggle-field__description">{description}</span>
  {/if}
{/snippet}

{#snippet fieldLabel()}
  <span
    id={labelId}
    class="cinder-toggle-field__label"
    role="presentation"
    data-hidden={!labelVisible || undefined}
    data-disabled={resolvedDisabled || staleInert || undefined}
    onclick={toggle}
  >
    {label}
  </span>
{/snippet}

{#if context}
  {#if label && !context.labelId}
    <span class="cinder-toggle-field">
      {@render control()}
      <span
        id={ownLabelId}
        class="cinder-toggle-field__label"
        role="presentation"
        data-hidden={!labelVisible || undefined}
        data-disabled={resolvedDisabled || staleInert || undefined}
        onclick={toggle}>{label}</span
      >
      {@render descriptionText()}
    </span>
  {:else}
    {@render control()}
    {@render descriptionText()}
  {/if}
{:else}
  <span class="cinder-toggle-field" data-label-position={labelPosition}>
    {#if labelPosition === 'start'}
      {@render fieldLabel()}
      {@render control()}
    {:else}
      {@render control()}
      {@render fieldLabel()}
    {/if}
    {@render descriptionText()}
  </span>
{/if}
