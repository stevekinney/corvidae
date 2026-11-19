<script lang="ts">
  /**
   * The Run inspector under How it ran (COR-2424, row 54i): five rows an operator reads to tell
   * where a run stands, written from the task the page already holds (`run-inspector.ts`): its
   * progress, what it waits on, whether it still gives signs of life, whether the page's follow of
   * it is up to date, and where its cleanup stands. A run of one of the Bureau's own workflows
   * says it is built in.
   */
  import { Badge, DescriptionList, Section, type DescriptionListItem } from '@lostgradient/cinder';

  import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
  import { runInspectorRows, type RunInspectorInput } from './run-inspector.ts';

  interface RunInspectorProps extends RunInspectorInput {
    /** Whether the run is one of Interborough's own workflows, which the card says is built in. */
    builtIn?: boolean;
  }

  let { task, followState, waitingForSignals, builtIn = false }: RunInspectorProps = $props();

  const items = $derived(
    runInspectorRows({ task, followState, waitingForSignals }).map((row): DescriptionListItem => ({
      id: row.key,
      term: row.label,
      definition: row.value,
    })),
  );
</script>

<Section level={3} title={RUN_DETAIL_COPY.inspector.heading} data-section="run-inspector">
  {#if builtIn}<Badge variant="neutral">{RUN_DETAIL_COPY.inspector.builtIn}</Badge>{/if}
  <DescriptionList {items} variant="default" />
</Section>
