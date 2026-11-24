<script lang="ts" module>
  export type {
    SelectGroup,
    SelectOption,
    SelectPresentation,
    SelectProps,
    SelectVariant,
  } from './select.types.ts';
</script>

<script lang="ts" generics="T extends string = string">
  import { SvelteSet } from 'svelte/reactivity';

  import type { SelectProps } from './select.types.ts';
  import { CONTROL_SIZE_NAMES } from '../../_internal/control-size-names.ts';
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
    flush = false,
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

  // Options may arrive in stages. Remember each concrete invalid value so a reactive parent does
  // not get the same diagnostic on every unrelated update, while a different invalid value still
  // identifies the value that needs correction.
  const warnedInvalidValues = new SvelteSet<T>();

  // `devWarn` is dead-code-eliminated from production builds (gated on DEV from
  // esm-env), so the previous `typeof window` guard was redundant for the prod path.
  // It runs inside this $effect, which is client-only, so SSR is not a concern here.
  // The effect remains because `options` can change reactively (e.g. async load).
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
    if (options.length === 0) {
      devWarn(
        '[cinder/Select] options is empty — pass at least one option, or ignore during async load.',
      );
    } else if (
      value !== undefined &&
      value !== '' &&
      !options.some((option) => option.value === value) &&
      !warnedInvalidValues.has(value)
    ) {
      warnedInvalidValues.add(value);
      devWarn(
        `[cinder/Select] value ${JSON.stringify(value)} does not match any option — pass a value from options or omit it.`,
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
          class="cinder-_input-frame cinder-select select-size-{CONTROL_SIZE_NAMES[
            size
          ]} select-variant-{variant}"
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
          class="cinder-_input-frame cinder-select select-size-{CONTROL_SIZE_NAMES[
            size
          ]} select-variant-{variant}"
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
  class={classNames('cinder-select-field', `select-variant-${variant}`, className)}
  data-cinder-tone={tone === 'default' ? undefined : tone}
  data-cinder-flush={flush && variant === 'ghost' ? '' : undefined}
  labelClass="cinder-select-field__label"
  descriptionClass="cinder-select-field__description"
  errorClass="cinder-select-field__error"
  descriptionId={field.ownDescriptionId}
  errorId={field.ownErrorId ?? stableLocalErrorId}
  control={selectControl}
/>
