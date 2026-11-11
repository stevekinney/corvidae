<script lang="ts">
  /**
   * The agents that use a capability, each a link to its page. An empty list says so in one of two
   * ways: a compact empty state with the one action that fills it (a skill), or one muted line with
   * the action as an inline link (a tool, design rows 30e and 32j), never a centred empty state.
   */
  import { Button, EmptyState, Link, SectionHeading } from '@lostgradient/cinder';

  import { agentPath } from '../../lib/agent-paths.ts';
  import { router } from '../../lib/router.svelte.ts';

  /** The action that fills an empty list: a label and where it goes. */
  type EmptyAction = { readonly label: string; readonly href: string };

  interface Props {
    /** The heading over the list. */
    heading: string;
    /** The identifiers of the agents that use the capability. */
    users: readonly string[];
    /**
     * What an empty list says, and the action that fills it: a `title` and `description` draw a
     * compact empty state, and a `line` draws one muted line with the action inline.
     */
    empty:
      | {
          readonly title: string;
          readonly description: string;
          readonly action: EmptyAction;
        }
      | { readonly line: string; readonly action: EmptyAction };
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
  <SectionHeading level={4} title={heading} />
  {#if users.length === 0}
    {#if 'line' in empty}
      <p class="ib-capability__line" data-testid="capability-users-empty">
        {empty.line}
        <Link
          href={router.href(empty.action.href)}
          onclick={(event) => go(event, empty.action.href)}>{empty.action.label}</Link
        >
      </p>
    {:else}
      <EmptyState
        kind="first-use"
        size="compact"
        headingLevel={5}
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
    {/if}
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
