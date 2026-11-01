<script lang="ts">
  /**
   * The three steps a new installation shows on Chat's empty state, until each is done or the
   * person dismisses them: connect a provider, create an agent, say hello. A step is done by the
   * host's own answer (`first-run.ts`), so it checks itself off when the work is done anywhere,
   * and an undone step links to the page that does it. The steps appear only once all three
   * answers are in: a read that failed says nothing about whether a step is done, so the
   * checklist waits for a host that can answer. Dismissing keeps the choice in this browser
   * (`interborough:first-run:dismissed`).
   */
  import { Button } from '@lostgradient/cinder';
  import { Check, Circle } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { listAgents, listContexts } from '../lib/bureau-client.ts';
  import { getProviders } from '../lib/host-providers.ts';
  import { queryKeys } from '../lib/query.ts';
  import { router } from '../lib/router.svelte.ts';
  import { FIRST_RUN_COPY } from './copy.ts';
  import {
    FIRST_RUN_STEPS,
    firstRunComplete,
    firstRunProgress,
    readFirstRunDismissed,
    writeFirstRunDismissed,
  } from './first-run.ts';

  let dismissed = $state(readFirstRunDismissed());

  const providers = createQuery(
    () => ({
      queryKey: queryKeys.hostProviders(),
      queryFn: ({ signal }) => getProviders({ signal }),
      retry: false,
      enabled: !dismissed,
    }),
    undefined,
  );
  const agents = createQuery(
    () => ({
      queryKey: queryKeys.agents.list(),
      queryFn: ({ signal }) => listAgents({ signal }),
      retry: false,
      enabled: !dismissed,
    }),
    undefined,
  );
  const chats = createQuery(
    () => ({
      queryKey: queryKeys.contexts.firstRun(),
      queryFn: ({ signal }) => listContexts({ origin: 'chat', limit: 1 }, { signal }),
      retry: false,
      enabled: !dismissed,
    }),
    undefined,
  );

  const progress = $derived(
    providers.data === undefined || agents.data === undefined || chats.data === undefined
      ? undefined
      : firstRunProgress({
          providers: providers.data.providers,
          agents: agents.data,
          chatCount: chats.data.contexts.length,
        }),
  );
  const shown = $derived(!dismissed && progress !== undefined && !firstRunComplete(progress));

  function dismiss(): void {
    writeFirstRunDismissed();
    dismissed = true;
  }

  function go(event: MouseEvent, href: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(href);
  }
</script>

{#if shown && progress !== undefined}
  <section class="ib-first-run" aria-labelledby="ib-first-run-title" data-testid="first-run">
    <div class="ib-first-run__heading">
      <div class="ib-first-run__text">
        <h2 id="ib-first-run-title" class="ib-first-run__title">{FIRST_RUN_COPY.title}</h2>
        <p class="ib-first-run__description">{FIRST_RUN_COPY.description}</p>
      </div>
      <Button variant="ghost" size="sm" aria-label={FIRST_RUN_COPY.dismissLabel} onclick={dismiss}
        >{FIRST_RUN_COPY.dismiss}</Button
      >
    </div>
    <ol class="ib-first-run__steps" aria-label={FIRST_RUN_COPY.listLabel}>
      {#each FIRST_RUN_STEPS as step (step)}
        {@const words = FIRST_RUN_COPY.steps[step]}
        {@const done = progress[step]}
        <li class="ib-first-run__step" data-step={step} data-done={done ? 'true' : 'false'}>
          <span class="ib-first-run__mark" aria-hidden="true">
            {#if done}<Check size={16} />{:else}<Circle size={16} />{/if}
          </span>
          <div class="ib-first-run__body">
            <p class="ib-first-run__step-title">
              {words.title}
              {#if done}<span class="ib-first-run__done">{FIRST_RUN_COPY.completed}</span>{/if}
            </p>
            {#if !done}
              <p class="ib-first-run__step-description">{words.description}</p>
            {/if}
          </div>
          {#if !done}
            <Button
              variant="secondary"
              size="sm"
              href={router.href(words.action.href)}
              onclick={(event) => go(event, words.action.href)}>{words.action.label}</Button
            >
          {/if}
        </li>
      {/each}
    </ol>
  </section>
{/if}

<style>
  .ib-first-run {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    inline-size: 100%;
    max-inline-size: 36rem;
    padding: var(--cinder-space-4);
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    text-align: start;
  }

  .ib-first-run__heading {
    display: flex;
    gap: var(--cinder-space-3);
    align-items: flex-start;
    justify-content: space-between;
  }

  .ib-first-run__text {
    min-inline-size: 0;
  }

  .ib-first-run__title {
    margin: 0;
    font-size: var(--cinder-text-lg);
    font-weight: 600;
  }

  .ib-first-run__description,
  .ib-first-run__step-description {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }

  .ib-first-run__steps {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ib-first-run__step {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-3);
    align-items: center;
  }

  .ib-first-run__mark {
    display: inline-flex;
    flex: none;
    color: var(--cinder-text-muted);
  }

  .ib-first-run__step[data-done='true'] .ib-first-run__mark {
    color: var(--cinder-status-success-text);
  }

  .ib-first-run__body {
    flex: 1 1 12rem;
    min-inline-size: 0;
    overflow-wrap: anywhere;
  }

  .ib-first-run__step-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-first-run__step[data-done='true'] .ib-first-run__step-title {
    color: var(--cinder-text-muted);
    font-weight: 400;
  }

  .ib-first-run__done {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }
</style>
