<script lang="ts" module>
  /**
   * @cinder
   * @category overlay
   * @status beta
   * @purpose One tool call's side panel: its state, its input and result as fields, a failure's message first with next steps, and a waiting call's note and decision. Docks from 1280px; a Drawer below.
   * @tag tool-call
   * @tag panel
   * @tag agent
   * @useWhen Opening a tool call from a ToolCallRail row to read what it was given and what came back.
   * @useWhen Letting a person answer a call that is waiting on them, with a note, without leaving the conversation.
   * @avoidWhen Showing an arbitrary payload on its own — use payload-inspector.
   * @avoidWhen Showing supplementary navigation or settings from a page edge — use drawer.
   * @rationale Nearest alternative: Drawer — a drawer is always an overlay, while this panel docks in the page where there is room, shares its header, status line and sections across every kind of call, and uses a Drawer only below the docking width.
   * @related tool-call-rail, drawer, approval-card, payload-inspector
   */
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
  } from '../../_internal/viewport-below.svelte.ts';
  import { phoneViewport } from '../../_internal/phone-viewport.svelte.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import Button from '../button/button.svelte';
  import CopyButton from '../copy-button/copy-button.svelte';
  import Drawer from '../drawer/drawer.svelte';
  import Spinner from '../spinner/spinner.svelte';
  import Textarea from '../textarea/textarea.svelte';
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
    note: labels?.note ?? 'Note (optional)',
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
      <Textarea
        id={noteId}
        bind:value={note}
        label={words.note}
        description={words.noteDescription}
        rows={3}
        disabled={decisionOff}
      />
      <div class="cinder-tool-call-panel__decision-actions">
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
