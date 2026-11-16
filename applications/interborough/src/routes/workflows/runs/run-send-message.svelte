<script lang="ts">
  /**
   * The run page's message bar for a chat's run that is going: a "Send a message" field docked at the
   * bottom of the page, which the person uses to add something the agent reads at its next step
   * (`bureau.contexts.input`, steer delivery; COR-2424, row 06b). The page scrolls behind it. Cancel
   * run stays in the header. A run that is waiting on a person, or is over, has no such bar: the
   * question has its own controls, and nothing is left to add to a run that ended.
   */
  import { Button, DockedActionBar, Input } from '@lostgradient/cinder';
  import { SendHorizontal } from '@lucide/svelte';
  import { createMutation } from '@tanstack/svelte-query';

  import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';
  import { showFault, showToast } from '../../../app/toast-host.svelte';
  import { sendContextInput } from '../../../lib/bureau-client.ts';
  import { faultTreatment } from '../../../lib/faults.ts';
  import { newMessageIdentifier } from './run-send-message.ts';

  interface RunSendMessageProps {
    /** The session the run is in, which the message is sent to. */
    contextId: string;
    runId: string;
  }

  let { contextId, runId }: RunSendMessageProps = $props();

  const copy = RUN_DETAIL_COPY.sendMessage;
  // hidden-label-allowed: the bar's placeholder says Send a message, and a docked bar draws no label above its field
  const hiddenLabel = { labelVisible: false } as const;
  let text = $state('');
  // One identifier for each message written: sending it again after a failure that may have reached
  // the Bureau is the same input, and a new message after a success is a new one.
  let messageId = $state(newMessageIdentifier());

  const send = createMutation(() => ({
    mutationFn: (message: string) =>
      sendContextInput(contextId, { id: messageId, payload: message }),
    onSuccess: () => {
      text = '';
      attempted = undefined;
      messageId = newMessageIdentifier();
      showToast(copy.sent);
    },
    onError: (error: unknown) =>
      showFault({
        ...faultTreatment(error),
        message: `${copy.failed}. ${faultTreatment(error).message}`,
      }),
  }));

  const message = $derived(text.trim());

  // What the last attempt sent, kept while it may not have gone through: the same words are the
  // same input; other words are another one, which the Bureau would refuse under the old identifier.
  let attempted: string | undefined;

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (message === '' || send.isPending) return;
    if (attempted !== message) messageId = newMessageIdentifier();
    attempted = message;
    send.mutate(message);
  }
</script>

<form data-testid="run-send-message" onsubmit={submit}>
  <DockedActionBar label={copy.label} variant="card">
    <Input
      id={`run-send-message-${runId}`}
      bind:value={text}
      label={copy.field}
      {...hiddenLabel}
      placeholder={copy.field}
      autocomplete="off"
    />
    {#snippet actions()}
      <Button
        type="submit"
        variant="primary"
        label={copy.send}
        loading={send.isPending}
        disabled={message === ''}
      >
        {#snippet leadingIcon()}<SendHorizontal aria-hidden="true" size={16} />{/snippet}
      </Button>
    {/snippet}
  </DockedActionBar>
</form>
