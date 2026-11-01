<script lang="ts">
  /**
   * The chat header's More menu: rename the chat, branch it from its last reply, export it as a
   * Markdown file, and delete it. It draws the menu and owns the two actions that need a question
   * first, a title for Rename (`chat-rename-dialog.svelte`) and a confirmation for Delete, which
   * names the chat and says what happens to a run that is going. The page owns what Branch and
   * Export need from the conversation, and passes them in.
   */
  import { ConfirmDialog, Dropdown, VisuallyHidden } from '@lostgradient/cinder';
  import { Download, Ellipsis, GitBranch, Pencil, Trash2 } from '@lucide/svelte';
  import { useQueryClient } from '@tanstack/svelte-query';

  import { CHAT_COPY } from '../../app/copy.ts';
  import { showToast } from '../../app/toast-host.svelte';
  import { deleteContext, wireCodeOf, type ContextDeleteReceipt } from '../../lib/bureau-client.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { chatIsGone } from './chat-gone.ts';
  import ChatRenameDialog from './chat-rename-dialog.svelte';

  interface Props {
    sessionId: string;
    /** The title the header shows, which names the chat in the dialogs. */
    title: string;
    /** Whether a run is going, which Branch waits for and Delete stops. */
    runGoing: boolean;
    /** The reply Branch branches from, or `undefined` when the chat has no finished reply. */
    branchTarget: string | undefined;
    /** Whether a branch is being made. */
    branching: boolean;
    /** Whether the chat has anything to export. */
    canExport: boolean;
    onBranch: (messageId: string) => void;
    onExport: () => void;
  }

  let {
    sessionId,
    title,
    runGoing,
    branchTarget,
    branching,
    canExport,
    onBranch,
    onExport,
  }: Props = $props();

  const copy = CHAT_COPY.more;
  const queryClient = useQueryClient();

  let renaming = $state(false);
  let confirmingDelete = $state(false);
  let deleting = $state(false);

  const branchHint = $derived(
    runGoing
      ? copy.branchWhileRunning
      : branchTarget === undefined
        ? copy.noBranchPoint
        : undefined,
  );

  /** A run that was going when the chat was deleted may still be stopping. */
  function settledQuickly(receipt: ContextDeleteReceipt): boolean {
    return receipt === 'applied' || receipt === 'cleaned-up';
  }

  async function deleteChat(): Promise<void> {
    if (deleting) return;
    deleting = true;
    try {
      const receipt = await deleteContext(sessionId);
      if (receipt === 'rejected') {
        showToast(copy.deleteDialog.refused, { variant: 'danger', duration: 0 });
        return;
      }
      showToast(
        settledQuickly(receipt) ? copy.deleteDialog.deleted : copy.deleteDialog.deletedRunning,
        { variant: 'success' },
      );
      leave();
    } catch (error) {
      if (wireCodeOf(error) === 'NotFound') {
        // `NotFound` is also what a caller who may read the chat but not change it is told, so the
        // chat is read again before the page claims it is gone.
        if (await chatIsGone(sessionId)) {
          showToast(copy.deleteDialog.alreadyGone, { variant: 'warning' });
          leave();
        } else {
          showToast(copy.deleteDialog.notAllowed, { variant: 'danger', duration: 0 });
        }
        return;
      }
      showToast(copy.deleteDialog.fault, { variant: 'danger', duration: 0 });
    } finally {
      deleting = false;
    }
  }

  /** The chat no longer exists, so its page is left for the list, and its queries are dropped. */
  function leave(): void {
    queryClient.removeQueries({ queryKey: queryKeys.contexts.detail(sessionId) });
    queryClient.removeQueries({ queryKey: queryKeys.contexts.window(sessionId) });
    void queryClient.invalidateQueries({ queryKey: ['contexts'] });
    void queryClient.invalidateQueries({ queryKey: ['bureau-tasks'] });
    router.navigate('/chats');
  }
</script>

<Dropdown id="ib-chat-actions" placement="bottom-end">
  <Dropdown.Trigger caretVisible={false}>
    <Ellipsis aria-hidden="true" size={16} />
    <VisuallyHidden>{copy.label}</VisuallyHidden>
  </Dropdown.Trigger>
  <Dropdown.Menu>
    <Dropdown.Item data-changes onclick={() => (renaming = true)}>
      <Pencil aria-hidden="true" size={14} />
      {copy.rename}
    </Dropdown.Item>
    <Dropdown.Item
      data-changes
      title={branchHint}
      disabled={branchHint !== undefined || branching}
      onclick={() => {
        if (branchTarget !== undefined) onBranch(branchTarget);
      }}
    >
      <GitBranch aria-hidden="true" size={14} />
      {copy.branch}
    </Dropdown.Item>
    <Dropdown.Item
      title={canExport ? undefined : copy.nothingToExport}
      disabled={!canExport}
      onclick={onExport}
    >
      <Download aria-hidden="true" size={14} />
      {copy.export}
    </Dropdown.Item>
    <Dropdown.Item data-changes variant="danger" onclick={() => (confirmingDelete = true)}>
      <Trash2 aria-hidden="true" size={14} />
      {copy.delete}
    </Dropdown.Item>
  </Dropdown.Menu>
</Dropdown>

{#if renaming}
  <ChatRenameDialog {sessionId} current={title} onClose={() => (renaming = false)} />
{/if}

<ConfirmDialog
  bind:open={confirmingDelete}
  title={copy.deleteDialog.title(title)}
  description={copy.deleteDialog.description(runGoing)}
  confirmLabel={copy.deleteDialog.confirm}
  cancelLabel={copy.deleteDialog.cancel}
  destructive
  onConfirm={() => void deleteChat()}
/>
