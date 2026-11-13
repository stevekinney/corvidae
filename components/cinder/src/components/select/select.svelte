<script lang="ts" module>
  /**
   * @cinder
   * @category form
   * @status stable
   * @purpose Native select control with label, description, and error wiring for picking one value from a short fixed option list.
   * @tag form
   * @tag selection
   * @useWhen Picking one value from a short list where the native control's mobile behavior is desirable.
   * @useWhen Composing inside a form with built-in label and aria-describedby plumbing.
   * @avoidWhen Filtering a long list by typing — use combobox instead.
   * @avoidWhen Building a custom-styled menu trigger — use dropdown instead.
   * @related combobox, dropdown, radio-group
   */
  export type {
    SelectGroup,
    SelectOption,
    SelectPresentation,
    SelectProps,
    SelectVariant,
  } from './select.types.ts';
</script>

<script lang="ts" generics="T extends string = string">
  import type { SelectProps } from './select.types.ts';
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
  import FormFieldFrame from '../../_internal/form-field-frame.svelte';
  import SelectListbox from './select-listbox.svelte';

  let {
    id,
    value = $bindable(),
    options,
    label,
    labelVisible = true,
    description,
    error,
    required,
    disabled,
    size = 'md',
    variant = 'default',
    appearance,
    tone = 'default',
    presentation = 'native',
    placeholder,
    valuePrefix,
    leading,
    groups,
    footer,
    readonly = false,
    mutating = false,
    onValueChange,
    onValueChangeRequest,
    sheetBelow,
    name,
    onchange: consumerOnChange,
    onmousedown: consumerOnMouseDown,
    onkeydown: consumerOnKeyDown,
    class: className,
    'aria-describedby': consumerDescribedBy,
    'aria-invalid': consumerInvalid,
    ...rest
  }: SelectProps<T> = $props();

  const context = getFormFieldContext();
  // A select that changes something (`mutating`) under a stale `<StaleRegion>` is inert but still
  // focusable: it cannot be opened or changed, carries `aria-disabled`, and is described by the
  // region's reason. It returns by itself when the region stops being stale.
  const staleRegion = getStaleRegionContext();
  const staleInert = $derived(isStaleInert(staleRegion, mutating));
  const blocked = $derived(readonly || staleInert);
  // The density default (filled under comfortable density) reaches only the bordered select. A
  // ghost select has no fill at all and ignores `appearance`; an inline one is outlined unless
  // the caller asks for `filled`.
  const resolvedAppearance = $derived(
    variant === 'ghost'
      ? 'outlined'
      : (appearance ?? (variant === 'inline' ? 'outlined' : undefined)),
  );
  const field = $derived(
    resolveFieldControl({
      id,
      generatedId: id,
      context,
      hasDescription: !!description,
      hasError: !!error,
      localIdNamespace: 'select',
      consumerDescribedBy: mergeDescribedBy(
        consumerDescribedBy,
        staleInert ? staleRegion?.reasonId : undefined,
      ),
      consumerInvalid,
      required,
      disabled,
    }),
  );

  const stableLocalErrorId = $derived(
    context?.errorId === `${field.id}-error` ? `${field.id}-select-error` : `${field.id}-error`,
  );

  // `devWarn` is dead-code-eliminated from production builds (gated on DEV from
  // esm-env), so the previous `typeof window` guard was redundant for the prod path.
  // It runs inside this $effect, which is client-only, so SSR is not a concern here.
  // The effect remains because `options` can change reactively (e.g. async load),
  // and we only want to surface the diagnostic once the list is genuinely empty.
  // A native select has no `readonly`: block the picker from opening (pointer and keyboard)
  // and put the value back if anything still changes it. Tab and the other keys stay free.
  function blockWhenReadonly(event: MouseEvent & { currentTarget: HTMLSelectElement }): void {
    if (blocked) event.preventDefault();
    else (consumerOnMouseDown as ((event: MouseEvent) => void) | undefined)?.(event);
  }
  function blockKeyWhenReadonly(event: KeyboardEvent & { currentTarget: HTMLSelectElement }): void {
    if (blocked && event.key !== 'Tab') event.preventDefault();
    else (consumerOnKeyDown as ((event: KeyboardEvent) => void) | undefined)?.(event);
  }
  function handleNativeChange(event: Event & { currentTarget: HTMLSelectElement }): void {
    const element = event.currentTarget;
    // The request hook may refuse or replace the pick. The element is put back to what was
    // committed, so a refused choice never stays on screen.
    commitValue(
      element.value as T,
      onValueChangeRequest,
      (next) => {
        value = next;
        if (element.value !== next) element.value = next ?? '';
      },
      onValueChange,
      { value },
    );
    (consumerOnChange as ((event: Event) => void) | undefined)?.(event);
  }

  $effect(() => {
    if (presentation === 'listbox') return;
    if (options.length === 0) {
      devWarn(
        '[cinder/Select] options is empty — pass at least one option, or ignore during async load.',
      );
    } else if (value !== undefined && !options.some((option) => option.value === value)) {
      devWarn(
        '[cinder/Select] value does not match any option — pass a value from options or omit it.',
      );
    }
  });
