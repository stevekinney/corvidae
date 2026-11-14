<script lang="ts">
  import { untrack } from 'svelte';
  import Button from '../button/button.svelte';
  import Checkbox from '../checkbox/checkbox.svelte';
  import { default as JsonEditor } from '../json-editor/index.ts';
  import Textarea from '../textarea/textarea.svelte';
  import ApprovalCardNoteToggle from './approval-card-note-toggle.svelte';
  import { formatEditableArguments, parseJsonText } from './approval-card-state.ts';
  import type {
    ApprovalResolution,
    ApprovalResolutionDecision,
    ApprovalResolving,
  } from './approval-card.types.ts';

  type ApprovalCardActionsProps = {
    /** Base for the ids of the controls this region renders. */
    idBase: string;
    /** Identity of the approval request; form state resets when it changes. */
    requestKey: string;
    /** The tool's name as the approver reads it, written in the checkbox label. */
    toolName: string;
    /** The checkbox's scope ("the rest of this chat"), or `undefined` when the tool never offers it. */
    rememberScope: string | undefined;
    /** Why Deny and Approve are off, when they are. */
    disabledReason: string | undefined;
    /** The answer on its way, or `undefined` when none is. */
    resolving: ApprovalResolving | undefined;
    /** Whether the approve-with-edits flow is available. */
    canEditArguments: boolean;
    /** Normalized arguments value used to seed the JSON editor. */
    argumentsValue: unknown;
    /** Resolution sink; the parent guards actionability before forwarding. */
    resolve: (resolution: ApprovalResolution) => void;
  };

  let {
    idBase,
    requestKey,
    toolName,
    rememberScope,
    disabledReason,
    resolving,
    canEditArguments,
    argumentsValue,
    resolve,
  }: ApprovalCardActionsProps = $props();

  const reasonId = $derived(`${idBase}-resolution-reason`);
  const disabledReasonId = $derived(`${idBase}-disabled-reason`);
  const editRegionId = $derived(`${idBase}-edit-region`);

  let resolutionReason = $state('');
  // The note waits behind "Add a note"; once opened it stays open, so a typed note never hides.
  let noteOpen = $state(false);
  let rememberResolution = $state(false);
  let editingArguments = $state(false);
  let editedArgumentsText = $state('');

  // A writable `$derived` that reads `requestKey` looked like the simpler
  // reset mechanism, but a $derived re-runs whenever ANY parent prop update
  // touches its host — not only when the tracked value actually changes —
  // so it silently wiped in-progress reason text / edits on every unrelated
  // host re-render. `{#key requestKey}` has the same intent but was
  // unreliable in practice here (a fresh DOM node with a stale value).
  // Comparing the previous value explicitly, inside the effect, is the
  // one thing that's actually gated on requestKey CHANGING, not merely
  // being re-touched.
  let previousRequestKey = untrack(() => requestKey);
  $effect(() => {
    if (requestKey === previousRequestKey) return;
    previousRequestKey = requestKey;
    resolutionReason = '';
    noteOpen = false;
    rememberResolution = false;
    // A new request must never leave a stale editor open, even if its
    // arguments happen to serialize identically to the previous request's
    // (the separate snapshot effect below wouldn't see a change in that
    // case) — an edit must never be confirmed against the wrong request.
    editingArguments = false;
    editedArgumentsText = '';
  });

  // Separate from the identity reset above: a host can revise
  // `operation.argsPreview` for the SAME request (e.g. a live update) while
  // the edit panel is open. Comparing the formatted snapshot — not object
  // identity, which changes on unrelated re-renders too — closes a stale
  // editor whenever the underlying arguments actually change, so a confirmed
  // edit can never be based on arguments older than what PayloadInspector is
  // currently showing. Re-opening reseeds from the current value.
  let previousArgumentsSnapshot = untrack(() => formatEditableArguments(argumentsValue));
  $effect(() => {
    const snapshot = formatEditableArguments(argumentsValue);
    if (snapshot === previousArgumentsSnapshot) return;
    previousArgumentsSnapshot = snapshot;
    editingArguments = false;
    editedArgumentsText = '';
  });

  const editParseResult = $derived(parseJsonText(editedArgumentsText));
  const isBusy = $derived(resolving !== undefined);
  const actionsOff = $derived(disabledReason !== undefined || isBusy);

  function emitResolution(decision: ApprovalResolutionDecision, editedArgs?: unknown): void {
    if (actionsOff) return;
    const trimmedReason = resolutionReason.trim();
    const resolution: ApprovalResolution = {
      decision,
      remember: rememberResolution,
    };

    if (decision === 'approve_with_edits') {
      resolution.editedArgs = editedArgs;
    }
    if (trimmedReason) {
      resolution.reason = trimmedReason;
    }

    resolve(resolution);
  }

  function toggleEditingArguments(): void {
    if (!canEditArguments) return;
    if (!editingArguments) {
      editedArgumentsText = formatEditableArguments(argumentsValue);
    }
    editingArguments = !editingArguments;
  }

  function handleConfirmEditedApproval(): void {
    if (!canEditArguments || !editParseResult.ok) return;
    emitResolution('approve_with_edits', editParseResult.value);
  }
