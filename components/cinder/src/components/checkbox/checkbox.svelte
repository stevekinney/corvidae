<script lang="ts" module>
  /**
   * @cinder
   * @category form
   * @status stable
   * @purpose Binary or tri-state selection control with bindable checked and indeterminate state for forms and lists.
   * @tag form
   * @tag selection
   * @useWhen Selecting zero or more independent options from a list.
   * @useWhen Representing a parent state that aggregates child selections via indeterminate.
   * @avoidWhen Flipping a single setting on or off with immediate effect — use toggle instead.
   * @avoidWhen Picking exactly one option from a small fixed set — use RadioGroup or segmented-control instead.
   * @related checkbox-group, radio-group, toggle, segmented-control
   */
  export type { CheckboxProps } from './checkbox.types.ts';
</script>

<script lang="ts">
  import type { CheckboxProps } from './checkbox.types.ts';
  import CheckboxIndicatorShell from '../_internal/checkbox-indicator-shell.svelte';
  import { resolveFieldControl } from '../../_internal/field-control.ts';
  import { getFormFieldContext } from '../../_internal/form-field-context.ts';
  import {
    getStaleRegionContext,
    isStaleInert,
    mergeDescribedBy,
  } from '../../_internal/stale-region-context.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { devWarn } from '../../utilities/dev-warn.ts';
  import { commitValue } from '../../utilities/value-change.ts';
  import { default as FormField } from '../form-field/index.ts';
  import FormFieldFrame from '../../_internal/form-field-frame.svelte';

  let {
    id,
    checked = $bindable(false),
    onValueChangeRequest,
    onValueChange,
    indeterminate = $bindable(false),
    label,
    description,
    error,
    disabled,
    mutating = false,
    variant = 'default',
    required,
    class: className,
    'aria-describedby': consumerDescribedBy,
    'aria-invalid': consumerInvalid,
    onchange: consumerOnchange,
    ...rest
  }: CheckboxProps = $props();

  // Stable generated id fallback (Svelte 5 $props.id()), used when neither the `id`
  // prop nor a FormField context controlId is present — matches input/autocomplete.
  // Passing the (possibly undefined) `id` prop as the fallback would leave field.id
  // undefined for an unlabeled standalone checkbox, breaking for=/id=/describedby.
  const generatedId = $props.id();
  const context = getFormFieldContext();
  // A checkbox that changes something (`mutating`) under a stale `<StaleRegion>` is inert but
  // still focusable: `aria-disabled`, described by the region's reason, and a toggle is undone.
  const staleRegion = getStaleRegionContext();
  const staleInert = $derived(isStaleInert(staleRegion, mutating));
  const field = $derived(
    resolveFieldControl({
      // Conditionally spread `id` so `id: undefined` isn't passed (exactOptionalPropertyTypes);
      // matches autocomplete. The generatedId fallback covers the no-id case.
      ...(id !== undefined ? { id } : {}),
      generatedId,
      context,
      hasDescription: !!description,
      hasError: !!error,
      localIdNamespace: 'checkbox',
      consumerDescribedBy: mergeDescribedBy(
        consumerDescribedBy,
        staleInert ? staleRegion?.reasonId : undefined,
      ),
      consumerInvalid,
      disabled,
      // HTMLInputAttributes types `required` as boolean | null | undefined; the helper
      // wants boolean | undefined, so coerce a null to undefined (keeps false/true).
      required: required ?? undefined,
    }),
  );
  const renderInlineLabel = $derived(!!label && (!context || !context.labelId));
  const fieldClass = $derived(
    classNames('cinder-checkbox-field', variant === 'task' && 'cinder-checkbox-field--task'),
  );

  // Dev-mode guard (matches Input/Autocomplete): inside a FormField, a consumer `id`
  // that disagrees with the FormField's controlId means the FormField's <label for>
  // points at a different id than this input renders, breaking the label association.
  $effect(() => {
    if (context && id && context.controlId !== id) {
      devWarn(
        `[cinder/Checkbox] id mismatch: Checkbox id="${id}" but wrapping FormField expects controlId="${context.controlId}". Set the same id on both, or omit id on the Checkbox to inherit it.`,
      );
    }
  });

  // `indeterminate` is a DOM property, not an attribute. Sync it whenever
  // either the prop or the bound element changes. Toggling `checked` clears
  // indeterminate to match native behavior.
  let inputElement: HTMLInputElement | undefined = $state();
  $effect(() => {
    if (inputElement) {
      inputElement.indeterminate = indeterminate && !checked;
    }
  });
  let resetSyncTimeout: ReturnType<typeof setTimeout> | undefined;

  function syncCheckedAfterFormReset(): void {
    if (resetSyncTimeout !== undefined) clearTimeout(resetSyncTimeout);
    resetSyncTimeout = setTimeout(() => {
      resetSyncTimeout = undefined;
      if (!inputElement) return;
      checked = inputElement.checked;
      inputElement.indeterminate = indeterminate && !inputElement.checked;
    }, 0);
  }

  $effect(() => {
    const form = inputElement?.form;
    if (!form) return;

    form.addEventListener('reset', syncCheckedAfterFormReset);
    return () => {
      form.removeEventListener('reset', syncCheckedAfterFormReset);
      if (resetSyncTimeout !== undefined) {
        clearTimeout(resetSyncTimeout);
        resetSyncTimeout = undefined;
      }
    };
  });

  // The row pads the box out to the hit area (24px, 44px under a coarse pointer) without changing
  // its painted size. A press on that padding lands on the row, not the input, so it is passed on:
  // the input stays the one keyboard and assistive-technology target, and a press on the box itself
  // is the browser's own (its target is the input, not the row).
  function forwardRowPress(event: MouseEvent): void {
    if (event.target === event.currentTarget && inputElement && !inputElement.disabled) {
      inputElement.click();
    }
  }

  function handleChange(event: Event & { currentTarget: EventTarget & HTMLInputElement }): void {
    const target = event.currentTarget;
    if (staleInert) {
      // The press is ignored: put the native state back and report nothing.
      target.checked = checked;
      target.indeterminate = indeterminate && !checked;
      return;
    }
    const rawChecked = target.checked;
    // Forward the raw native event before Cinder's veto/commit machinery runs, so
    // consumers observe the browser's actual value rather than a post-veto value
    // that may have already been reverted on the DOM.
    consumerOnchange?.(event);
    const committed = commitValue(
      rawChecked,
      onValueChangeRequest,
      (next) => {
        checked = next;
      },
      onValueChange,
    );
    target.checked = committed;
    target.indeterminate = indeterminate && !committed;
  }
