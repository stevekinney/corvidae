<script lang="ts" module>
  /**
   * @cinder
   * @category form
   * @status beta
   * @purpose Settings-page row: label, raw key and description on the left with the setting's save status, error and managed line under them, and the control on the right; it stacks below a container width.
   * @tag form
   * @tag settings
   * @useWhen Pairing a setting label and guidance with an Input, Toggle, or Select control that saves as the person leaves it.
   * @useWhen A setting needs to say where its save has got to (Saving, Saved, Applies after restart) or that it is locked by policy.
   * @avoidWhen The control belongs in a conventional stacked form field.
   * @related form-field, policy-lock
   */
  export type { SettingRowProps, SettingRowStatus } from './setting-row.types.ts';
</script>

<script lang="ts">
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import LoaderCircle from '@lucide/svelte/icons/loader-circle';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';

  import FormFieldFrame from '../../_internal/form-field-frame.svelte';
  import type { SettingRowProps, SettingRowStatus } from './setting-row.types.ts';
  import { classNames } from '../../utilities/class-names.ts';

  let {
    id,
    label,
    identifier,
    description,
    descriptionAction,
    warning,
    error,
    status,
    statusLabel,
    onRetry,
    retryLabel = 'Retry',
    required,
    disabled,
    managed,
    controlWidth,
    control,
    disclosure,
    class: className,
  }: SettingRowProps = $props();

  const STATUS_WORDS: Record<SettingRowStatus, string> = {
    saving: 'Saving…',
    saved: 'Saved just now',
    restart: 'Applies after restart',
    'saved-restart': 'Saved, waiting for a restart',
    reverted: 'Reverted, in effect now',
  };
</script>

{#snippet keyText()}
  {#if identifier}<span class="cinder-setting-row__identifier">{identifier}</span>{/if}
{/snippet}

{#snippet statusLine()}
  <!-- Always mounted, so a status that appears or changes is announced politely. -->
  <div class="cinder-setting-row__status" role="status">
    {#if status}
      <span class="cinder-setting-row__status-line" data-cinder-status={status}>
        {#if status === 'saving'}
          <LoaderCircle
            size={14}
            aria-hidden="true"
            class="cinder-setting-row__glyph cinder-setting-row__glyph--spinning"
          />
        {:else if status === 'saved'}
          <CircleCheck size={14} aria-hidden="true" class="cinder-setting-row__glyph" />
        {:else if status === 'restart'}
          <RotateCw size={14} aria-hidden="true" class="cinder-setting-row__glyph" />
        {:else if status === 'saved-restart'}
          <span class="cinder-setting-row__dot" aria-hidden="true"></span>
        {/if}
        {statusLabel ?? STATUS_WORDS[status]}
      </span>
    {/if}
  </div>
{/snippet}

{#snippet retryAction()}
  {#if onRetry}
    <button type="button" class="cinder-setting-row__retry" onclick={() => onRetry?.()}>
      {retryLabel}
    </button>
  {/if}
{/snippet}

<div
  class={classNames('cinder-setting-row', className)}
  style={controlWidth === undefined
    ? undefined
    : `--cinder-setting-row-control-width: ${controlWidth}`}
>
  <FormFieldFrame
    {id}
    {label}
    {description}
    {descriptionAction}
    {warning}
    {error}
    errorAction={onRetry ? retryAction : undefined}
    {required}
    {disabled}
    {managed}
    labelSuffix={identifier ? keyText : undefined}
    message={statusLine}
    class="cinder-setting-row__field"
    {control}
  />
  {#if disclosure}{@render disclosure()}{/if}
</div>
