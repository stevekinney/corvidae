<script lang="ts">
  /**
   * Send a signal (`bureau.workflows.signal`), in a dialog the page's "⋯" menu opens. A signal does
   * two things: it is delivered to every running instance waiting at a step of that name, and it
   * starts every workflow whose trigger is a signal of that name. The result says how many of each,
   * and the dialog stays open to say it.
   *
   * The name starts as the workflow's trigger's signal name, or else the first signal a step waits
   * for. The payload is JSON, and empty sends none.
   */
  import { Alert, Button, Input, Modal, Textarea } from '@lostgradient/cinder';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
  import {
    signalWorkflows,
    type SignalResult,
    type WorkflowDocument,
  } from '../../lib/workflow-files.ts';
  import { defaultSignalName } from '../../lib/workflow-catalog.ts';

  interface Props {
    /** The workflow's document, which says what its trigger and its steps name. */
    document: WorkflowDocument | undefined;
    /** Closes the dialog. The page mounts the dialog only while it is open, so a reopened one starts empty. */
    onClose: () => void;
  }

  let { document, onClose }: Props = $props();

  const copy = WORKFLOW_COPY.signal;
  const queryClient = useQueryClient();

  let name = $state(untrack(() => defaultSignalName(document)));
  let payload = $state('');
  let payloadError = $state('');
  let result = $state<SignalResult | undefined>();
  /** Why the last send failed, in the Bureau's words, beside the form. */
  let failure = $state('');

  const send = createMutation(() => ({
    mutationFn: (input: { name: string; payload?: unknown }) => signalWorkflows(input),
    onMutate: () => {
      result = undefined;
      failure = '';
    },
    onError: (error) => {
      failure = error instanceof Error ? error.message : copy.failed;
    },
    onSuccess: (answer) => {
      result = answer;
      // A signal can start a run, so the runs lists are no longer what they were.
      void queryClient.invalidateQueries({ queryKey: ['workflows', 'list'] });
      void queryClient.invalidateQueries({ queryKey: ['workflow-catalog'] });
    },
  }));

  // A payload that was refused is not refused once it changes.
  $effect(() => {
    void payload;
    payloadError = '';
  });

  const canSend = $derived(name.trim() !== '' && !send.isPending);

  function submit(): void {
    if (!canSend) return;
    const text = payload.trim();
    let parsed: unknown;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        payloadError = copy.invalidPayload;
        return;
      }
    }
    payloadError = '';
    send.mutate(
      parsed === undefined ? { name: name.trim() } : { name: name.trim(), payload: parsed },
    );
  }
</script>

<Modal open title={copy.heading} description={copy.description} onDismiss={onClose}>
  {#snippet children()}
    <form
      class="weft-workflow-signal__form"
      data-testid="workflow-signal"
      onsubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <Input id="workflow-signal-name" label={copy.nameLabel} bind:value={name} />
      <Textarea
        id="workflow-signal-payload"
        label={copy.payloadLabel}
        description={copy.payloadDescription}
        variant="code"
        rows={4}
        bind:value={payload}
        error={payloadError}
      />
      {#if failure !== ''}
        <Alert variant="danger">
          <p class="weft-workflow-signal__failure-title">{copy.failed}</p>
          <p class="weft-workflow-signal__failure-message">{failure}</p>
        </Alert>
      {/if}
      {#if result !== undefined}
        <p class="weft-workflow-signal__result" role="status" aria-label={copy.resultLabel}>
          {copy.result(result.started.length, result.delivered.length)}
        </p>
      {/if}
    </form>
  {/snippet}
  {#snippet footer()}
    <Button variant="secondary" onclick={onClose}>{WORKFLOW_COPY.page.menu.closeSignal}</Button>
    <Button data-changes variant="primary" disabled={!canSend} onclick={submit}
      >{copy.sendAction}</Button
    >
  {/snippet}
</Modal>

<style>
  .weft-workflow-signal__form {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .weft-workflow-signal__failure-title,
  .weft-workflow-signal__failure-message {
    margin: 0;
  }

  .weft-workflow-signal__failure-title {
    font-weight: 600;
  }

  .weft-workflow-signal__result {
    margin: 0;
    font-weight: 600;
  }
</style>