</script>

<div class="cinder-approval-card__actions">
  {#if noteOpen}
    <div class="cinder-approval-card__resolution-controls">
      <Textarea
        id={reasonId}
        bind:value={resolutionReason}
        label="Note"
        description="Saved with your decision. If you deny, the agent reads it as the reason."
        placeholder="Add a note for the agent or the record"
        rows={2}
        disabled={isBusy}
      />
    </div>
  {/if}
  {#if rememberScope !== undefined}
    <div class="cinder-approval-card__remember">
      <Checkbox
        bind:checked={rememberResolution}
        label={`Allow ${toolName} for ${rememberScope}`}
        disabled={isBusy}
        mutating
      />
    </div>
  {/if}
  {#if disabledReason !== undefined}
    <p id={disabledReasonId} class="cinder-approval-card__reason" dir="auto">{disabledReason}</p>
  {/if}
  <div class="cinder-approval-card__action-row" role="group" aria-label="Approval actions">
    {#if !noteOpen}
      <ApprovalCardNoteToggle
        disabled={isBusy}
        fieldId={reasonId}
        onOpen={() => (noteOpen = true)}
      />
    {/if}
    <div class="cinder-approval-card__action-buttons">
      <Button
        type="button"
        variant="secondary"
        mutating
        disabled={isBusy && resolving !== 'deny'}
        aria-disabled={disabledReason === undefined ? undefined : 'true'}
        loading={resolving === 'deny'}
        loadingStatus="Denying…"
        aria-describedby={disabledReason === undefined ? undefined : disabledReasonId}
        onclick={() => emitResolution('deny')}
      >
        {resolving === 'deny' ? 'Denying…' : 'Deny'}
      </Button>
      {#if canEditArguments}
        <Button
          type="button"
          variant="secondary"
          mutating
          disabled={isBusy}
          onclick={toggleEditingArguments}
          aria-expanded={editingArguments}
          aria-controls={editingArguments ? editRegionId : undefined}
        >
          Approve with edits
        </Button>
      {/if}
      <Button
        type="button"
        variant="primary"
        mutating
        disabled={isBusy && resolving !== 'approve'}
        aria-disabled={disabledReason === undefined ? undefined : 'true'}
        loading={resolving === 'approve'}
        loadingStatus="Approving…"
        aria-describedby={disabledReason === undefined ? undefined : disabledReasonId}
        onclick={() => emitResolution('approve')}
      >
        {resolving === 'approve' ? 'Approving…' : 'Approve'}
      </Button>
    </div>
  </div>
  {#if editingArguments && canEditArguments}
    <div id={editRegionId} class="cinder-approval-card__editor">
      <JsonEditor
        id={`${idBase}-edited-arguments`}
        label="Edited arguments JSON"
        description="Approving sends the parsed JSON below instead of the original arguments."
        value={editedArgumentsText}
        onValueChange={(value) => (editedArgumentsText = value)}
        {...!editParseResult.ok ? { error: editParseResult.message } : {}}
        rows={8}
        validFeedbackVisible={false}
        autofocus
      />
      <div class="cinder-approval-card__editor-actions">
        <Button
          type="button"
          variant="primary"
          mutating
          onclick={handleConfirmEditedApproval}
          disabled={!editParseResult.ok || isBusy}
          aria-disabled={disabledReason === undefined ? undefined : 'true'}
          aria-describedby={disabledReason === undefined ? undefined : disabledReasonId}
        >
          Confirm edited approval
        </Button>
      </div>
    </div>
  {/if}
</div>