</script>

{#snippet control()}
  <!-- The input inside is the keyboard and assistive-technology target; the row only extends where a pointer press lands. -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class={classNames('cinder-checkbox-row', variant === 'task' && 'cinder-checkbox-row--task')}
    onclick={forwardRowPress}
  >
    <CheckboxIndicatorShell>
      {#snippet control()}
        <input
          bind:this={inputElement}
          id={field.id}
          type="checkbox"
          {...rest}
          disabled={field.disabled}
          required={field.required}
          {checked}
          onchange={handleChange}
          class={classNames(
            'cinder-checkbox',
            variant === 'task' && 'cinder-checkbox--task',
            className,
          )}
          aria-invalid={field.ariaInvalid}
          aria-describedby={field.describedBy}
          aria-disabled={staleInert ? 'true' : undefined}
        />
      {/snippet}
    </CheckboxIndicatorShell>
  </div>
{/snippet}

{#if context}
  {#if renderInlineLabel || description || error}
    <FormFieldFrame
      id={field.id}
      label={renderInlineLabel ? label : undefined}
      {description}
      {error}
      descriptionId={field.ownDescriptionId}
      errorId={field.ownErrorId}
      required={field.required}
      disabled={field.disabled}
      class={fieldClass}
      {control}
    ></FormFieldFrame>
  {:else}
    {@render control()}
  {/if}
{:else}
  <FormField
    id={field.id}
    {label}
    {description}
    {error}
    required={field.required}
    disabled={field.disabled}
    class={fieldClass}
  >
    {@render control()}
  </FormField>
{/if}
