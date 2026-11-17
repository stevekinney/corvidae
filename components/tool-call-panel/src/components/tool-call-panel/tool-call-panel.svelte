<script lang="ts" module>
  export type {
    ToolCallPanelError,
    ToolCallPanelLabels,
    ToolCallPanelPlacement,
    ToolCallPanelProps,
    ToolCallPanelResolving,
    ToolCallPanelStatus,
    ToolCallPanelView,
  } from './tool-call-panel.types.ts';
</script>

<script lang="ts">
  import { untrack } from 'svelte';
  import Ban from '@lucide/svelte/icons/ban';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import X from '@lucide/svelte/icons/x';

  import {
    readViewportBreakpoint,
    useViewportBelow,
  } from '@lostgradient/foundation/_internal/viewport-below.svelte.ts';
  import { phoneViewport } from '@lostgradient/foundation/_internal/phone-viewport.svelte.ts';
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import Button from '@lostgradient/button/components/button/button.svelte';
  import CopyButton from '@lostgradient/copy-button/components/copy-button/copy-button.svelte';
  import Drawer from '@lostgradient/drawer/components/drawer/drawer.svelte';
  import Spinner from '@lostgradient/spinner/components/spinner/spinner.svelte';
  import Textarea from '@lostgradient/textarea/components/textarea/textarea.svelte';
  import ApprovalCardNoteToggle from '@lostgradient/approval-card/components/approval-card/approval-card-note-toggle.svelte';
  import type { ToolCallPanelProps, ToolCallPanelStatus } from './tool-call-panel.types.ts';
  import { readPanelPayload, formatJsonText } from './tool-call-panel.utilities.ts';
  import type { PanelPayload } from './tool-call-panel.utilities.ts';

  let {
    open = $bindable(true),
    name,
    identifier,
    status,
    duration,
    position,
    summary,
    input,
    result,
    resultLabel = 'Result',
    error,
    view = $bindable('fields'),
    redact,
    retryMessage,
    onRetry,
    onApprove,
    onDeny,
    resolving,
    onClose,
    placement = 'auto',
    dockedFrom = '1280px',
    triggerRef = null,
    labels,
    class: className,
    children,
    ...rest
  }: ToolCallPanelProps = $props();

  const baseId = $props.id();
  const dialogAttributes = $derived(rest as Record<string, unknown>);
  const titleId = `${baseId}-title`;
  const noteId = `${baseId}-note`;

  let note = $state('');
  // The note waits behind "Add note"; once opened it stays open, so a typed note never hides.
  let showNote = $state(false);
  let wasOpen = untrack(() => open);

  $effect(() => {
    const isOpen = open;
    if (wasOpen && !isOpen) untrack(() => onClose?.());
    wasOpen = isOpen;
  });

  const words = $derived({
    input: labels?.input ?? 'Input',
    noInput: labels?.noInput ?? 'This tool call takes no input.',
    error: labels?.error ?? 'Error',
    message: labels?.message ?? 'Message',
    code: labels?.code ?? 'Code',
    retryable: labels?.retryable ?? 'Retryable',
    pending: labels?.pending ?? 'The result appears when the call finishes.',
    retryNote:
      labels?.retryNote ??
      ((message: string) =>
        `Failures aren’t retried automatically. Ask the agent to retry sends “${message}” as your message; while a review is waiting, the composer’s status line reads “Waiting for your approval, a message now steers the run”.`),
    retry: labels?.retry ?? 'Ask the agent to retry',
    copyInput: labels?.copyInput ?? 'Copy input',
    copyResult: labels?.copyResult ?? `Copy ${resultLabel.toLowerCase()}`,
    copyError: labels?.copyError ?? 'Copy error',
    addNote: labels?.addNote ?? 'Add note',
    note: labels?.note ?? 'Note',
    noteDescription:
      labels?.noteDescription ??
      'Saved with your decision. If you deny, the agent reads it as the reason.',
    deny: labels?.deny ?? 'Deny',
    approve: labels?.approve ?? 'Approve',
    denying: labels?.denying ?? 'Denying…',
    approving: labels?.approving ?? 'Approving…',
    close: labels?.close ?? 'Close',
    closeIcon: labels?.closeIcon ?? 'Close panel',
  });
  const statusWords: Record<ToolCallPanelStatus, string> = $derived({
    done: labels?.status?.done ?? 'Done',
    approved: labels?.status?.approved ?? 'Approved',
    running: labels?.status?.running ?? 'Running',
    waiting: labels?.status?.waiting ?? 'Waiting on you',
    expired: labels?.status?.expired ?? 'Approval expired',
    denied: labels?.status?.denied ?? 'Denied',
    failed: labels?.status?.failed ?? 'Failed',
    interrupted: labels?.status?.interrupted ?? 'Interrupted',
  });

  const dockedBelow = useViewportBelow(() =>
    readViewportBreakpoint(dockedFrom, 'ToolCallPanel', 'dockedFrom'),
  );
  /** Where the panel sits now. On the server and without `matchMedia` it is the wide, docked form. */
  const mode = $derived.by(() => {
    if (placement !== 'auto') return placement;
    if (phoneViewport.current) return 'sheet';
    return dockedBelow.current ? 'overlay' : 'docked';
  });

  const inputPayload = $derived(readPanelPayload(input, redact));
  const resultPayload = $derived(readPanelPayload(result, redact));
  const errorText = $derived(
    error === undefined
      ? ''
      : formatJsonText({
          message: error.message,
          ...(error.code === undefined ? {} : { code: error.code }),
          ...(error.retryable === undefined ? {} : { retryable: error.retryable }),
        }),
  );

  const showError = $derived(status === 'failed' && error !== undefined);
  const showResult = $derived(
    status === 'running' ||
      ((status === 'done' || status === 'approved' || status === 'denied') &&
        resultPayload.present),
  );
  const showDecision = $derived(
    status === 'waiting' && (onApprove !== undefined || onDeny !== undefined),
  );
  const decisionOff = $derived(resolving !== undefined);

  /** Escape closes a docked panel while focus is inside it; the sheet and the overlay close through Drawer. */
  function handleDockedKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.preventDefault();
    open = false;
  }
