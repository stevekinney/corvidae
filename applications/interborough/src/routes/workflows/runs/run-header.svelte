<script lang="ts">
  /**
   * The one header of a run's page: what ran (the agent, or the workflow's type), the run's one
   * status with when it started and how long it took, Open chat and Cancel run as buttons of one
   * size, and a More menu for everything else a person does to a run: copy its ID, and, for a run
   * the workflow engine holds, suspend, resume, force a timeout, cancel, or restart it.
   *
   * It draws what it is given and owns nothing but the confirmation of the two actions that cannot
   * be undone. The page owns the queries and the mutations (`run-engine.svelte.ts`), and passes
   * `onAction` and `onRestart` in.
   */
  import {
    Button,
    ConfirmDialog,
    Dropdown,
    PageHeader,
    VisuallyHidden,
  } from '@lostgradient/cinder';
  import type { WorkflowState } from '@lostgradient/weft';
  import { Copy, Ellipsis, RotateCcw } from '@lucide/svelte';

  import { RUN_PAGE_COPY } from '../../../app/copy.ts';
  import { showFault, showToast } from '../../../app/toast-host.svelte';
  import type { TaskView } from '../../../lib/bureau-tasks.ts';
  import { formatDuration, formatRelativeTime } from '../../../lib/format/index.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import type { ScopeGate } from '../../../lib/scopes.svelte.ts';
  import StatusLabel from '../../../lib/status-label.svelte';
  import type { StatusWord } from '../../../lib/status.ts';
  import {
    actionConfirmTier,
    actionLabel,
    availableActions,
    isTerminalStatus,
    type WorkflowContextualAction,
  } from '../detail/workflow-status.ts';
  import RunCancel from './run-cancel.svelte';

  interface RunHeaderProps {
    runId: string;
    /** The agent's name or the workflow's type, set as an identifier; `undefined` names the run only. */
    title: string | undefined;
    /** Said in place of the title when there is none. */
    fallbackTitle: string;
    /** The run's one status word; `undefined` while nothing has said. */
    status: StatusWord | undefined;
    /** When the run started, in milliseconds, and how long it took once it is over. */
    startedAt?: number | undefined;
    tookMilliseconds?: number | undefined;
    /** The Bureau's task, when the run is one: it owns Cancel run. */
    task?: TaskView | undefined;
    /** Where Open chat goes, and what it says. */
    chat?: { readonly href: string; readonly label: string } | undefined;
    /** The engine's status of the run, when the engine holds it: it sets the actions in More. */
    engineStatus?: WorkflowState['status'] | undefined;
    /** The action being carried out, which disables the others. */
    pendingAction?: WorkflowContextualAction | null | undefined;
    /** Whether `workflows:write` is held. */
    actionGate?: ScopeGate | undefined;
    onAction?: ((action: WorkflowContextualAction) => void) | undefined;
    onRestart?: (() => void) | undefined;
  }

  let {
    runId,
    title,
    fallbackTitle,
    status,
    startedAt,
    tookMilliseconds,
    task,
    chat,
    engineStatus,
    pendingAction = null,
    actionGate = { disabled: false, title: undefined },
    onAction,
    onRestart,
  }: RunHeaderProps = $props();

  // The task's own Cancel run stops the run; the engine's cancel would be a second, different cancel
  // of the same run, so it is offered only when the run is no task.
  const engineActions = $derived(
    engineStatus === undefined || onAction === undefined
      ? []
      : availableActions(engineStatus).filter(
          (action) => task === undefined || action !== 'cancel',
        ),
  );
  const canRestart = $derived(
    engineStatus !== undefined && onRestart !== undefined && isTerminalStatus(engineStatus),
  );

  let confirming = $state<WorkflowContextualAction | null>(null);

  function choose(action: WorkflowContextualAction): void {
    if (actionConfirmTier(action) === 'tier-2') {
      confirming = action;
      return;
    }
    onAction?.(action);
  }

  function confirmed(): void {
    if (confirming === null) return;
    onAction?.(confirming);
    confirming = null;
  }

  async function copyRunId(): Promise<void> {
    try {
      await navigator.clipboard.writeText(runId);
      showToast(RUN_PAGE_COPY.runIdCopied);
    } catch (error) {
      showFault({
        kind: 'not-supported',
        message:
          `${RUN_PAGE_COPY.runIdCopyFailed}. ${error instanceof Error ? error.message : ''}`.trim(),
      });
    }
  }

  function openLink(event: MouseEvent, href: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(href);
  }
</script>

{#snippet heading()}
  {#if title === undefined}{fallbackTitle}{:else}<code class="ib-identifier">{title}</code>{/if}
{/snippet}

{#snippet summary()}
  {#if status !== undefined}<StatusLabel word={status} />{/if}
  {#if startedAt !== undefined}
    · <span title={new Date(startedAt).toISOString()}
      >{formatRelativeTime(startedAt, Date.now())}</span
    >
  {/if}
  {#if tookMilliseconds !== undefined}
    · {formatDuration(tookMilliseconds)}
  {/if}
{/snippet}

{#snippet actions()}
  <div class="ib-run__actions">
    {#if chat !== undefined}
      <Button
        variant="secondary"
        href={router.href(chat.href)}
        label={chat.label}
        onclick={(event) => openLink(event, chat.href)}
      />
    {/if}
    {#if task !== undefined}<RunCancel {task} />{/if}
    <Dropdown id="ib-run-actions" placement="bottom-end">
      <Dropdown.Trigger caretVisible={false}>
        <Ellipsis aria-hidden="true" size={16} />
        <VisuallyHidden>{RUN_PAGE_COPY.moreActions}</VisuallyHidden>
      </Dropdown.Trigger>
      <Dropdown.Menu>
        <Dropdown.Item onclick={() => void copyRunId()}>
          <Copy aria-hidden="true" size={14} />
          {RUN_PAGE_COPY.copyRunId}
        </Dropdown.Item>
        {#each engineActions as action (action)}
          <Dropdown.Item
            data-changes
            variant={actionConfirmTier(action) === 'tier-2' ? 'danger' : 'default'}
            title={actionGate.title}
            disabled={actionGate.disabled || (pendingAction !== null && pendingAction !== action)}
            onclick={() => choose(action)}
          >
            {actionLabel(action)}
          </Dropdown.Item>
        {/each}
        {#if canRestart}
          <Dropdown.Item
            data-changes
            title={RUN_PAGE_COPY.restartHint}
            onclick={() => onRestart?.()}
          >
            <RotateCcw aria-hidden="true" size={14} />
            {RUN_PAGE_COPY.restart}
          </Dropdown.Item>
        {/if}
      </Dropdown.Menu>
    </Dropdown>
  </div>
{/snippet}

<PageHeader data-run-header headingLevel={1} title={heading} description={summary} {actions} />

{#if confirming !== null}
  <ConfirmDialog
    open={confirming !== null}
    title={`${actionLabel(confirming)} this run?`}
    description={RUN_PAGE_COPY.confirm[confirming]}
    confirmLabel={actionLabel(confirming)}
    cancelLabel={RUN_PAGE_COPY.keep}
    destructive
    onConfirm={confirmed}
    onCancel={() => (confirming = null)}
  />
{/if}
