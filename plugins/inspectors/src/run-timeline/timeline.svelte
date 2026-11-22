<script lang="ts">
  /**
   * The run timeline's page (COR-2542): one run's steps as a waterfall, drawn with Cinder through
   * the panel kit. Text goes in as text, never as markup. The page is a `main` landmark with one
   * list of steps, each row naming the step, its status, how long it took and how many tries it
   * took, over a bar on a track as wide as the run, under one scale labelled at its two ends. A
   * state with no timeline to draw (loading, nothing to read, a host that gives no server tools) is
   * Cinder's `EmptyState`, and a note about the timeline that is drawn (the connection, a run cut
   * short) is a `Callout`. One polite live region carries changes to assistive technology and
   * outlives every redraw. The page has no control and no form: it only shows. A refresh updates
   * the page in place.
   */
  import { Badge, Callout, EmptyState, Section, Text } from '@lostgradient/cinder';

  import type { TimelineView } from './view.svelte.ts';

  let { view }: { view: TimelineView } = $props();

  const model = $derived(view.model);
</script>

<!-- The live region says each change to assistive technology; what a person sees of the same
     changes is the list, the badges and the callouts, so it draws nothing of its own. -->
<p role="status" aria-live="polite" id="timeline-status" class="timeline-announcement">
  {view.announcement}
</p>

{#if view.phase === 'loading'}
  <EmptyState
    kind="first-use"
    title="Loading the timeline"
    description="The steps of the run appear here as soon as the host has read them."
    headingLevel={1}
    data-state="loading"
  />
{:else if view.phase === 'offline'}
  <EmptyState
    kind="disabled"
    title="This host does not let the panel read a run"
    description="The panel can only show a timeline when its host lets it call a tool. Open the run from the application to see its timeline."
    headingLevel={1}
    data-state="offline"
  />
{:else if view.phase === 'unreadable' && model === undefined}
  <EmptyState
    kind="not-found"
    title="This run’s timeline could not be read"
    description="It may have been removed, or you may not have access to it."
    headingLevel={1}
    data-state="unreadable"
  />
{:else if model !== undefined}
  <main aria-labelledby="timeline-title" class="panel-page">
    <header class="timeline-header">
      <div class="timeline-heading">
        <Text as="h1" variant="h3" id="timeline-title">Run timeline</Text>
        {#if model.runStatus !== undefined}
          <Badge
            variant={model.runStatus.variant}
            size="sm"
            aria-label={`Run status: ${model.runStatus.label.toLowerCase()}`}
            data-run-status
          >
            {model.runStatus.label}
          </Badge>
        {/if}
      </div>
      <p class="timeline-run-id">{model.runId}</p>
      {#if model.rows.length > 0}
        <p class="timeline-summary">{model.summary}</p>
      {/if}
    </header>

    {#if view.connection === 'lost'}
      <Callout variant="warning" data-state="connection-lost">
        Connection lost. Retrying. The steps and bars may be out of date.
      </Callout>
    {:else if view.connection === 'back'}
      <Callout variant="success" data-state="reconnected">
        Reconnected. The timeline is up to date.
      </Callout>
    {/if}

    {#if model.rows.length === 0}
      <EmptyState
        kind="first-use"
        title="This run has taken no steps yet"
        description="They appear here as it works."
        headingLevel={2}
        data-state="empty"
      />
    {:else}
      <Section title="Steps">
        {#if model.axis !== undefined}
          <div
            class="timeline-axis"
            role="group"
            aria-label="Time scale of the bars, from the first step to the end of the run"
          >
            <span>{model.axis.start}</span>
            <span>{model.axis.end}</span>
          </div>
        {/if}
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
                {#if row.durationText !== undefined}
                  <span class="timeline-step__duration">{row.durationText}</span>
                {/if}
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
        {#if model.truncated}
          <Callout variant="info" data-state="truncated">
            This run has more steps than the timeline holds. The first steps are shown, and the bars
            are drawn against them alone.
          </Callout>
        {/if}
      </Section>
    {/if}
  </main>
{/if}
