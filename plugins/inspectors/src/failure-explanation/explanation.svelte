<script lang="ts">
  /**
   * The failure explanation page (COR-2543): the Bureau's own answer to why one run failed, drawn
   * by the one component the Run page draws it with (`failure-explanation.svelte`, which the
   * application imports from this package), so the two read alike. Text goes in as text, never as
   * markup. The page is a `main` landmark under its heading, with one live region, visually hidden,
   * for what the page has just learned. It makes no write and has no control: a run that did not
   * fail says so in a sentence of the component's own and shows what the Bureau said to do, and a
   * read the host did not answer says so.
   */
  import { Text, VisuallyHidden } from '@lostgradient/cinder';
  import { FAILURE_EXPLANATION_LABELS } from '@lostgradient/interborough-plugin/failure-explanation';

  import FailureExplanation from './failure-explanation.svelte';
  import type { ExplanationView } from './view.svelte.ts';

  let { view }: { view: ExplanationView } = $props();

  const state = $derived(view.state);
</script>

<VisuallyHidden role="status" aria-live="polite" id="explanation-status">
  {view.announcement}
</VisuallyHidden>

<main aria-labelledby="explanation-title" class="panel-page" data-state={state.kind}>
  <Text as="h1" variant="h3" id="explanation-title">{FAILURE_EXPLANATION_LABELS.region}</Text>

  {#if state.kind === 'explained'}
    <FailureExplanation model={state.model} />
  {:else if state.kind === 'refused'}
    <FailureExplanation refusal={state.refusal} />
  {:else if state.kind === 'reading'}
    <Text variant="body" data-part="reading">Reading why this run failed.</Text>
  {:else if state.kind === 'unreadable'}
    <Text variant="body" data-part="unreadable">
      {#if state.reason === 'no-server-tools'}
        This host does not let the page read a run, so it cannot explain one.
      {:else}
        The host did not answer, so the run could not be explained. Open this page again to read it
        again.
      {/if}
    </Text>
  {:else}
    <Text variant="body" data-part="waiting"
      >No run is named. Open this page from the run that failed.</Text
    >
  {/if}
</main>
