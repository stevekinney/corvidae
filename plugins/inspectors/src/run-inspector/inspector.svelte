<script lang="ts">
  /**
   * The run inspector's page (COR-910, COR-2218): the model drawn with Cinder through the panel
   * kit. Text goes in as text, never as markup. The page is a `main` landmark with one labelled
   * section per part of the run, one polite live region for changes that outlives every redraw, and
   * one abort button whose name says what it does. A poll updates the page in place, so the focused
   * control keeps focus.
   */
  import { Button, Callout, DescriptionList, Section, Text } from '@lostgradient/cinder';

  import type { InspectorView } from './view.svelte.ts';

  let { view, onAbort }: { view: InspectorView; onAbort: () => void } = $props();

  const model = $derived(view.model);
  const lifecycle = $derived(
    model === undefined
      ? []
      : [
          { term: 'Agent', definition: model.agentName },
          { term: 'Lifecycle', definition: model.lifecycle },
          { term: 'Assessment', definition: model.liveness.assessment },
          { term: 'Reachability', definition: model.liveness.reachability },
          { term: 'Progress state', definition: model.liveness.progress },
          { term: 'Waiting on', definition: model.liveness.wait ?? 'nothing declared' },
        ],
  );
</script>

<p role="status" aria-live="polite" id="inspector-status" class="panel-status">
  {view.announcement}
</p>

{#if model !== undefined}
  <main aria-labelledby="inspector-title" class="panel-page">
    <Text as="h1" variant="h3" id="inspector-title">Run {model.taskId}</Text>

    <Section title="Lifecycle">
      <DescriptionList items={lifecycle} variant="fields" />
    </Section>

    <Section title="Ownership tree">
      <ul aria-label="Run and the children it owns" class="panel-list">
        <li>
          {model.tree.label} ({model.tree.status})
          <ul aria-label="Children" class="panel-list">
            {#each model.tree.children as child (child.id)}
              <li>{child.label} ({child.status})</li>
            {:else}
              <li>No children</li>
            {/each}
          </ul>
        </li>
      </ul>
    </Section>

    <Section title="Progress evidence">
      <p>{model.semanticProgress ?? 'No semantic progress reported.'}</p>
      <ul aria-label="Progress evidence" class="panel-list">
        {#each model.progressEvidence as entry (`${entry.source}@${entry.at}`)}
          <li>{entry.source} at {Math.round(entry.at)} ms</li>
        {:else}
          <li>No progress evidence.</li>
        {/each}
      </ul>
    </Section>

    <Section title="Liveness signals">
      <p>Heartbeats and lease renewals show the run is reachable. They are not progress.</p>
      <ul aria-label="Liveness signals" class="panel-list">
        {#each model.livenessSignals as entry (`${entry.source}@${entry.at}`)}
          <li>{entry.source} at {Math.round(entry.at)} ms</li>
        {:else}
          <li>No liveness signals.</li>
        {/each}
      </ul>
    </Section>

    <Section title="Result">
      <p>
        {model.result === null
          ? 'No result yet.'
          : `${model.result.text}${model.result.truncated ? ' (truncated)' : ''}`}
      </p>
    </Section>

    <Section title="Event stream">
      <p>
        {#if model.stream.kind === 'gap'}
          {`Gap: events from ${model.stream.requestedCursor} are no longer retained; the stream resumes at ${model.stream.firstRetainedCursor}.`}
        {:else if model.stream.kind === 'removed'}
          The task was removed.
        {:else}
          Current.
        {/if}
      </p>
    </Section>

    <Section title="Abort and cleanup">
      <p>Abort state: {model.abort.state}. Cleanup: {model.abort.cleanup ?? 'none'}.</p>
      <Button
        id="inspector-abort-button"
        variant="danger"
        label="Abort run"
        disabled={!model.abort.available}
        onclick={onAbort}
      />
    </Section>
  </main>
{:else if view.notice !== undefined}
  <main class="panel-page">
    <Text as="h1" variant="h3">Run inspector</Text>
    <Callout variant="info">
      <p data-inspector-notice>{view.notice}</p>
    </Callout>
  </main>
{/if}
