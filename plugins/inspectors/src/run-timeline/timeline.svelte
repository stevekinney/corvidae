<script lang="ts">
  /**
   * The run timeline's page (COR-2542): one run's steps as a waterfall, drawn with Cinder through
   * the panel kit. Text goes in as text, never as markup. The page is a `main` landmark with one
   * list of steps, each row naming the step, its status, how long it took and how many tries it
   * took, over a bar on a track as wide as the run, and one polite live region for changes that
   * outlives every redraw. It has no control and no form: it only shows. A refresh updates the
   * page in place.
   */
  import { Badge, Section, Text } from '@lostgradient/cinder';

  import type { TimelineView } from './view.svelte.ts';

  let { view }: { view: TimelineView } = $props();

  const model = $derived(view.model);
</script>

<p role="status" aria-live="polite" id="timeline-status" class="panel-status">
  {view.announcement}
</p>

{#if view.phase === 'loading'}
  <p class="panel-notice" data-state="loading">Loading the timeline…</p>
{:else if view.phase === 'offline'}
  <p class="panel-notice" data-state="offline">
    This host does not let the page read a run, so there is no timeline to show.
  </p>
{:else if view.phase === 'unreadable' && model === undefined}
  <p class="panel-notice" data-state="unreadable">
    The timeline could not be read. The run may not exist, you may not be allowed to read it, or
    this Bureau keeps no timeline.
  </p>
{:else if model !== undefined}
  <main aria-labelledby="timeline-title" class="panel-page">
    <div>
      <Text as="h1" variant="h3" id="timeline-title">Timeline of run {model.runId}</Text>
      <p class="timeline-summary">{model.summary}</p>
    </div>

    <Section title="Steps">
      {#if model.rows.length === 0}
        <p class="panel-notice" data-state="empty">
          This run has taken no steps yet. They appear here as it works.
        </p>
      {:else}
        <ol aria-label="Steps of the run, in the order it took them" class="timeline-steps">
          {#each model.rows as row (row.step)}
            <li class="timeline-step" data-step={row.step} data-status={row.status}>
              <div class="timeline-step__head">
                <span class="timeline-step__name">
                  <span class="timeline-step__label">{row.label}</span>
                  <span class="timeline-step__type">{row.operationType}</span>
                </span>
                <Badge variant={row.statusVariant} size="sm">{row.statusLabel}</Badge>
              </div>
              <span class="timeline-step__track" role="img" aria-label={row.barLabel}>
                {#if row.bar !== undefined}
                  <span
                    class="timeline-step__bar"
                    data-status={row.status === 'running' && !row.open ? 'ended' : row.status}
                    data-open={row.bar.open ? '' : undefined}
                    data-instant={row.bar.instant ? '' : undefined}
                    style={`inset-inline-start: ${String(row.bar.offset)}%; inline-size: ${String(row.bar.width)}%`}
                  ></span>
                {/if}
              </span>
              <p class="timeline-step__meta">
                <span class="timeline-step__duration">{row.durationText}</span>
                <span
                  class="timeline-step__tries"
                  data-retried={row.triesText !== '1 try' ? '' : undefined}
                >
                  {row.triesText}
                </span>
              </p>
            </li>
          {/each}
        </ol>
      {/if}
      {#if model.truncated}
        <p class="panel-notice" data-state="truncated">
          This run has more steps than the timeline holds. The first steps are shown, and the bars
          are drawn against them alone.
        </p>
      {/if}
    </Section>
  </main>
{/if}
