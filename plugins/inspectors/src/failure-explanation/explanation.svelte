<script lang="ts">
  /**
   * The failure explanation page (COR-2543): the Bureau's own answer to why one run failed, drawn
   * with Cinder through the panel kit. Text goes in as text, never as markup. The page is a `main`
   * landmark with the sentence first, then one labelled section per part of the answer, and one
   * polite live region for what the page has just learned. It makes no write and has no control:
   * a run that did not fail shows the Bureau's message and what it said to do, and a read the host
   * did not answer says so.
   */
  import { Badge, DescriptionList, Section, Text } from '@lostgradient/cinder';

  import type { ExplanationView } from './view.svelte.ts';

  let { view }: { view: ExplanationView } = $props();

  const state = $derived(view.state);
  const facts = $derived(
    state.kind !== 'explained'
      ? []
      : [
          { id: 'cause', term: 'Cause', definition: cause },
          ...(state.model.step === null
            ? []
            : [{ id: 'step', term: 'Step', definition: state.model.step }]),
          ...(state.model.tries === null
            ? []
            : [{ id: 'tries', term: 'Tries', definition: state.model.tries }]),
        ],
  );
</script>

{#snippet cause()}
  {#if state.kind === 'explained'}
    <span data-part="cause">
      <Badge variant="danger">{state.model.category}</Badge>
      {#if state.model.causeDetail !== ''}<span class="explanation-detail"
          >{state.model.causeDetail}</span
        >{/if}
    </span>
  {/if}
{/snippet}

<p role="status" aria-live="polite" id="explanation-status" class="panel-status">
  {view.announcement}
</p>

<main aria-labelledby="explanation-title" class="panel-page" data-state={state.kind}>
  <Text as="h1" variant="h3" id="explanation-title">Why this run failed</Text>

  {#if state.kind === 'explained'}
    <p class="explanation-summary" data-part="summary">{state.model.summary}</p>

    <Section title="Details">
      <DescriptionList items={facts} variant="fields" />
    </Section>

    {#if state.model.verdicts.length > 0}
      <Section title="Guardrails">
        <ul aria-label="Guardrails that fired" class="panel-list" data-part="verdicts">
          {#each state.model.verdicts as verdict (verdict)}
            <li>{verdict}</li>
          {/each}
        </ul>
      </Section>
    {/if}

    <Section title="What to do next">
      <p data-part="remediation">{state.model.remediation}</p>
    </Section>
  {:else if state.kind === 'refused'}
    <p class="explanation-summary" data-part="message">{state.refusal.message}</p>
    {#if state.refusal.remediation !== null}
      <Section title="What to do next">
        <p data-part="remediation">{state.refusal.remediation}</p>
      </Section>
    {/if}
  {:else if state.kind === 'reading'}
    <p data-part="reading">Reading what the Bureau stored about run {state.runId}.</p>
  {:else if state.kind === 'unreadable'}
    <p data-part="unreadable">
      {#if state.reason === 'no-server-tools'}
        This host does not let the page read a run, so it cannot explain one.
      {:else}
        The host did not answer, so the run could not be explained. Open this page again to read it
        again.
      {/if}
    </p>
  {:else}
    <p data-part="waiting">No run is named. Open this page from the run that failed.</p>
  {/if}
</main>
