<script lang="ts" module>
  /**
   * @cinder
   * @category form
   * @status beta
   * @purpose Action bar for the end of a form: a summary on the left, the secondary then primary buttons on the right, an optional failed-save alert above them, and an option to stay at the bottom of a long form.
   * @tag form
   * @tag actions
   * @tag sticky
   * @useWhen A form's Save and Cancel belong in one bar with a line of status beside them, such as "N unsaved changes" or what saving will do.
   * @useWhen A long form's Save must stay in reach, with the effect of saving named beside it.
   * @avoidWhen The bar belongs to a page that is not a form, such as a run's Send a message and Cancel run — use docked-action-bar.
   * @avoidWhen The actions belong to a dialog or drawer — use the overlay's own footer.
   * @rationale Nearest alternative: DockedActionBar — a docked bar belongs to a live page and can go off together; this one belongs to a form and carries its summary and failed-save message.
   * @related form, button, docked-action-bar, alert
   */
  export type { FormActionsProps } from './form-actions.types.ts';
</script>

<script lang="ts">
  import { trackDockedBarHeight } from '../../_internal/docked-bar-height.ts';
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

  // A sticky bar publishes its height so a toast sits above it, and rides above the on-screen
  // keyboard, as the docked action bar does.
  $effect(() => {
    if (!sticky) return;
    return trackKeyboardInset();
  });
  $effect(() => {
    if (!sticky || !barElement) return;
    return trackDockedBarHeight(barElement);
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
