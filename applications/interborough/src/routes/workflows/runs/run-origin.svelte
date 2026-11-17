<script lang="ts">
  /**
   * What started a run, in the Started by column: one line for each kind of origin the Bureau
   * records, with a link to the thing that started it where there is a page for it (the chat, the
   * schedule, the goal, the run that started it). A chat and a goal lead with what they are ("Chat",
   * "Goal"), and a goal's attempt follows its link ("attempt 2 of 5"). A run recorded before origins
   * were kept reads "Not recorded".
   */
  import { TASK_COPY } from '../../../app/copy/tasks.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import type { RunAttempt, RunOrigin } from './run-rows.ts';
  import { STARTED_BY_FILTER_LABELS, STARTED_BY_LABELS } from './started-by.ts';

  interface RunOriginProps {
    origin: RunOrigin;
    /** Which attempt of its goal the run is, when it is one. */
    attempt?: RunAttempt | null | undefined;
    /**
     * A schedule's name and when it runs, which a schedule's run says in place of the schedule's
     * identifier: "Schedule Daily summary, every day at 3:00 AM (9:00 AM UTC)" (COR-2424).
     */
    scheduleLine?: { readonly name: string; readonly cadence: string } | undefined;
    /** Who is viewing the page: a run this principal started by hand reads "You" (COR-2424). */
    viewer?: string | null | undefined;
    /**
     * The title of a plugin, for a run its trigger started ("GitHub"); the identifier is said when
     * none is loaded.
     */
    pluginTitle?: ((plugin: string) => string | undefined) | undefined;
  }

  let {
    origin,
    attempt = null,
    scheduleLine = undefined,
    viewer = undefined,
    pluginTitle = undefined,
  }: RunOriginProps = $props();

  /** Whether `who`, the principal a person origin records, is the one viewing the page. */
  function isViewer(who: string | null | undefined): boolean {
    return (
      who !== null && who !== undefined && viewer !== null && viewer !== undefined && who === viewer
    );
  }

  /** Opens a link in place, and leaves a modified click to the browser. */
  function open(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

{#snippet link(href: string)}
  <a href={router.href(href)} onclick={(event) => open(event, href)}>
    {#if origin.kind === 'chat'}
      {origin.title === '' ? TASK_COPY.untitledChat : origin.title}
    {:else if origin.kind === 'agent'}
      <code class="ib-identifier"
        >{origin.agentName === '' ? origin.parentRunId : origin.agentName}</code
      >
    {:else if origin.kind === 'goal'}
      {origin.title}
    {:else if origin.kind === 'parent'}
      <code class="ib-identifier">{origin.parentRunId}</code>
    {/if}
  </a>
{/snippet}

<span class="ib-run-origin" data-origin={origin.kind}>
  {#if origin.kind === 'chat'}
    <span class="ib-run-origin__kind">{TASK_COPY.list.kinds.chat}</span>
    {@render link(origin.href)}
  {:else if origin.kind === 'person' && isViewer(origin.principal)}
    <!-- The viewer's own run reads "You" (COR-2424, row 54l). -->
    {STARTED_BY_FILTER_LABELS.person}
  {:else if origin.kind === 'person'}
    {origin.surface === null
      ? STARTED_BY_LABELS.person
      : `${STARTED_BY_LABELS.person} ${TASK_COPY.personSurface[origin.surface]}`}
  {:else if origin.kind === 'schedule' && scheduleLine !== undefined && origin.schedulePath !== null}
    {@const schedulePath = origin.schedulePath}
    <span class="ib-run-origin__kind">{TASK_COPY.list.kinds.schedule}</span>
    <a href={router.href(schedulePath)} onclick={(event) => open(event, schedulePath)}
      >{scheduleLine.name}</a
    >, {scheduleLine.cadence}{#if origin.manual}, {TASK_COPY.firedByHand}{/if}
  {:else if origin.kind === 'schedule'}
    {#if origin.scheduleId !== null && origin.schedulePath !== null}
      {@const schedulePath = origin.schedulePath}
      <a href={router.href(schedulePath)} onclick={(event) => open(event, schedulePath)}
        ><code class="ib-identifier">{origin.scheduleId}</code></a
      >
      ({origin.manual
        ? `${TASK_COPY.schedule}, ${TASK_COPY.firedByHand}`
        : TASK_COPY.schedule}){#if origin.href !== null},{/if}
    {/if}
    <!-- A run only the engine holds ran in no session, so there is nothing to link to. -->
    {#if origin.href !== null}
      {@const sessionPath = origin.href}
      <a href={router.href(sessionPath)} onclick={(event) => open(event, sessionPath)}
        >{origin.title === '' ? TASK_COPY.untitledChat : origin.title}</a
      >
    {/if}
    {#if origin.scheduleId === null}({TASK_COPY.schedule}){/if}
  {:else if origin.kind === 'api'}
    {STARTED_BY_LABELS.api}
  {:else if origin.kind === 'agent'}
    {@render link(origin.href)} ({TASK_COPY.agent})
  {:else if origin.kind === 'agent-run'}
    An agent's tool call, {origin.agentName},
    <a href={router.href(origin.href)} onclick={(event) => open(event, origin.href)}>Calling run</a>
  {:else if origin.kind === 'goal'}
    <!-- A goal's session is named only when it has a title: the chain is the goal, the attempt and
         this run (row 55f), and an untitled session adds nothing to it. -->
    <span class="ib-run-origin__kind">{TASK_COPY.list.kinds.goal}</span>
    {@render link(origin.href)}{#if attempt !== null}, {TASK_COPY.list.attempt(
        attempt.number,
        attempt.of,
      )}{/if}{#if origin.session && origin.session.title !== ''}
      {@const session = origin.session},
      <a href={router.href(session.href)} onclick={(event) => open(event, session.href)}
        >{session.title}</a
      >{/if}
  {:else if origin.kind === 'parent'}
    {@render link(origin.href)} ({TASK_COPY.workflow})
  {:else if origin.kind === 'system'}
    {STARTED_BY_LABELS.system}
  {:else if origin.kind === 'trigger'}
    {#if origin.plugin === null}
      {STARTED_BY_LABELS.trigger}
    {:else}
      <!-- COR-2171: which trigger, by its plugin's title, linked to the file whose trigger it is. -->
      {@const plugin = pluginTitle?.(origin.plugin) ?? origin.plugin}
      <span class="ib-run-origin__kind">{TASK_COPY.list.kinds.trigger}</span>
      {#if origin.href !== null}
        {@const triggerPath = origin.href}
        <a href={router.href(triggerPath)} onclick={(event) => open(event, triggerPath)}>{plugin}</a
        >
      {:else}
        {plugin}
      {/if}
    {/if}
  {:else}
    {TASK_COPY.originUnrecorded}
  {/if}
</span>
