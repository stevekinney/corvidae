<script lang="ts">
  /**
   * The agents that use a capability, each a link to its page. An empty list is a compact empty
   * state with the one action that fills it, never a word standing in for nothing.
   */
  import { Button, EmptyState, SectionHeading } from '@lostgradient/cinder';

  import { agentPath } from '../../lib/agent-paths.ts';
  import { router } from '../../lib/router.svelte.ts';

  interface Props {
    /** The heading over the list. */
    heading: string;
    /** The identifiers of the agents that use the capability. */
    users: readonly string[];
    /** What an empty list says, and the action that fills it. */
    empty: {
      readonly title: string;
      readonly description: string;
      readonly action: { readonly label: string; readonly href: string };
    };
  }

  let { heading, users, empty }: Props = $props();

  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<section class="ib-capability__section" data-testid="capability-users">
  <SectionHeading level={3} title={heading} />
  {#if users.length === 0}
    <EmptyState
      kind="first-use"
      size="compact"
      headingLevel={4}
      title={empty.title}
      description={empty.description}
    >
      {#snippet action()}
        <Button
          href={router.href(empty.action.href)}
          variant="secondary"
          size="sm"
          onclick={(event) => go(event, empty.action.href)}>{empty.action.label}</Button
        >
      {/snippet}
    </EmptyState>
  {:else}
    <ul class="ib-capability__users">
      {#each users as user (user)}
        <li>
          <a
            class="ib-capability__identifier"
            href={router.href(agentPath(user))}
            onclick={(event) => go(event, agentPath(user))}>{user}</a
          >
        </li>
      {/each}
    </ul>
  {/if}
</section>