</script>

{#snippet payloadBody(payload: PanelPayload)}
  {#if view === 'json'}
    <pre class="cinder-tool-call-panel__json"><code>{payload.json}</code></pre>
  {:else}
    <dl class="cinder-tool-call-panel__fields">
      {#each payload.fields as field (field.key)}
        <div class="cinder-tool-call-panel__field">
          <dt>{field.label}</dt>
          <dd data-cinder-kind={field.kind}>{field.text}</dd>
        </div>
      {/each}
    </dl>
  {/if}
{/snippet}

{#snippet heading()}
  <div class="cinder-tool-call-panel__heading">
    <h2 id={titleId} class="cinder-tool-call-panel__title">
      <span class="cinder-tool-call-panel__name">{name}</span>
      {#if identifier}
        <code class="cinder-tool-call-panel__identifier">{identifier}</code>
      {/if}
    </h2>
    <p class="cinder-tool-call-panel__status" data-cinder-status={status}>
      {#if summary}
        {summary}
      {:else}
        <span class="cinder-tool-call-panel__marker" aria-hidden="true">
          {#if status === 'running'}
            <Spinner size="sm" variant="arc" />
          {:else if status === 'waiting'}
            <ShieldAlert class="cinder-tool-call-panel__glyph" />
          {:else if status === 'denied'}
            <Ban class="cinder-tool-call-panel__glyph" />
          {:else}
            <span class="cinder-tool-call-panel__dot"></span>
          {/if}
        </span>
        <span class="cinder-tool-call-panel__status-word"
          >{statusWords[status]}{#if duration || position}<span
              class="cinder-tool-call-panel__separator"
              aria-hidden="true">,</span
            >{/if}</span
        >
        {#if duration || position}
          <span class="cinder-tool-call-panel__status-detail">
            {[duration, position].filter(Boolean).join(', ')}
          </span>
        {/if}
      {/if}
    </p>
  </div>
{/snippet}

{#snippet copyButton(value: string, label: string)}
  <CopyButton {value} {label} copiedLabel="Copied" class="cinder-tool-call-panel__copy">
    {label}
  </CopyButton>
{/snippet}

{#snippet sections()}
  <section class="cinder-tool-call-panel__section" aria-labelledby="{baseId}-input">
    <h3 id="{baseId}-input" class="cinder-tool-call-panel__heading-label">{words.input}</h3>
    {#if inputPayload.present}
      <div class="cinder-tool-call-panel__block">
        {@render payloadBody(inputPayload)}
      </div>
    {:else}
      <p class="cinder-tool-call-panel__quiet">{words.noInput}</p>
    {/if}
  </section>

  {#if showError && error}
    <section class="cinder-tool-call-panel__section" aria-labelledby="{baseId}-error">
      <h3 id="{baseId}-error" class="cinder-tool-call-panel__heading-label">{words.error}</h3>
      <div class="cinder-tool-call-panel__block" data-cinder-tone="danger">
        {#if view === 'json'}
          <pre class="cinder-tool-call-panel__json"><code>{errorText}</code></pre>
        {:else}
          <dl class="cinder-tool-call-panel__fields">
            <div class="cinder-tool-call-panel__field">
              <dt>{words.message}</dt>
              <dd data-cinder-kind="text">{error.message}</dd>
            </div>
            {#if error.code !== undefined}
              <div class="cinder-tool-call-panel__field">
                <dt>{words.code}</dt>
                <dd data-cinder-kind="code">{error.code}</dd>
              </div>
            {/if}
            {#if error.retryable !== undefined}
              <div class="cinder-tool-call-panel__field">
                <dt>{words.retryable}</dt>
                <dd data-cinder-kind="text">{error.retryable ? 'Yes' : 'No'}</dd>
              </div>
            {/if}
          </dl>
        {/if}
      </div>
    </section>
    {#if retryMessage !== undefined}
      <p class="cinder-tool-call-panel__note">{words.retryNote(retryMessage)}</p>
    {/if}
    {#if onRetry}
      <Button
        type="button"
        variant="secondary"
        fullWidth
        mutating
        class="cinder-tool-call-panel__retry"
        onclick={() => onRetry()}
      >
        {#snippet leadingIcon()}<RefreshCw class="cinder-icon-sm" aria-hidden="true" />{/snippet}
        {words.retry}
      </Button>
    {/if}
    <div class="cinder-tool-call-panel__actions">
      {#if inputPayload.present}
        {@render copyButton(inputPayload.copy, words.copyInput)}
      {/if}
      {@render copyButton(errorText, words.copyError)}
    </div>
  {:else if showResult}
    <section class="cinder-tool-call-panel__section" aria-labelledby="{baseId}-result">
      <h3 id="{baseId}-result" class="cinder-tool-call-panel__heading-label">{resultLabel}</h3>
      {#if status === 'running'}
        <p class="cinder-tool-call-panel__quiet">{words.pending}</p>
      {:else}
        <div class="cinder-tool-call-panel__block">
          {@render payloadBody(resultPayload)}
        </div>
      {/if}
    </section>
    {#if status !== 'running'}
      <div class="cinder-tool-call-panel__actions">
        {#if inputPayload.present}
          {@render copyButton(inputPayload.copy, words.copyInput)}
        {/if}
        {@render copyButton(resultPayload.copy, words.copyResult)}
      </div>
    {/if}
  {/if}

  {#if showDecision}
    <div class="cinder-tool-call-panel__decision">
      {#if showNote}
        <Textarea
          id={noteId}
          bind:value={note}
          label={words.note}
          description={words.noteDescription}
          rows={3}
          disabled={decisionOff}
        />
      {/if}
      <div class="cinder-tool-call-panel__decision-actions">
        {#if !showNote}
          <ApprovalCardNoteToggle
            disabled={decisionOff}
            fieldId={noteId}
            label={words.addNote}
            onOpen={() => (showNote = true)}
          />
        {/if}
        <div class="cinder-tool-call-panel__decision-buttons">
          <Button
            type="button"
            variant="secondary"
            mutating
            disabled={decisionOff && resolving !== 'deny'}
            loading={resolving === 'deny'}
            loadingStatus={words.denying}
            onclick={() => onDeny?.(note)}
          >
            {words.deny}
          </Button>
          <Button
            type="button"
            variant="primary"
            mutating
            disabled={decisionOff && resolving !== 'approve'}
            loading={resolving === 'approve'}
            loadingStatus={words.approving}
            onclick={() => onApprove?.(note)}
          >
            {words.approve}
          </Button>
        </div>
      </div>
    </div>
  {/if}

  {#if children}
    {@render children()}
  {/if}
{/snippet}

{#if mode === 'docked'}
  {#if open}
    <aside
      {...rest}
      class={classNames('cinder-tool-call-panel', className)}
      aria-labelledby={titleId}
      data-cinder-placement="docked"
      data-cinder-status={status}
      onkeydown={handleDockedKeydown}
    >
      <header class="cinder-tool-call-panel__header">
        {@render heading()}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          iconOnly
          aria-label={words.closeIcon}
          onclick={() => (open = false)}
        >
          {#snippet leadingIcon()}<X class="cinder-icon-sm" aria-hidden="true" />{/snippet}
        </Button>
      </header>
      <div class="cinder-tool-call-panel__body">
        {@render sections()}
      </div>
    </aside>
  {/if}
{:else}
  <Drawer
    {...dialogAttributes}
    bind:open
    title={name}
    ariaLabelledby={titleId}
    placement={mode === 'sheet' ? 'bottom' : 'right'}
    closeLabel={mode === 'sheet' ? words.close : undefined}
    {triggerRef}
    class={classNames('cinder-tool-call-panel-drawer', className)}
    data-cinder-placement={mode}
    data-cinder-status={status}
  >
    {#snippet header()}
      {@render heading()}
    {/snippet}
    <div class="cinder-tool-call-panel__body">
      {@render sections()}
    </div>
  </Drawer>
{/if}
