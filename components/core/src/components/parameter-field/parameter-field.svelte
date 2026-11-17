<script lang="ts" module>
  export type { ParameterFieldEditorState, ParameterFieldProps } from './parameter-field.types.ts';
</script>

<script lang="ts">
  import Badge from '@lostgradient/badge/components/badge/badge.svelte';
  import Grid from '@lostgradient/grid/components/grid/grid.svelte';
  import Tooltip from '../tooltip/tooltip.svelte';
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import type { ParameterFieldProps } from './parameter-field.types.ts';

  let {
    id,
    label,
    base,
    override = $bindable<number | undefined>(undefined),
    unit,
    onOverrideChange,
    unsaved = false,
    experimental = false,
    children,
    class: className,
  }: ParameterFieldProps = $props();

  const overridden = $derived(override !== undefined);
  const value = $derived(override ?? base);
  const labelId = $derived(`${id}-label`);
  const formattedBase = $derived(`${String(base)}${unit ? ` ${unit}` : ''}`);

  function setOverride(next: number): void {
    if (!Number.isFinite(next)) return;
    override = next;
    onOverrideChange?.(next);
  }

  function reset(): void {
    override = undefined;
    onOverrideChange?.(undefined);
  }
</script>

<div
  class={classNames('cinder-parameter-field', className)}
  data-cinder-overridden={overridden || undefined}
  data-cinder-unsaved={unsaved || undefined}
>
  <div class="cinder-parameter-field__header">
    <span id={labelId} class="cinder-parameter-field__label">{label}</span>
    <span class="cinder-parameter-field__badges">
      {#if unsaved}
        <Badge size="xs" variant="warning">Unsaved</Badge>
      {/if}
      {#if experimental}
        <Badge size="xs" variant="info">Experimental</Badge>
      {/if}
    </span>
  </div>

  <Grid
    columns="0.1875rem minmax(0, 1fr)"
    gap="var(--cinder-space-2)"
    class="cinder-parameter-field__body"
  >
    <span class="cinder-parameter-field__rail" aria-hidden="true"></span>
    <div class="cinder-parameter-field__editor" aria-labelledby={labelId}>
      {#if children}
        {@render children({ labelledBy: labelId, value, overridden, setOverride })}
      {:else}
        <output id={`${id}-value`} class="cinder-parameter-field__value" aria-labelledby={labelId}>
          {value}{#if unit}<span class="cinder-parameter-field__unit">{' '}{unit}</span>{/if}
        </output>
      {/if}
    </div>
  </Grid>

  {#if overridden}
    <Tooltip text={`Reset to default (${formattedBase})`}>
      <button type="button" class="cinder-parameter-field__reset" onclick={reset}>
        Reset to default
      </button>
    </Tooltip>
  {/if}
</div>
