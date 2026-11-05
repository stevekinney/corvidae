<script lang="ts" module>
  /**
   * @cinder
   * @category form
   * @status beta
   * @purpose Thin form root that owns asynchronous submit state and prevents duplicate submissions while preserving native form behavior.
   * @tag form
   * @tag submit
   * @useWhen A form needs a shared pending state while an asynchronous submit handler runs.
   * @avoidWhen Submission is entirely native and no pending UI needs to be coordinated.
   * @related form-field, button
   */
  export type { FormProps, FormSubmitContext } from './form.types.ts';
</script>

<script lang="ts">
  import { tick } from 'svelte';

  import type { FormProps } from './form.types.ts';
  import { focusFirstProblem } from './focus-first-problem.ts';
  import { classNames } from '../../utilities/class-names.ts';

  let {
    onSubmit,
    children,
    class: className,
    readingColumn = false,
    focusProblemOnSubmit = true,
    ...rest
  }: FormProps = $props();
  let submitting = $state(false);
  let formElement: HTMLFormElement | undefined = $state();

  async function handleSubmit(event: SubmitEvent): Promise<void> {
    if (!onSubmit) return;
    event.preventDefault();
    if (submitting) return;
    submitting = true;
    try {
      await onSubmit(event);
    } finally {
      submitting = false;
      // A press on a Save that stays enabled is how an invalid form is told about its problems:
      // once the handler has put its messages at the fields, focus goes to the first of them.
      if (focusProblemOnSubmit) {
        await tick();
        if (formElement) focusFirstProblem(formElement);
      }
    }
  }
</script>

<form
  {...rest}
  bind:this={formElement}
  class={classNames('cinder-form', className)}
  data-cinder-reading-column={readingColumn ? '' : undefined}
  data-cinder-submitting={submitting ? '' : undefined}
  onsubmit={handleSubmit}
>
  {@render children?.({ submitting })}
</form>
