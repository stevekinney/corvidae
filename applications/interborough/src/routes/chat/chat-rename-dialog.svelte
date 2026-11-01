<script lang="ts">
  /**
   * Gives a chat a title of the person's choosing (`bureau.contexts.rename`). The field starts at
   * the title the header shows; leaving it empty asks for the title taken from the first message
   * again. The Bureau holds the title, so another window can rename the chat while this one is
   * open: a title that arrives under a field nobody has changed is taken, and one that arrives under
   * typed text is not (the typing is kept and the form offers to use the new title instead).
   */
  import { untrack } from 'svelte';

  import { Alert, Button, Input, Modal } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';

  import { CHAT_COPY } from '../../app/copy.ts';
  import { showToast } from '../../app/toast-host.svelte';
  import { renameContext, wireCodeOf } from '../../lib/bureau-client.ts';

  /** The longest title the Bureau stores. */
  const TITLE_LIMIT = 200;

  interface Props {
    sessionId: string;
    /** The title the chat has now, as the Bureau last reported it. */
    current: string;
    onClose: () => void;
  }

  let { sessionId, current, onClose }: Props = $props();

  const copy = CHAT_COPY.more.renameDialog;
  const queryClient = useQueryClient();

  // What the field was last filled from, so a typed title can be told from an untouched one.
  let baseline = $state(untrack(() => current));
  let value = $state(untrack(() => current));
  let changed = $state(false);
  let valueError = $state('');
  let failure = $state('');
  let sending = $state(false);

  $effect(() => {
    const latest = current;
    untrack(() => {
      if (latest === baseline) return;
      if (value === baseline) {
        value = latest;
        baseline = latest;
        changed = false;
      } else {
        changed = true;
      }
    });
  });

  function useNewTitle(): void {
    value = current;
    baseline = current;
    changed = false;
  }

  function close(): void {
    if (!sending) onClose();
  }

  async function submit(): Promise<void> {
    if (sending) return;
    const title = value.trim();
    if (title.length > TITLE_LIMIT) {
      valueError = copy.tooLong;
      return;
    }
    valueError = '';
    failure = '';
    // The title it already has: nothing to send.
    if (title === current.trim()) {
      onClose();
      return;
    }
    sending = true;
    try {
      await renameContext({ contextId: sessionId, title: title === '' ? null : title });
      showToast(copy.renamed, { variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: ['contexts'] });
      sending = false;
      onClose();
    } catch (error) {
      failure = wireCodeOf(error) === 'NotFound' ? copy.notFound : copy.fault;
      sending = false;
    }
  }
</script>

<Modal
  open
  title={copy.title}
  onDismiss={close}
  dismissOnEscape={!sending}
  dismissOnBackdropClick={!sending}
>
  {#snippet children()}
    <form
      class="ib-chat-rename"
      data-testid="chat-rename-form"
      onsubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <Input
        id="chat-rename-title"
        label={copy.label}
        description={copy.description}
        bind:value
        error={valueError}
        disabled={sending}
      />
      {#if changed}
        <Alert variant="warning" data-testid="chat-rename-changed">
          <p class="ib-chat-rename__note">{copy.changed}</p>
          <Button size="sm" variant="secondary" onclick={useNewTitle}>{copy.reload}</Button>
        </Alert>
      {/if}
      {#if failure !== ''}
        <Alert variant="danger" data-testid="chat-rename-failure">
          <p class="ib-chat-rename__note">{failure}</p>
        </Alert>
      {/if}
    </form>
  {/snippet}
  {#snippet footer()}
    <Button variant="secondary" onclick={close} disabled={sending}>{copy.cancel}</Button>
    <Button data-changes variant="primary" onclick={() => void submit()} loading={sending}
      >{copy.save}</Button
    >
  {/snippet}
</Modal>

<style>
  .ib-chat-rename {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-chat-rename__note {
    margin: 0;
    overflow-wrap: anywhere;
  }
</style>
