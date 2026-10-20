<script lang="ts">
  /**
   * A task's session in the list: a link to its chat, shown only when the Bureau has that session.
   * A task the Bureau started with `bureau.run()` has no session, and its `contextId` is its run
   * handle, so a link to `/chat/:contextId` would open a chat that is not there. The answer is
   * cached by identifier, so rows of one session ask once.
   */
  import { createQuery } from '@tanstack/svelte-query';

  import { getContext } from '../../lib/bureau-client.ts';
  import { truncateId } from '../../lib/format/index.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';

  interface TaskSessionProps {
    contextId: string;
  }

  let { contextId }: TaskSessionProps = $props();

  const session = createQuery(
    () => ({
      queryKey: queryKeys.contexts.detail(contextId),
      queryFn: ({ signal }) => getContext(contextId, { signal }),
      retry: false,
    }),
    undefined,
  );

  function open(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(`/chat/${encodeURIComponent(contextId)}`);
  }
</script>

{#if session.isSuccess}
  <a
    class="weft-tasks__link"
    href={router.href(`/chat/${encodeURIComponent(contextId)}`)}
    onclick={open}><code title={contextId}>{truncateId(contextId)}</code></a
  >
{/if}
