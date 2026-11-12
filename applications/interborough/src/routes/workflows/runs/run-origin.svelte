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
  import { goalTitle, type RunAttempt, type RunOrigin } from './run-rows.ts';
  import { STARTED_BY_LABELS } from './started-by.ts';

  interface RunOriginProps {
    origin: RunOrigin;
    /** Which attempt of its goal the run is, when it is one. */
    attempt?: RunAttempt | null | undefined;
  }

  let { origin, attempt = null }: RunOriginProps = $props();

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
      {goalTitle(origin.name)}
    {:else if origin.kind === 'parent'}
      <code class="ib-identifier">{origin.parentRunId}</code>
    {/if}
  </a>
{/snippet}

<span class="ib-run-origin" data-origin={origin.kind}>
  {#if origin.kind === 'chat'}
    <span class="ib-run-origin__kind">{TASK_COPY.list.kinds.chat}</span>
    {@render link(origin.href)}
  {:else if origin.kind === 'person'}
    {origin.surface === null
      ? STARTED_BY_LABELS.person
      : `${STARTED_BY_LABELS.person} ${TASK_COPY.personSurface[origin.surface]}`}
  {:else if origin.kind === 'schedule'}
    {#if origin.scheduleId !== null && origin.schedulePath !== null}
      {@const schedulePath = origin.schedulePath}
      <a href={router.href(schedulePath)} onclick={(event) => open(event, schedulePath)}
        ><code class="ib-identifier">{origin.scheduleId}</code></a
      >
      ({origin.manual ? `${TASK_COPY.schedule}, ${TASK_COPY.firedByHand}` : TASK_COPY.schedule}),
    {/if}
    <a href={router.href(origin.href)} onclick={(event) => open(event, origin.href)}
      >{origin.title === '' ? TASK_COPY.untitledChat : origin.title}</a
    >
    {#if origin.scheduleId === null}({TASK_COPY.schedule}){/if}
  {:else if origin.kind === 'api'}
    {STARTED_BY_LABELS.api}
  {:else if origin.kind === 'agent'}
    {@render link(origin.href)} ({TASK_COPY.agent})
  {:else if origin.kind === 'agent-run'}
    An agent's tool call, {origin.agentName},
    <a href={router.href(origin.href)} onclick={(event) => open(event, origin.href)}>Calling run</a>
  {:else if origin.kind === 'goal'}
    <span class="ib-run-origin__kind">{TASK_COPY.list.kinds.goal}</span>
    {@render link(origin.href)}{#if attempt !== null}, {TASK_COPY.list.attempt(
        attempt.number,
        attempt.of,
      )}{/if}{#if origin.session}
      {@const session = origin.session},
      <a href={router.href(session.href)} onclick={(event) => open(event, session.href)}
        >{session.title === '' ? TASK_COPY.untitledChat : session.title}</a
      >{/if}
  {:else if origin.kind === 'parent'}
    {@render link(origin.href)} ({TASK_COPY.workflow})
  {:else if origin.kind === 'system'}
    {STARTED_BY_LABELS.system}
  {:else}
    {TASK_COPY.originUnrecorded}
  {/if}
</span>
