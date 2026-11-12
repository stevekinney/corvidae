<script lang="ts">
  /**
   * Adding a memory, for the whole Memory page: the header and the empty state both open it
   * (`ask`), so the form, the server's refusals, and the draft exist once. The dialog says whose
   * memory it is ("Tool runner reads this in every chat"), takes the words and a kind, Fact or
   * How-to, and keeps Add memory enabled: pressing it with nothing written saves nothing, says
   * what to write at the field, and focuses it. A save shows a toast with Undo, which forgets the
   * memory just added; the toast stays until it is acted on or the page is left.
   *
   * The draft outlives everything but its own success. A refusal is reported in the dialog with the
   * words still in the field, and closing the dialog keeps them for the next time it opens. A save
   * still running when the dialog is closed reopens it if it fails, because a refusal nobody can
   * see would read as a memory that was added. The form starts from nothing the server holds, so no
   * refetch has anything to overwrite in it.
   *
   * Text the content rules flag is stored by the Bureau, quarantined, where no list shows it. The
   * dialog says so and offers to remove that copy, and removal is the default way out: saving again,
   * cancelling and closing all remove it first, so a reworded retry never leaves a second copy.
   */
  import { onDestroy, tick } from 'svelte';

  import { Alert, Button, Modal, RadioGroup, Textarea } from '@lostgradient/cinder';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';

  import { MEMORY_COPY } from '../../app/copy/memory.ts';
  import { dismissToast, hasToastHost, showToast } from '../../app/toast-host.svelte';
  import {
    forgetMemory,
    memoryFaultOf,
    rememberMemory,
    type Memory,
    type MemoryFault,
    type MemoryKind,
  } from '../../lib/memory-client.ts';
  import { memoryListingsFilter } from '../../lib/query.ts';
  import { addRefusalWords } from './memory-presentation.ts';

  type Props = {
    agentId: string;
    /** What the agent is called, in the dialog's words and the toast's ("Tool runner reads this"). */
    agentName: string;
    /** Called once the memory is saved, with the memory as the list shows it. */
    onAdded: (memory: Memory) => void;
    /** Called once Undo forgot a memory this added, so the page can close its details. */
    onUndone: (id: string) => void;
  };

  let { agentId, agentName, onAdded, onUndone }: Props = $props();

  const words = MEMORY_COPY.add;
  const queryClient = useQueryClient();

  /** Whether a toast has somewhere to be shown: the shell mounts the host, a view on its own may not. */
  const toasts = hasToastHost();

  let open = $state(false);
  let draft = $state('');
  /** The radio group's value, which is any string; `kind` is what it names. */
  let kindChoice = $state('fact');
  const kind = $derived<MemoryKind>(kindChoice === 'how-to' ? 'how-to' : 'fact');
  /** Whether Add memory was pressed with nothing written, which says what to write at the field. */
  let attempted = $state(false);
  let failure = $state<MemoryFault | undefined>(undefined);
  /** The identifier of the quarantined copy the last add left stored, until it is removed. */
  let heldId = $state<string | undefined>(undefined);
  let heldNotRemoved = $state(false);

  /** Removes the held copy; it is `heldId` that says whether one is still stored. */
  async function removeHeld(id: string): Promise<void> {
    const forgotten = await forgetMemory(agentId, id);
    if (forgotten.deletion !== 'completed') throw new Error('The held copy was not removed.');
    if (heldId === id) heldId = undefined;
  }

  const release = createMutation(() => ({
    mutationFn: removeHeld,
    onSuccess: () => {
      heldNotRemoved = false;
    },
    onError: () => {
      heldNotRemoved = true;
      open = true;
    },
  }));

  /** The toasts this page showed, so leaving it takes their Undo with it. */
  const shownToasts: string[] = [];
  onDestroy(() => {
    for (const id of shownToasts) dismissToast(id);
  });

  /** Undo on the toast: forgets the memory that was just added, and says when it could not. */
  async function undoAdd(id: string): Promise<void> {
    try {
      const forgotten = await forgetMemory(agentId, id);
      if (forgotten.deletion !== 'completed') throw new Error('The memory was not removed.');
      void queryClient.invalidateQueries(memoryListingsFilter(agentId));
      onUndone(id);
    } catch {
      showToast(words.undoFailed, { variant: 'danger' });
    }
  }

  const remember = createMutation(() => ({
    mutationFn: async (change: { readonly content: string; readonly kind: MemoryKind }) => {
      // A reworded retry would otherwise leave a second quarantined copy behind.
      if (heldId !== undefined) await removeHeld(heldId);
      return rememberMemory(agentId, change.content, change.kind);
    },
    onSuccess: (result, change) => {
      if (result.outcome === 'held') {
        heldId = result.id;
        heldNotRemoved = false;
        open = true;
        return;
      }
      open = false;
      // Words typed while it was being saved are a new draft, not the memory that was saved.
      if (draft === change.content) {
        draft = '';
        kindChoice = 'fact';
      }
      void queryClient.invalidateQueries(memoryListingsFilter(agentId));
      onAdded(result.memory);
      if (toasts) {
        const added = result.memory.id;
        const toast = showToast(words.saved(agentName), {
          variant: 'success',
          undo: () => void undoAdd(added),
        });
        if (toast !== undefined) shownToasts.push(toast);
      }
    },
    onError: (error) => {
      failure = memoryFaultOf(error);
      open = true;
    },
  }));

  // Closing the dialog, by Cancel, Escape or the close button, forgets what it held back.
  $effect(() => {
    if (!open && heldId !== undefined && !release.isPending && !remember.isPending) {
      release.mutate(heldId);
    }
  });

  /** Opens the form, with any draft still in it and the last refusal gone. */
  export function ask(): void {
    if (!remember.isPending) failure = undefined;
    heldNotRemoved = false;
    attempted = false;
    open = true;
  }

  /** Moves focus to the field, once the message a submit shows is on the page. */
  async function focusField(): Promise<void> {
    await tick();
    document.getElementById('ib-memory-add')?.focus();
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (remember.isPending) return;
    // Nothing written saves nothing: the field says what to write, and takes focus.
    if (draft.trim() === '') {
      attempted = true;
      void focusField();
      return;
    }
    failure = undefined;
    heldNotRemoved = false;
    remember.mutate({ content: draft, kind });
  }

  const refusal = $derived(failure === undefined ? undefined : addRefusalWords(failure));
  const missing = $derived(attempted && draft.trim() === '');
