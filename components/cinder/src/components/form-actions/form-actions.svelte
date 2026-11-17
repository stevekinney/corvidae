<script lang="ts" module>
  export type { FormActionsProps } from './form-actions.types.ts';
</script>

<script lang="ts">
  import { trackDockedBar } from '../../_internal/docked-bar-height.ts';
  import { trackKeyboardInset } from '../../_internal/keyboard-inset.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import Alert from '../alert/alert.svelte';
  import type { FormActionsProps } from './form-actions.types.ts';

  let {
    label = 'Form actions',
    unsavedChanges = 0,
    sticky = false,
    error,
    errorTitle,
    summary,
    start,
    end,
    class: className,
    ...rest
  }: FormActionsProps = $props();

  let barElement: HTMLDivElement | undefined = $state();

  const changeCount = $derived(Number.isFinite(unsavedChanges) ? Math.max(0, unsavedChanges) : 0);
  const changeText = $derived(
    changeCount === 1 ? '1 unsaved change' : `${changeCount} unsaved changes`,
  );

  // A sticky bar is tracked so a toast sits above it while it is docked, and rides above the
  // on-screen keyboard, as the docked action bar does.
  $effect(() => {
    if (!sticky) return;
    return trackKeyboardInset();
  });
  $effect(() => {
    if (!sticky || !barElement) return;
    return trackDockedBar(barElement);
  });
</script>

<div
  {...rest}
  bind:this={barElement}
  class={classNames('cinder-form-actions', className)}
  role="group"
  aria-label={label}
  data-cinder-sticky={sticky ? '' : undefined}
>
  {#if error}
    <Alert variant="danger" class="cinder-form-actions__error">
      {#if errorTitle}<strong>{errorTitle}</strong>{' '}{/if}{error}
    </Alert>
  {/if}
  <div class="cinder-form-actions__row">
    <!-- Always mounted, so a count that appears is announced politely. -->
    <div class="cinder-form-actions__summary" role="status">
      {#if changeCount > 0}<span class="cinder-form-actions__changes">{changeText}</span
        >{/if}{#if summary}
        {#if changeCount > 0}<span aria-hidden="true">, </span>{/if}
        {@render summary()}
      {/if}
    </div>
    {#if start}<div class="cinder-form-actions__start">{@render start()}</div>{/if}
    <div class="cinder-form-actions__end">{@render end()}</div>
  </div>
</div>
