<script lang="ts">
  /**
   * What a workflow file's plugin trigger is doing (COR-2171), under its "Starts" line: the status
   * as a dot and a word, as the header shows a workflow's own status, and the words after it that
   * the word does not say (`listening`, `ready`, `standby`, `waiting-for-secret`, `failed` with when
   * it is tried again, `stopped`). A failed trigger offers Retry now, which calls
   * `bureau.workflows.triggers.retry` and shows the state it answers, and a refused configuration
   * offers Edit instead. A kind that receives shows the address its deliveries go to, which wraps
   * with its copy control. Every control is Cinder's.
   */
  import { Button, CopyableValue, Link, StatusDot } from '@lostgradient/cinder';
  import { createMutation } from '@tanstack/svelte-query';

  import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
  import { faultTreatment } from '../../lib/faults.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { retryWorkflowTrigger, type WorkflowListener } from '../../lib/workflow-files.ts';
  import { nextTryClockPeriod, triggerStatus } from './workflow-trigger-presentation.ts';

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
    /** Whether the plugin trigger kinds have loaded, so `triggersUrl` says all there is to say. */
    kindsLoaded?: boolean;
    /** The title of the plugin the trigger belongs to ("GitHub"), or `undefined` until the host has said. */
    pluginTitle?: string | undefined;
    /** Where the file is edited, when the person may edit it: a refused configuration leads there. */
    editPath?: string | undefined;
  }

  let {
    workflowId,
    listener,
    triggersUrl,
    onListener,
    kindsLoaded = false,
    pluginTitle,
    editPath,
  }: Props = $props();

  const copy = WORKFLOW_COPY.page.listener;
  /** Where a plugin's secret is added. */
  const SETTINGS_PATH = '/settings/plugins';

  /** The address a trigger that receives is sent its deliveries at. */
  const address = $derived(
    triggersUrl === undefined ? undefined : `${triggersUrl}${encodeURIComponent(workflowId)}`,
  );

  // The clock the next try is counted to: each second in its last minute and a half, and each half
  // minute before, so "Next try in 59 minutes" stays true while the page is open. It is read again
  // when the listener changes, such as after a retry.
  let now = $state(Date.now());
  $effect(() => {
    void listener;
    now = Date.now();
  });
  const period = $derived(nextTryClockPeriod(listener, now));
  $effect(() => {
    if (period === null) return;
    // poll-reason: clock
    const timer = setInterval(() => {
      now = Date.now();
    }, period);
    return () => clearInterval(timer);
  });

  const status = $derived(triggerStatus(listener, { now, pluginTitle }));

  /** Opens a link in place, and leaves a modified click to the browser. */
  function go(event: MouseEvent, target: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(target);
  }

  // A failed retry is said once, here beside the control: this `onError` replaces the query
  // client's default, which would also raise a toast.
  let retryFailure = $state<string | null>(null);
  const retry = createMutation(() => ({
    mutationFn: () => retryWorkflowTrigger(workflowId),
    onMutate: () => {
      retryFailure = null;
    },
    onSuccess: (next: WorkflowListener) => onListener(next),
    onError: (error: unknown) => {
      retryFailure =
        faultTreatment(error).kind === 'unauthorized' ? copy.retryForbidden : copy.retryFailed;
    },
  }));
</script>

<section
  class="ib-workflow-trigger"
  aria-label={copy.label}
  data-testid="workflow-trigger-listener"
  data-kinds={kindsLoaded ? 'loaded' : 'loading'}
>
  <!-- The line is drawn as the header's lines are: inline parts, muted, wrapping as prose does. -->
  <p class="ib-workflow__line" data-state={listener.state}>
    <StatusDot word={status.word} size="sm" />{status.text}{#if status.settings !== null}<Link
        href={router.href(SETTINGS_PATH)}
        onclick={(event) => go(event, SETTINGS_PATH)}>{status.settings.link}</Link
      >{status.settings.after}{/if}{#if status.lastStarted !== null}{' '}{status.lastStarted}{/if}
    {#if status.canRetry}
      <Button
        data-changes
        class="ib-workflow-trigger__action"
        variant="secondary"
        size="xs"
        loading={retry.isPending}
        loadingStatus={copy.retrying}
        onclick={() => retry.mutate()}
        label={copy.retry}
      />
    {:else if status.canEdit && editPath !== undefined}
      {@const target = editPath}
      <Button
        data-changes
        class="ib-workflow-trigger__action"
        variant="secondary"
        size="xs"
        href={router.href(target)}
        onclick={(event) => go(event, target)}
        label={copy.edit}
      />
    {/if}
    {#if retryFailure !== null}
      <span class="ib-workflow-trigger__failure" role="alert" data-testid="workflow-trigger-failure"
        >{retryFailure}</span
      >
    {/if}
    {#if status.code !== null}
      <!-- The code goes last, as quiet as the line around it. -->
      <span data-testid="workflow-trigger-code-note"
        >({copy.code} <code data-testid="workflow-trigger-code">{status.code}</code>)</span
      >
    {/if}
  </p>
  {#if address !== undefined}
    <p class="ib-workflow__line">
      {copy.address}
      <CopyableValue
        data-testid="workflow-trigger-address"
        value={address}
        label={copy.copyAddress}
        copiedLabel={copy.copiedAddress}
      />
    </p>
  {/if}
</section>

<style>
  .ib-workflow-trigger {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    min-width: 0;
  }

  /* A control inside the line sits on the text's own line, with a little room from the words. */
  .ib-workflow-trigger :global(.ib-workflow-trigger__action) {
    margin-inline: var(--cinder-space-1);
    vertical-align: middle;
  }

  .ib-workflow-trigger__failure {
    color: var(--cinder-status-danger-text);
  }
</style>