</script>

<Modal bind:open title={words.dialog.title}>
  <form class="ib-memory-add__form" onsubmit={submit}>
    <p class="ib-memory-add__body">{words.dialog.description(agentName)}</p>
    {#if heldId !== undefined}
      <Alert variant="warning" data-add-held>
        <p class="ib-memory-add__title">{words.held.title}</p>
        <p class="ib-memory-add__body">{words.held.description}</p>
        <Button
          variant="primary"
          data-changes
          disabled={release.isPending || remember.isPending}
          onclick={() => heldId !== undefined && release.mutate(heldId)}
          >{release.isPending ? words.held.removing : words.held.remove}</Button
        >
      </Alert>
    {/if}
    {#if heldNotRemoved}
      <Alert variant="danger" dismissible onDismiss={() => (heldNotRemoved = false)}>
        <p class="ib-memory-add__title">{words.held.notRemoved.title}</p>
        <p class="ib-memory-add__body">{words.held.notRemoved.description}</p>
      </Alert>
    {/if}
    <Textarea
      id="ib-memory-add"
      label={words.dialog.label(agentName)}
      description={words.dialog.hint}
      error={missing ? words.dialog.empty(agentName) : ''}
      rows={6}
      bind:value={draft}
    />
    <RadioGroup name="ib-memory-kind" label={words.dialog.kind.label} bind:value={kindChoice}>
      <RadioGroup.Option id="ib-memory-kind-fact" value="fact" label={words.dialog.kind.fact} />
      <RadioGroup.Option
        id="ib-memory-kind-how-to"
        value="how-to"
        label={words.dialog.kind.howTo}
      />
    </RadioGroup>
    {#if refusal !== undefined && failure !== undefined}
      <Alert variant="danger">
        <p class="ib-memory-add__title" data-add-refusal={failure.kind}>{refusal.title}</p>
        {#if refusal.description !== ''}
          <p class="ib-memory-add__body">{refusal.description}</p>
        {/if}
      </Alert>
    {/if}
    <div class="ib-memory-add__actions">
      <Button variant="secondary" onclick={() => (open = false)}>{words.dialog.cancel}</Button>
      <Button type="submit" variant="primary" disabled={remember.isPending}
        >{failure === undefined ? words.dialog.submit : words.dialog.retry}</Button
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
