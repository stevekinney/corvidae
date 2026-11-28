<script lang="ts">
  /**
   * Home's first run, the whole page while the checklist shows (owner, 2026-11-19): one heading at
   * the page title's size ("Set up Interborough"), one short sentence under it, and the three steps
   * in Cinder's `checklist` Steps, all centred in the content area at the page's reading width. No
   * box holds them, no second "Get started" heading sits inside, and no "0 of 3 done" counter: the
   * markers say which steps are done (a check) and which is next (an accent number).
   *
   * Connect a provider, create an agent or start from Assistant, say hello. The steps are done in
   * any order, and the first one that is not done is the current one, the only step with a primary
   * button; the rest have a secondary one. Step 2 has a quiet "Use Assistant" beside its button,
   * which takes Assistant (scripted, needing no provider) as the agent to start from.
   *
   * Whether "Start a chat" can work is the shared readiness rule (`chatReadiness`, which every New
   * chat entry point reads): Assistant needs no provider, so on a host that lists it the step is live
   * from the first moment and opens New chat with Assistant. Where no agent can answer yet the step
   * says which earlier step it waits on and its button is held, until that step is done. A host
   * that lists no Assistant offers no quiet link, and "Start a chat" opens New chat to pick an agent.
   */
  import { Button, Steps } from '@lostgradient/cinder';

  import type { ChatReadiness } from '../../app/first-run.ts';
  import { HOME_COPY } from '../../app/copy/home.ts';
  import { router } from '../../lib/router.svelte.ts';
  import type { ChecklistStep } from './home-rows.ts';
  import { newChatAddress } from './home-start-chat.ts';

  interface HomeFirstRunProps {
    /** The three steps, in order, with what each says now. */
    steps: readonly ChecklistStep[];
    /** The Assistant the host lists, or `undefined` when it lists none. */
    assistant: string | undefined;
    /** Whether a chat can work now, or the step it waits on; `undefined` while it is read. */
    readiness: ChatReadiness | undefined;
    /** Called when "Use Assistant" is chosen. */
    onUseAssistant: () => void;
  }

  let { steps, assistant, readiness, onUseAssistant }: HomeFirstRunProps = $props();

  const copy = HOME_COPY.firstRun;
  const headingId = $props.id();
  const chatPath = $derived(assistant === undefined ? '/chats/new' : newChatAddress(assistant));
  // A read that has not answered holds the step as well: the button is offered once it can work.
  const chatWaitsOn = $derived(
    readiness === 'ready' ? undefined : (readiness ?? ('needs-provider' as const)),
  );

  const items = $derived(
    steps.map((step) => ({
      id: step.id,
      label: step.title,
      description:
        step.id === 'chat' && !step.done && chatWaitsOn !== undefined
          ? copy.chat.waiting[chatWaitsOn]
          : step.description,
      done: step.done,
      action: step.id === 'provider' ? provider : step.id === 'agent' ? agent : chat,
    })),
  );
</script>

<section
  class="ib-home-first-run"
  aria-labelledby={headingId}
  data-testid="home-first-run"
  data-chat-waits-on={chatWaitsOn}
>
  <div class="ib-home-first-run__intro">
    <h1 id={headingId} class="ib-home-first-run__title">{copy.title}</h1>
    <p class="ib-home-first-run__lead">{copy.lead}</p>
  </div>
  <Steps variant="checklist" label={copy.title} steps={items} />
</section>

{#snippet provider(state: 'complete' | 'current' | 'upcoming' | 'skipped')}
  {#if state !== 'complete'}
    <Button
      size="sm"
      variant={state === 'current' ? 'primary' : 'secondary'}
      href={router.href(copy.provider.href)}
      label={copy.provider.action}
    />
  {/if}
{/snippet}

{#snippet agent(state: 'complete' | 'current' | 'upcoming' | 'skipped')}
  {#if state !== 'complete'}
    {#if assistant !== undefined}
      <Button
        size="sm"
        variant="ghost-accent"
        type="button"
        onclick={onUseAssistant}
        label={copy.agent.useAssistant}
      />
    {/if}
    <Button
      size="sm"
      variant={state === 'current' ? 'primary' : 'secondary'}
      href={router.href(copy.agent.href)}
      label={copy.agent.action}
    />
  {/if}
{/snippet}

{#snippet chat(state: 'complete' | 'current' | 'upcoming' | 'skipped')}
  {#if state !== 'complete'}
    {#if chatWaitsOn === undefined}
      <Button
        size="sm"
        variant={state === 'current' ? 'primary' : 'secondary'}
        href={router.href(chatPath)}
        label={copy.chat.action}
      />
    {:else}
      <!-- Waiting on an earlier step: held, never an active button, until that step is done. -->
      <Button size="sm" variant="secondary" type="button" disabled label={copy.chat.action} />
    {/if}
  {/if}
{/snippet}

<style>
  /* The page's reading width, centred in the content area at every width (owner, 2026-11-19). */
  .ib-home-first-run {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-6);
    inline-size: 100%;
    max-inline-size: var(--cinder-content-width-reading);
    margin-inline: auto;
    min-inline-size: 0;
  }

  .ib-home-first-run__intro {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--cinder-space-2);
    text-align: center;
  }

  .ib-home-first-run__title {
    margin: 0;
    color: var(--cinder-text-default);
    font-size: var(--cinder-text-page-title);
    font-weight: var(--cinder-font-semibold);
    line-height: var(--cinder-leading-tight);
  }

  .ib-home-first-run__lead {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-base);
  }
</style>
