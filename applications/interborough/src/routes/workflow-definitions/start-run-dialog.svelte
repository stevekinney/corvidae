<script lang="ts">
  /**
   * Start a run of one agent-authored workflow (`bureau.workflows.start`). The input is JSON, and
   * empty starts the run with none. The Bureau checks the input against the file's `inputSchema`
   * before it creates anything, so an input that breaks it is refused here in the Bureau's words and
   * no run exists. A run that starts takes the person to it.
   */
  import { Alert, Button, Modal, Textarea } from '@lostgradient/cinder';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';

  import { WORKFLOW_COPY } from '../../app/copy.ts';
  import { agentFaultOf } from '../../lib/agent-definitions.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router, workflowRunPath } from '../../lib/router.svelte.ts';
  import { startWorkflowFile } from '../../lib/workflow-files.ts';

  interface Props {
    /** The workflow's identifier, which is its file's. */
    type: string;
    /** Whether the dialog is showing. */
    open: boolean;
  }

  let { type, open = $bindable() }: Props = $props();

  const copy = WORKFLOW_COPY.startDialog;
  const queryClient = useQueryClient();

  let input = $state('');
  let inputError = $state('');
  /** Why the last start failed, in the Bureau's words. */
  let failure = $state('');

  const start = createMutation(() => ({
    mutationFn: (value: unknown) => startWorkflowFile(type, value),
    onMutate: () => {
      failure = '';
    },
    onError: (error) => {
      const fault = agentFaultOf(error);
      failure = fault.kind === 'rejected' || fault.kind === 'other' ? fault.message : copy.failed;
    },
    onSuccess: (result) => {
      open = false;
      input = '';
      void queryClient.invalidateQueries({ queryKey: ['workflow-catalog'] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflowCatalog.list() });
      router.navigate(workflowRunPath(type, result.runId));
    },
  }));

  // An input that was refused is not refused once it changes.
  $effect(() => {
    void input;
    inputError = '';
  });

  function submit(): void {
    if (start.isPending) return;
    const text = input.trim();
    let parsed: unknown;
    if (text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        inputError = copy.invalidInput;
        return;
      }
    }
    start.mutate(parsed);
  }

  function dismiss(): void {
    if (start.isPending) return;
    open = false;
    input = '';
    failure = '';
    inputError = '';
  }
</script>

<Modal
  bind:open
  title={copy.title}
  onDismiss={dismiss}
  dismissOnEscape={!start.isPending}
  dismissOnBackdropClick={!start.isPending}
>
  {#snippet children()}
    <form
      class="ib-start-run"
      data-testid="workflow-start-form"
      onsubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <p class="ib-start-run__lead">{copy.description(type)}</p>
      <Textarea
        id="workflow-start-input"
        label={copy.inputLabel}
        description={copy.inputDescription}
        variant="code"
        rows={6}
        bind:value={input}
        error={inputError}
      />
      {#if failure !== ''}
        <Alert variant="danger">
          <p class="ib-start-run__failure-title">{copy.failed}</p>
          <p class="ib-start-run__failure-message">{failure}</p>
        </Alert>
      {/if}
    </form>
  {/snippet}
  {#snippet footer()}
    <Button variant="secondary" onclick={dismiss} disabled={start.isPending}>{copy.cancel}</Button>
    <Button variant="primary" onclick={submit} loading={start.isPending}>{copy.confirm}</Button>
  {/snippet}
</Modal>

<style>
  .ib-start-run {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-start-run__lead,
  .ib-start-run__failure-title,
  .ib-start-run__failure-message {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .ib-start-run__failure-title {
    font-weight: 600;
  }
</style>