</script>

{#snippet selectControl()}
  {#if presentation === 'listbox'}
    <SelectListbox
      {id}
      bind:value
      {options}
      {groups}
      {leading}
      {footer}
      {placeholder}
      {valuePrefix}
      {size}
      {variant}
      appearance={resolvedAppearance}
      disabled={field.disabled}
      readonly={blocked}
      aria-disabled={staleInert ? 'true' : undefined}
      required={field.required}
      name={name ?? undefined}
      describedBy={field.describedBy}
      invalid={field.ariaInvalid}
      labelledBy={label ? `${field.id}-label` : (context?.labelId ?? undefined)}
      {sheetBelow}
      {onValueChange}
      {onValueChangeRequest}
      {...rest as Record<string, unknown>}
    />
  {:else}
    <span class="cinder-select-field__control">
      {#if options.length === 0}
        <select
          {id}
          class="cinder-_input-frame cinder-select"
          data-cinder-size={size}
          data-cinder-variant={variant}
          data-cinder-appearance={resolvedAppearance}
          disabled={field.disabled}
          required={field.required}
          {name}
          aria-readonly={readonly || undefined}
          aria-disabled={staleInert ? 'true' : undefined}
          onmousedown={blockWhenReadonly}
          onkeydown={blockKeyWhenReadonly}
          data-cinder-empty="true"
          {...rest}
          aria-describedby={field.describedBy}
          aria-invalid={field.ariaInvalid}
        ></select>
      {:else}
        <select
          {id}
          class="cinder-_input-frame cinder-select"
          data-cinder-size={size}
          data-cinder-variant={variant}
          data-cinder-appearance={resolvedAppearance}
          disabled={field.disabled}
          required={field.required}
          {name}
          aria-readonly={readonly || undefined}
          aria-disabled={staleInert ? 'true' : undefined}
          onmousedown={blockWhenReadonly}
          onkeydown={blockKeyWhenReadonly}
          {value}
          onchange={handleNativeChange}
          {...rest}
          aria-describedby={field.describedBy}
          aria-invalid={field.ariaInvalid}
        >
          {#each options as option (option.value)}
            <option value={option.value} disabled={option.disabled}>{option.label}</option>
          {/each}
        </select>
      {/if}
      <span class="cinder-_field-chevron cinder-select-field__chevron" aria-hidden="true"></span>
    </span>
  {/if}
{/snippet}

<!-- FormFieldFrame keeps the error node mounted by default so the live region
     is registered before text is injected; freshly-mounted aria-live nodes
     are not reliably announced by NVDA/JAWS. -->
<FormFieldFrame
  id={field.id}
  {label}
  {labelVisible}
  {description}
  {error}
  required={field.required}
  disabled={field.disabled}
  class={classNames('cinder-select-field', className)}
  data-cinder-variant={variant}
  data-cinder-tone={tone === 'default' ? undefined : tone}
  labelClass="cinder-select-field__label"
  descriptionClass="cinder-select-field__description"
  errorClass="cinder-select-field__error"
  descriptionId={field.ownDescriptionId}
  errorId={field.ownErrorId ?? stableLocalErrorId}
  control={selectControl}
/>
