<script lang="ts">
  /**
   * The Failed at step control of the Runs filter bar (COR-2535): a field that suggests the step
   * names the listed runs failed at and takes any name typed. The address changes, and so the
   * Bureau is asked again, only when a name is chosen or committed with Enter, or when the field
   * is emptied: never on each keystroke, because every change of filter starts a paged listing.
   */
  import { Autocomplete, type AutocompleteSuggestion } from '@lostgradient/cinder';
  import { untrack } from 'svelte';

  import { TASK_COPY } from '../../../app/copy/tasks.ts';
  import { failedStepName } from './run-rows.ts';

  interface RunFailedStepProps {
    /** The step the address names, or `''` for none. */
    value: string;
    /** The step names to suggest, in the order to offer them. */
    steps: readonly string[];
    /** Whether the bar is disabled. */
    disabled?: boolean;
    /** A name was chosen or committed, or the field was emptied (`''`). */
    onCommit: (step: string) => void;
  }

  let { value, steps, disabled = false, onCommit }: RunFailedStepProps = $props();

  let draft = $state(untrack(() => value));
  // The address is the truth: a link, Clear filters or a removed chip changes what is typed.
  $effect(() => {
    draft = value;
  });

  function suggest(query: string): AutocompleteSuggestion[] {
    const needle = query.trim().toLocaleLowerCase();
    return steps
      .filter((step) => step.toLocaleLowerCase().includes(needle))
      .map((step) => ({ value: step }));
  }

  function commit(next: string): void {
    const step = failedStepName(next);
    if (step !== value) onCommit(step);
  }
</script>

<form
  class="ib-runs__failed-step"
  onsubmit={(event) => {
    event.preventDefault();
    commit(draft);
  }}
>
  <Autocomplete
    id="ib-runs-failed-step"
    aria-label={TASK_COPY.failedStepLabel}
    placeholder={TASK_COPY.failedStepPlaceholder}
    {disabled}
    minQueryLength={0}
    suggestionSource={suggest}
    bind:value={draft}
    onValueChange={(next) => {
      if (next.trim() === '') commit('');
    }}
    onComplete={(suggestion) => commit(suggestion.value)}
  />
</form>
