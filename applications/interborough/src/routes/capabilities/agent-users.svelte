<script lang="ts">
  /**
   * The agents that use a capability, each a link to its page. An empty list says so in one of two
   * ways: a compact empty state with the one action that fills it (a skill), or one muted line with
   * the action as an inline link (a tool, design rows 30e and 32j), never a centred empty state.
   */
  import { Button, EmptyState, Link, SectionHeading } from '@lostgradient/cinder';

  import { createQuery } from '@tanstack/svelte-query';

  import { agentLabel } from '../../lib/agent-label.ts';
  import { agentPath } from '../../lib/agent-paths.ts';
  import { agentsListQuery } from '../../lib/agent-queries.ts';
  import { router } from '../../lib/router.svelte.ts';

  /** The action that fills an empty list: a label and where it goes. */
  type EmptyAction = { readonly label: string; readonly href: string };

  interface Props {
    /** The heading over the list. */
    heading: string;
    /** The identifiers of the agents that use the capability. */
    users: readonly string[];
    /** What sits muted beside an agent's link (its asks level on a tool); nothing when absent. */
    note?: ((user: string) => string) | undefined;
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
      | { readonly line: string; readonly action?: EmptyAction | undefined };
  }

  let { heading, users, note, empty }: Props = $props();

  // The names the Agents list shows, from the same query and helper the shell's bell and the search
  // palette use; an agent the list does not hold reads as its identifier in words.
  const agents = createQuery(agentsListQuery, undefined);

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
        {#if empty.action !== undefined}
          {@const action = empty.action}
          <!-- In a line of text, so underlined: colour alone does not mark it (axe link-in-text-block). -->
          <Link
            underline="always"
            href={router.href(action.href)}
            onclick={(event) => go(event, action.href)}>{action.label}</Link
          >
        {/if}
      </p>
    {:else}
      <EmptyState
        kind="first-use"
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
          <!-- The agent's name as the Agents list shows it ("Workflow author"), never its identifier. -->
          <Link
            href={router.href(agentPath(user))}
            onclick={(event) => go(event, agentPath(user))}
            data-agent={user}>{agentLabel(user, agents.data)}</Link
          >
          {#if note !== undefined}
            <span class="ib-capability__user-note" data-testid="capability-user-note"
              >{note(user)}</span
            >
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
