<script lang="ts">
  /**
   * The line a fresh Interborough's chat welcome adds under its New chat link: "Agents:" and the
   * identifier of each agent a chat can start with, in monospace, from the Bureau's own list
   * (`bureau.agents.list`). It says nothing until the Bureau has answered, and
   * nothing when there is no agent to name, so a failed read never claims there are none.
   */
  import { createQuery } from '@tanstack/svelte-query';

  import { listAgents } from '../lib/bureau-client.ts';
  import { keyedByOccurrence } from '../lib/list-keys.ts';
  import { queryKeys } from '../lib/query.ts';
  import { CHAT_COPY } from './copy.ts';

  const agents = createQuery(
    () => ({
      queryKey: queryKeys.agents.list(),
      queryFn: ({ signal }) => listAgents({ signal }),
      retry: false,
    }),
    undefined,
  );
  const named = $derived(keyedByOccurrence(agents.data ?? [], (agent) => agent.name));
</script>

{#if named.length > 0}
  <div class="ib-welcome-agents" data-testid="welcome-agents">
    <span>{CHAT_COPY.newChatWelcome.agentsLine}</span>
    <ul class="ib-welcome-agents__list">
      {#each named as { key, item: agent } (key)}
        <li><code class="ib-identifier">{agent.name}</code></li>
      {/each}
    </ul>
  </div>
{/if}
