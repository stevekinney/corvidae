<script lang="ts">
  /**
   * Where a branch came from, in its conversation's header (inside the title's description, so a phrase and not a paragraph): "Branched from" and a link to the
   * session it was branched from (`parentContextId`). The link names the parent by its title. A
   * parent that has been deleted is a not-found read, and the header says so without a link, since
   * there is nowhere to go. A parent that has not been read yet, or cannot be, is still linked: the
   * link needs only its identifier.
   */
  import { createQuery } from '@tanstack/svelte-query';

  import { CHAT_COPY } from '../../app/copy.ts';
  import { getContext } from '../../lib/bureau-client.ts';
  import { classifyFault } from '../../lib/faults.ts';
  import { chatSessionPath } from '../../lib/identifier-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';

  interface BranchOriginProps {
    /** The session this one was branched from. */
    parentId: string;
  }

  let { parentId }: BranchOriginProps = $props();

  const parent = createQuery(
    () => ({
      queryKey: queryKeys.contexts.detail(parentId),
      queryFn: ({ signal }) => getContext(parentId, { signal }),
      retry: false,
    }),
    undefined,
  );
  const deleted = $derived(parent.isError && classifyFault(parent.error)?.kind === 'not-found');
  const path = $derived(chatSessionPath(parentId));

  function open(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

<span class="weft-chat-header__origin">
  {CHAT_COPY.branch.branchedFrom}
  {#if deleted}
    {CHAT_COPY.branch.parentDeleted}
  {:else}
    <a class="weft-chat-header__origin-link" href={router.href(path)} onclick={open}
      >{parent.data?.title ?? CHAT_COPY.untitled}</a
    >
  {/if}
</span>
