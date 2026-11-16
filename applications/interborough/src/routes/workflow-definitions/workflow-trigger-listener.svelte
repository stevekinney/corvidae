<script lang="ts">
  /**
   * What a workflow file's plugin trigger is doing (COR-2171), under the header of its page: the
   * listener's state as a badge and a sentence (`listening`, `ready`, `standby`,
   * `waiting-for-secret`, `failed` with its code and when it is tried again, `stopped`), Retry now
   * for a failed one, which calls `bureau.workflows.triggers.retry` and shows the state it answers,
   * and, for a kind that receives, the address its deliveries go to with a copy control. Every
   * control is Cinder's.
   */
  import { Alert, Badge, type BadgeVariant, Button, CopyButton } from '@lostgradient/cinder';
  import { createMutation } from '@tanstack/svelte-query';

  import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
  import { clockTime, clockTimeWithSeconds } from '../../lib/format/clock.ts';
  import { retryWorkflowTrigger, type WorkflowListener } from '../../lib/workflow-files.ts';

  interface Props {
    /** The workflow's identifier, which the address ends in. */
    workflowId: string;
    listener: WorkflowListener;
    /**
     * Where deliveries go before the identifier (`/host/paths`' `triggersUrl`), for a kind that
     * receives; `undefined` for one that does not, or while the host has not said.
     */
    triggersUrl?: string | undefined;
    /** The state a retry answered, for the page to keep. */
    onListener: (listener: WorkflowListener) => void;
  }

  let { workflowId, listener, triggersUrl, onListener }: Props = $props();

  const copy = WORKFLOW_COPY.page.listener;

  const VARIANTS: Readonly<Record<WorkflowListener['state'], BadgeVariant>> = {
    listening: 'success',
    ready: 'success',
    standby: 'neutral',
    'waiting-for-secret': 'warning',
    failed: 'danger',
    stopped: 'neutral',
  };

  /** The address a trigger that receives is sent its deliveries at. */
  const address = $derived(
    triggersUrl === undefined ? undefined : `${triggersUrl}${encodeURIComponent(workflowId)}`,
  );

  /**
   * A time as a clock reads it, in the viewer's zone, so it stays true while the page is open; a
   * retry is due within seconds, so its time carries them.
   */
  function at(iso: string): string {
    return clockTime(Date.parse(iso));
  }

  /** The sentence beside the badge. */
  const sentence = $derived.by(() => {
    switch (listener.state) {
      case 'listening':
        return copy.listening(at(listener.since));
      case 'ready':
        return copy.ready(at(listener.since));
      case 'standby':
        return copy.standby;
      case 'waiting-for-secret':
        return copy.waitingForSecret;
      case 'stopped':
        return copy.stopped;
      case 'failed':
        if (listener.code === 'configuration-refused') return copy.configurationRefused;
        return listener.retryAt === null
          ? copy.startFailed
          : copy.startFailedRetrying(clockTimeWithSeconds(Date.parse(listener.retryAt)));
    }
  });

  const retry = createMutation(() => ({
    mutationFn: () => retryWorkflowTrigger(workflowId),
    onSuccess: (next: WorkflowListener) => onListener(next),
  }));
</script>

<section
  class="ib-workflow-trigger"
  aria-label={copy.label}
  data-testid="workflow-trigger-listener"
>
  <p class="ib-workflow-trigger__line" data-state={listener.state}>
    <Badge variant={VARIANTS[listener.state]} size="sm">{copy.states[listener.state]}</Badge>
    <span>{sentence}</span>
    {#if listener.code !== null}
      <span class="ib-workflow-trigger__code"
        >{copy.codeLabel} <code data-testid="workflow-trigger-code">{listener.code}</code></span
      >
    {/if}
    {#if listener.lastFiredAt !== null}
      <span>{copy.lastFired(at(listener.lastFiredAt))}</span>
    {/if}
    {#if listener.state === 'failed'}
      <Button
        data-changes
        variant="secondary"
        size="sm"
        loading={retry.isPending}
        loadingStatus={copy.retrying}
        onclick={() => retry.mutate()}>{copy.retry}</Button
      >
    {/if}
  </p>
  {#if retry.isError}
    <Alert variant="danger">{copy.retryFailed}</Alert>
  {/if}
  {#if address !== undefined}
    <p class="ib-workflow-trigger__line">
      <span>{copy.address}</span>
      <code data-testid="workflow-trigger-address">{address}</code>
      <CopyButton value={address} label={copy.copyAddress} copiedLabel={copy.copiedAddress} />
    </p>
  {/if}
</section>

<style>
  .ib-workflow-trigger {
    display: grid;
    gap: var(--cinder-space-2);
  }

  .ib-workflow-trigger__line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2);
    margin: 0;
    font-size: var(--cinder-text-sm);
  }

  .ib-workflow-trigger__code {
    color: var(--cinder-text-muted);
  }
</style>
