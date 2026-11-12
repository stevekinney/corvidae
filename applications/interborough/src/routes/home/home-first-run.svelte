<script lang="ts">
  /**
   * Home's first-run checklist, "Get started": three steps in Cinder's `checklist` Steps, with how
   * many are done at the right of the title. Connect a provider, create an agent or start from
   * Assistant, say hello. The steps are done in any order, and the first one that is not done is the
   * current one, which is the only step with a primary button; the rest have a secondary one. Step 2
   * has a quiet "Use Assistant" beside its button, which takes Assistant (scripted, needing no
   * provider) as the agent to start from. Step 3's "Start a chat" is live from the first moment: it
   * opens New chat with Assistant, because Assistant needs no provider. A host that lists no
   * Assistant (it comes from a plugin or the host, and a fresh host has neither) offers neither: the
   * quiet link is not drawn and "Start a chat" opens New chat to pick an agent.
   *
   * The checklist stands in for the provider notice while it shows, so no banner says it again.
   */
  import { Button, Steps } from '@lostgradient/cinder';

  import { HOME_COPY } from '../../app/copy/home.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { openInApplication } from './home-navigation.ts';
  import type { ChecklistStep } from './home-rows.ts';
  import { newChatAddress } from './home-start-chat.ts';

  interface HomeFirstRunProps {
    /** The three steps, in order, with what each says now. */
    steps: readonly ChecklistStep[];
    /** The Assistant the host lists, or `undefined` when it lists none. */
    assistant: string | undefined;
    /** Called when "Use Assistant" is chosen. */
    onUseAssistant: () => void;
  }

  let { steps, assistant, onUseAssistant }: HomeFirstRunProps = $props();

  const copy = HOME_COPY.firstRun;
  const chatPath = $derived(assistant === undefined ? '/chats/new' : newChatAddress(assistant));

  const items = $derived(
    steps.map((step) => ({
      id: step.id,
      label: step.title,
      description: step.description,
      done: step.done,
      action: step.id === 'provider' ? provider : step.id === 'agent' ? agent : chat,
    })),
  );
</script>

<Steps
  variant="checklist"
  heading={copy.title}
  headingLevel={2}
  steps={items}
  data-testid="home-first-run"
/>

{#snippet provider(state: 'complete' | 'current' | 'upcoming' | 'skipped')}
  {#if state !== 'complete'}
    <Button
      size="sm"
      variant={state === 'current' ? 'primary' : 'secondary'}
      href={router.href(copy.provider.href)}
      onclick={(event) => openInApplication(event, copy.provider.href)}
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
      onclick={(event) => openInApplication(event, copy.agent.href)}
      label={copy.agent.action}
    />
  {/if}
{/snippet}

{#snippet chat(state: 'complete' | 'current' | 'upcoming' | 'skipped')}
  {#if state !== 'complete'}
    <Button
      size="sm"
      variant={state === 'current' ? 'primary' : 'secondary'}
      href={router.href(chatPath)}
      onclick={(event) => openInApplication(event, chatPath)}
      label={copy.chat.action}
    />
  {/if}
{/snippet}
