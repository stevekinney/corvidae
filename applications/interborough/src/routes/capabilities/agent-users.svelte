<script lang="ts">
  /**
   * The agents that use a capability, each a link to its page. An empty list is Cinder's one empty
   * state with the one action that fills it, alone: no "Used by" heading above it saying the same
   * thing (owner report, 2026-11-19).
   */
  import { EmptyState, SectionHeading } from '@lostgradient/cinder';
  import { Bot } from '@lucide/svelte';

  import { agentPath } from '../../lib/agent-paths.ts';
  import { router } from '../../lib/router.svelte.ts';

  /** The action that fills an empty list: a label and where it goes. */
  type EmptyAction = { readonly label: string; readonly href: string };

  interface Props {
    /** The heading over the list. */
    heading: string;
    /** The identifiers of the agents that use the capability. */
    users: readonly string[];
    /** What an empty list says, and the action that fills it. */
    empty: {
      readonly title: string;
      readonly description: string;
      readonly action: EmptyAction;
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
  {#if users.length === 0}
    <EmptyState
      kind="first-use"
      headingLevel={4}
      title={empty.title}
      description={empty.description}
      actions={[
        {
          label: empty.action.label,
          href: router.href(empty.action.href),
          onclick: (event) => go(event, empty.action.href),
        },
      ]}
      data-testid="capability-users-empty"
    >
      {#snippet icon()}<Bot aria-hidden="true" />{/snippet}
    </EmptyState>
  {:else}
    <SectionHeading level={4} title={heading} />
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
