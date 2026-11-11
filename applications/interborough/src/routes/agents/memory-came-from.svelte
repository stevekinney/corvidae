<script lang="ts">
  /**
   * The value of a memory's Came from row (board PageMemory): the chat that produced it, as a link
   * named by the chat's title (`Chat “Where is order 4398?”`). The row is drawn only for a memory
   * someone other than you wrote, so a memory with no chat on record says so. A chat the Bureau no
   * longer has is "A chat that was deleted", in muted text where the link was, and the memory
   * itself stays. A chat that could not be read for any other reason keeps its link, named plainly,
   * because the chat may still be there.
   */
  import { Skeleton } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { MEMORY_COPY } from '../../app/copy.ts';
  import { getContext } from '../../lib/bureau-client.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { memoryFaultOf } from '../../lib/memory-client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';

  type Props = {
    /** The chat that produced the memory, or `null` for a memory no chat is on record for. */
    sessionId: string | null;
  };

  let { sessionId }: Props = $props();

  const copy = MEMORY_COPY.detail.cameFrom;

  const chat = createQuery(
    () => ({
      queryKey: queryKeys.contexts.detail(sessionId ?? ''),
      queryFn: ({ signal }) => getContext(sessionId ?? '', { signal }),
      enabled: sessionId !== null,
      retry: false,
    }),
    undefined,
  );

  const deleted = $derived(chat.isError && memoryFaultOf(chat.error).kind === 'not-found');
  const path = $derived(sessionId === null ? '' : chatSessionPath(sessionId));
  const label = $derived(
    chat.data === undefined
      ? copy.openChat
      : copy.chat(
          chat.data.title === null || chat.data.title === '' ? copy.untitled : chat.data.title,
        ),
  );

  /** Follows a link inside the app's router, unless the click asks for a new tab or window. */
  function follow(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

{#if sessionId === null}
  <span class="ib-memory-came-from__muted" data-came-from="none">{copy.notRecorded}</span>
{:else if chat.isPending}
  <Skeleton height="1rem" width="10rem" />
{:else if deleted}
  <span class="ib-memory-came-from__muted" data-came-from="deleted">{copy.deleted}</span>
{:else}
  <a href={router.href(path)} onclick={follow} data-came-from="chat">{label}</a>
{/if}

<style>
  .ib-memory-came-from__muted {
    color: var(--cinder-text-muted);
  }
</style>
