<script lang="ts">
  /**
   * The run page's Run hooks section (COR-2115, the agreed design): the hooks of a live run's plan with
   * the ones that threw first, and for a settled run only the ones that threw. It sits in the main
   * column directly after What happened and before How it ran, at every width, so a settled run's
   * failures are never inside a disclosure that is closed for it. A run with nothing to say (a
   * settled run no hook failed in, a live run whose plan is empty and holds no failure) draws no
   * section at all.
   *
   * It reads `bureau.tasks.inspect` (`inspectTaskHooks`): the plan while the run is live, and the
   * hooks that threw, one entry for each registration with how often and when last. It reads again
   * when the run's stream reports something and when the run's status changes, so a hook that fails
   * while the page is watched moves to the top, and a run that settles drops its clean rows without
   * a reload. A row is a status-first `StackedListItem` with no link and no action: the status is the
   * one `StatusDot` ("Failed", or "Failed, 3 times"), line one is the hook point in words with the time
   * of the latest failure, and line two is who registered it, the hook id in code, then the priority
   * and the replay words. There is no retry and no reason on a row, because the record has neither.
   * A read that fails before any hooks were read is the section's one error row; a read that fails
   * after they were read keeps the rows read last on screen, which is what the run list does too.
   */
  import {
    AccessGate,
    Button,
    DataList,
    ErrorState,
    Section,
    Skeleton,
    StackedListItem,
    StatusDot,
    Text,
  } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
  import { FORBIDDEN_COPY, RETRY_LABEL } from '../../../app/copy/views.ts';
  import { agentLabel } from '../../../lib/agent-label.ts';
  import { listAgents } from '../../../lib/bureau-client.ts';
  import { inspectTaskHooks, type TaskView } from '../../../lib/bureau-tasks.ts';
  import { classifyFault } from '../../../lib/faults.ts';
  import { clockTime, viewerTimeZone } from '../../../lib/format/clock.ts';
  import { usePluginTitle } from '../../../lib/plugin-title.svelte.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import {
    hookLineParts,
    hookLineString,
    hookPointString,
    hookStatusWord,
    runHooksView,
    type RunHookRow,
  } from './run-hooks.ts';

  interface RunHooksProps {
    task: TaskView;
    /** Whether the run has ended, which is when its plan is no longer shown. */
    over: boolean;
    /** How many elements the run's stream has reported; the hooks are read again when it grows. */
    events?: number;
  }

  /** How long a burst of stream elements waits before the hooks are read once for all of them. */
  const EVENT_REREAD_MILLISECONDS = 300;
  /** How long the hooks are let to arrive before their placeholders are drawn: Cinder's loading rule. */
  const LOADING_DELAY_MILLISECONDS = 300;

  const copy = RUN_DETAIL_COPY.hooks;
  let { task, over, events = 0 }: RunHooksProps = $props();
  const zone = viewerTimeZone();

  const hooks = createQuery(
    () => ({
      queryKey: queryKeys.bureauTasks.hooks(task.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => inspectTaskHooks(task.id, { signal }),
      retry: false,
    }),
    undefined,
  );
  // The agent's name as a person reads it, for a hook the run's agent registered.
  const agents = createQuery(
    () => ({
      queryKey: ['agents', 'run-hooks'] as const,
      queryFn: () => listAgents(),
      retry: false,
    }),
    undefined,
  );
  const pluginTitle = usePluginTitle();
  const agentName = $derived(
    task.agentName === null || task.agentName === undefined
      ? undefined
      : agentLabel(task.agentName, agents.data),
  );
  const context = $derived({ agentLabel: agentName, pluginTitle });

  let lastEvents = untrack(() => events);
  $effect(() => {
    const now = events;
    if (now === lastEvents) return;
    lastEvents = now;
    // poll-reason: timer
    const timer = setTimeout(() => void untrack(() => hooks.refetch()), EVENT_REREAD_MILLISECONDS);
    return () => clearTimeout(timer);
  });
  // A run that settles is read again at once: its plan is gone and what threw is final.
  let lastStatus = untrack(() => task.status);
  $effect(() => {
    const status = task.status;
    if (status === lastStatus) return;
    lastStatus = status;
    untrack(() => void hooks.refetch());
  });

  const forbidden = $derived.by(() => {
    if (!hooks.isError) return false;
    const treatment = classifyFault(hooks.error);
    return treatment?.kind === 'unauthorized' && treatment.mode === 'forbidden';
  });
  const view = $derived(hooks.data === undefined ? undefined : runHooksView(hooks.data, over));
  const rows = $derived(view === undefined ? [] : [...view.rows]);

  function open(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  function lineOf(row: RunHookRow): string {
    return hookLineString(hookLineParts(row, context));
  }
</script>

{#snippet row(entry: RunHookRow)}
  {@const parts = hookLineParts(entry, context)}
  {@const word = hookStatusWord(entry)}
  <StackedListItem
    data-hook={entry.id}
    data-failed={entry.failure === undefined ? undefined : ''}
    tooltip={hookPointString(entry.hookPoint)}
    metaTooltip={lineOf(entry)}
  >
    {#snippet status()}
      {#if word !== undefined}<StatusDot {word} />{/if}
    {/snippet}
    {#snippet title()}
      {#if 'words' in entry.title}{entry.title.words}{:else}<Text variant="code"
          >{entry.title.code}</Text
        >{/if}
    {/snippet}
    {#snippet time()}
      {#if entry.failure !== undefined}
        <time datetime={new Date(entry.failure.lastFailedAt).toISOString()}
          >{clockTime(entry.failure.lastFailedAt, zone)}</time
        >
      {/if}
    {/snippet}
    {#snippet meta()}
      {#each parts as part, index (index)}{#if index > 0}{', '}{/if}{#if 'words' in part}{part.words}{:else}<Text
            variant="code">{part.code}</Text
          >{/if}{/each}
    {/snippet}
  </StackedListItem>
{/snippet}

{#if forbidden}
  <Section title={copy.heading} data-section="run-hooks">
    <AccessGate
      granted={false}
      variant="section"
      layout="inline"
      headingLevel={3}
      title={copy.forbidden.title}
      reason={FORBIDDEN_COPY.description}
      requirement={copy.forbidden.requirement}
    >
      {#snippet actions()}
        <Button
          variant="secondary"
          href={router.href(FORBIDDEN_COPY.scopes.href)}
          onclick={(event) => open(event, FORBIDDEN_COPY.scopes.href)}
          label={FORBIDDEN_COPY.scopes.label}
        />
      {/snippet}
    </AccessGate>
  </Section>
{:else if hooks.isError && hooks.data === undefined}
  <!-- A read that fails after the hooks were read leaves the rows read last on screen, as the run
       list does while the server does not answer (C3-23): the shell's banner says it once. -->

  <Section title={copy.heading} data-section="run-hooks">
    <ErrorState
      variant="row"
      title={copy.loadFailed.title}
      description={copy.loadFailed.description}
      headingLevel={3}
      retryLabel={RETRY_LABEL}
      retryVariant="secondary"
      onRetry={() => void hooks.refetch()}
    />
  </Section>
{:else if view === undefined}
  <!-- A settled run draws nothing until its failed hooks are known, so a section never appears and
       then vanishes. A live run draws its heading and placeholders, which become its rows. -->
  {#if !over}
    <Section title={copy.heading} data-section="run-hooks">
      <Skeleton variant="list" rows={3} delay={LOADING_DELAY_MILLISECONDS} label={copy.loading} />
    </Section>
  {/if}
{:else if view.kind === 'rows'}
  <Section title={copy.heading} description={view.description} data-section="run-hooks">
    {#if rows.length > 0}
      <DataList
        items={rows}
        key={(entry: RunHookRow) => entry.key}
        aria-label={copy.listLabel}
        statusColumn
      >
        {#snippet children(entry: RunHookRow)}
          {@render row(entry)}
        {/snippet}
      </DataList>
    {/if}
  </Section>
{/if}
