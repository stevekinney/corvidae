<script lang="ts">
  /**
   * Adding a memory, for the whole Memory page: the header and the empty state both open it
   * (`ask`), so the form, the server's refusals, and the draft exist once.
   *
   * The draft outlives everything but its own success. A refusal is reported in the dialog with the
   * words still in the field, and closing the dialog keeps them for the next time it opens. A save
   * still running when the dialog is closed reopens it if it fails, because a refusal nobody can
   * see would read as a memory that was added. The form starts from nothing the server holds, so no
   * refetch has anything to overwrite in it.
   */
  import { Alert, Button, Modal, Textarea } from '@lostgradient/cinder';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';

  import { MEMORY_COPY } from '../../app/copy.ts';
  import {
    memoryFaultOf,
    rememberMemory,
    type Memory,
    type MemoryFault,
  } from '../../lib/memory-client.ts';
  import { memoryListingsFilter } from '../../lib/query.ts';
  import { addRefusalWords } from './memory-presentation.ts';

  type Props = {
    agentId: string;
    /** Called once the memory is saved, with the memory as the list shows it. */
    onAdded: (memory: Memory) => void;
  };

  let { agentId, onAdded }: Props = $props();

  const words = MEMORY_COPY.add;
  const queryClient = useQueryClient();

  let open = $state(false);
  let draft = $state('');
  let failure = $state<MemoryFault | undefined>(undefined);

  const remember = createMutation(() => ({
    mutationFn: (content: string) => rememberMemory(agentId, content),
    onSuccess: (result, content) => {
      open = false;
      // Words typed while it was being saved are a new draft, not the memory that was saved.
      if (draft === content) draft = '';
      void queryClient.invalidateQueries(memoryListingsFilter(agentId));
      onAdded(result.memory);
    },
    onError: (error) => {
      failure = memoryFaultOf(error);
      open = true;
    },
  }));

  /** Opens the form, with any draft still in it and the last refusal gone. */
  export function ask(): void {
    if (!remember.isPending) failure = undefined;
    open = true;
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (remember.isPending || draft.trim() === '') return;
    failure = undefined;
    remember.mutate(draft);
  }

  const refusal = $derived(failure === undefined ? undefined : addRefusalWords(failure));
</script>

<Modal bind:open title={words.dialog.title}>
  <form class="ib-memory-add__form" onsubmit={submit}>
    <p class="ib-memory-add__body">{words.dialog.description}</p>
    {#if refusal !== undefined && failure !== undefined}
      <Alert variant="danger" dismissible onDismiss={() => (failure = undefined)}>
        <p class="ib-memory-add__title" data-add-refusal={failure.kind}>{refusal.title}</p>
        {#if refusal.description !== ''}
          <p class="ib-memory-add__body">{refusal.description}</p>
        {/if}
      </Alert>
    {/if}
    <Textarea id="ib-memory-add" label={words.dialog.label} rows={6} bind:value={draft} />
    <div class="ib-memory-add__actions">
      <Button variant="secondary" onclick={() => (open = false)}>{words.dialog.cancel}</Button>
      <Button type="submit" variant="primary" disabled={remember.isPending || draft.trim() === ''}
        >{words.dialog.submit}</Button
      >
    </div>
  </form>
</Modal>

<style>
  .ib-memory-add__form {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
  }

  .ib-memory-add__actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--cinder-space-2);
  }

  .ib-memory-add__title {
    margin: 0;
    font-weight: 600;
  }

  .ib-memory-add__body {
    margin: var(--cinder-space-1) 0;
  }
</style>
