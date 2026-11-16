<script lang="ts">
  /**
   * What happened in an instance of a workflow file, which no chat thread describes: when it
   * started, then each step it began with how long after the start. A run that failed shows its
   * failure on the step that failed ("Step 2, Collect merged changes, failed after 2 tries"), with
   * why it failed under it and no banner above the page (row 14t). The entries are made from the
   * history the Bureau keeps of the instance (`run-instance.ts`).
   */
  import { Section } from '@lostgradient/cinder';
  import { CircleX } from '@lucide/svelte';

  import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
  import { TASK_COPY } from '../../../app/copy/tasks.ts';
  import { clockTime } from '../../../lib/format/clock.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import { failureHeading, type InstanceEntry, type InstanceProgress } from './run-instance.ts';
  import { durationWords } from './run-rows.ts';

  interface RunInstanceHappenedProps {
    entries: readonly InstanceEntry[];
    /** When the run started, in epoch milliseconds. */
    startedAt: number;
    /** How far the run got, which names the step that failed. */
    progress: InstanceProgress | undefined;
    /** Why the run failed, in the engine's words, when it did. */
    failure?: string | undefined;
  }

  let { entries, startedAt, progress, failure = undefined }: RunInstanceHappenedProps = $props();

  const copy = RUN_DETAIL_COPY.instance;
  const heading = $derived(progress === undefined ? undefined : failureHeading(progress));
  const healthPath = TASK_COPY.list.loadFailed.healthPath;

  function openHealth(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(healthPath);
  }
</script>

<Section title={RUN_DETAIL_COPY.happened.heading} data-section="what-happened">
  <ol class="ib-run-happened" aria-label={RUN_DETAIL_COPY.happened.listLabel}>
    <li class="ib-run-happened__entry" data-state="done">
      <span class="ib-run-happened__title"
        >{RUN_DETAIL_COPY.happened.started(clockTime(startedAt))}</span
      >
    </li>
    {#each entries as entry (entry.key)}
      <li
        class="ib-run-happened__entry"
        data-state={entry.state === 'failed' ? 'done' : entry.state}
        data-failed={entry.state === 'failed' ? '' : undefined}
      >
        <span class="ib-run-happened__title">{entry.title}</span>
        {#if entry.offsetMilliseconds !== undefined}
          <span class="ib-run-happened__offset">+{durationWords(entry.offsetMilliseconds)}</span>
        {/if}
      </li>
    {/each}
  </ol>
  {#if failure !== undefined && heading !== undefined}
    <div class="weft-overview-tab__failure" data-testid="run-step-failure">
      <div class="weft-overview-tab__failure-title">
        <CircleX aria-hidden="true" size={18} />
        <span>{heading}</span>
      </div>
      <p class="weft-overview-tab__failure-explanation">
        <strong>{copy.whyItFailed}.</strong>
        {failure}
      </p>
      <p class="weft-overview-tab__failure-explanation">
        {copy.checkHealth.before}<a href={router.href(healthPath)} onclick={openHealth}
          >{copy.checkHealth.link}</a
        >{copy.checkHealth.after}
      </p>
    </div>
  {/if}
</Section>
