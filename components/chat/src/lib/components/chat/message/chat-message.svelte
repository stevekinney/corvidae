<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { ApprovalResolution, ApprovalState, CitationSource } from '@lostgradient/cinder';
  import type { HTMLAttributes } from 'svelte/elements';
  import type { Message, ToolCallPair } from '../conversation-model.ts';
  import type { MarkdownNodeOverride, MessagePartOverride } from './chat-message-parts.ts';
  import type {
    ChatNotSent,
    MessageNoteInfo,
    MessagePartDerivationContext,
    StepInfo,
    ToolApprovalReceiptRecord,
  } from '../utilities/types.ts';
  import type { ChatTurnLabels } from './turn-labels.ts';
  import type { ChatTurnState } from './turn-state.ts';
  import type { ChatLabels } from '../chat-labels.ts';

  export type ChatMessageProps = Omit<HTMLAttributes<HTMLElement>, 'class'> & {
    /** The message to render */
    message: Message;
    idPrefix?: string | undefined;
    /** Paired tool calls (from pairToolCallsWithResults) - used for tool-call messages */
    toolCallPairs?: ToolCallPair[];
    /** Whether long content is expanded */
    expanded?: boolean;
    /** Additional CSS class */
    class?: string;
    /** Whether this message is the active in-conversation search match */
    searchMatch?: boolean;
    /**
     * How the message is drawn. `'transcript'` is the Interborough transcript: a reply is plain
     * text with no card or role label, and one muted line under each message carries its time, Copy,
     * Quote and Regenerate (when `onRegenerate` is set) as icon-only controls, then the host's
     * `actions`. A message that was not sent keeps its
     * bubble under a red icon, its time and "Not sent", and a follow-up the run has not taken yet is
     * a dashed bubble marked "Queued". A run's notes sit outside the bubble. Default `'default'`.
     */
    presentation?: 'default' | 'transcript';
    /** The words of a message's "Not sent" popover, for the transcript presentation. */
    notSent?: ChatNotSent | undefined;
    /** Whether the "Not sent" popover is open. Bindable; it opens from the red icon. */
    notSentOpen?: boolean;
    /**
     * Called when the person removes a queued follow-up. Remove shows on a queued message only when
     * this is set, because only the host knows whether a message it has sent can still be taken
     * back.
     */
    onRemoveQueued?: ((messageId: string) => void) | undefined;
    /** Drawn at the end of a run's note line, such as a Retry beside a failed run's stop note. */
    noteAction?: Snippet<[note: MessageNoteInfo]> | undefined;
    /** Actions region snippet (copy, edit, retry buttons) */
    actions?: Snippet;
    /** Status indicator snippet that belongs to the semantic message article. */
    status?: Snippet;
    /** Visual metadata rendered below the message bubble, such as read receipts. */
    metadata?: Snippet;
    /** Layout for approval parts rendered in an aggregate approval row. */
    approvalLayout?: 'decision' | 'row' | undefined;
    /**
     * Per-part render override. Forwarded to the parts renderer; lets a consumer
     * replace the rendering of an individual body part while delegating the rest
     * to the built-ins (inversion of control — see the renderer).
     */
    messagePart?: MessagePartOverride | undefined;
    /** Per-node override for code blocks, tables, and Mermaid blocks inside markdown. */
    markdownNode?: MarkdownNodeOverride | undefined;
    /** Show built-in copy button alongside custom actions (default: true) */
    showDefaultActions?: boolean;
    /** Whether this message is currently streaming */
    streaming?: boolean;
    /** Whether tool activity belongs to the currently active stream. */
    toolActivityActive?: boolean;
    /** Override content for streaming (partial token buffer) */
    overrideContent?: string | undefined;
    /** Called when expanded state changes */
    onExpandedChange?: ((expanded: boolean) => void) | undefined;
    /** Called when retry is requested on a failed message */
    onRetry?: ((messageId: string) => void) | undefined;
    /** Called when user edits a message (fires with new content). Only applies to user messages. */
    onEdit?: ((event: { messageId: string; content: string }) => void) | undefined;
    /**
     * Called with a piece of this assistant message's text when the reader asks
     * to quote it. Setting it adds a Quote action to assistant messages and
     * marks their rendered text so a selection inside it can be quoted. The
     * text is the current selection inside this message, or, with none, the
     * message's whole rendered text.
     */
    onQuote?: ((text: string) => void) | undefined;
    /**
     * Called with this message's id when the reader asks to regenerate the answer. Setting it adds
     * a Regenerate action, beside Copy and Quote, to a finished assistant message; without it no
     * Regenerate action is drawn, because only the host knows how to write the answer again.
     * Regenerating rewrites the answer: the tool results and approvals that came before it stay.
     */
    onRegenerate?: ((messageId: string) => void | Promise<void>) | undefined;
    /** Disables the Quote action, for example when no more quotes fit. */
    quoteDisabled?: boolean;
    /** The id of an element that explains why Quote is disabled. */
    quoteDisabledDescriptionId?: string | undefined;
    /** Called when this message enters or leaves edit mode. */
    oneditingchange?: ((editing: boolean) => void) | undefined;
    /** Requests a previewed, confirmed rollback from this user message. */
    onRollback?: ((messageId: string) => void) | undefined;
    /** Visually marks this row as content that a pending rollback will discard. */
    rollbackDiscarded?: boolean;
    /** UI-only approval states keyed by tool-call id. */
    approvalStates?: ReadonlyMap<string, ApprovalState> | undefined;
    /** Tool-call ids currently submitting a resolution. */
    approvalResolutionInFlightIds?: ReadonlySet<string> | undefined;
    /** UI-only approvals decided in this chat, keyed by tool-call id, kept as receipts. */
    approvalReceipts?: ReadonlyMap<string, ToolApprovalReceiptRecord> | undefined;
    /** Describes a tool approval beyond its action; `undefined` adds nothing to what the action carries. */
    describeApproval?: MessagePartDerivationContext['describeApproval'];
    /** Requests a fresh approval after this tool call expires. */
    onApprovalRequestAgain?: ((toolCallId: string) => void) | undefined;
    /** Called when the user resolves an action-required approval. */
    onApprovalResolve?:
      ((toolCallId: string, resolution: ApprovalResolution) => void | Promise<void>) | undefined;
    /** Called with the schema-valid value when the user submits a requested-input form. */
    onInputSubmit?: ((toolCallId: string, value: unknown) => void | Promise<void>) | undefined;
    toolCallPresentation?: import('../utilities/types.ts').ToolCallPresentation | undefined;
    /**
     * Reasoning text to surface as a collapsible block before the body.
     * When present and non-empty, a `reasoning` part is prepended to the derived parts.
     */
    reasoning?: import('../utilities/types.ts').ReasoningInfo | string | undefined;
    /** Structured transcript event rows sourced from namespaced message metadata. */
    entries?: import('../utilities/types.ts').TranscriptEntryInfo[] | undefined;
    /** Lines a run left under the message, sourced from `cinder:notes` metadata. */
    notes?: import('../utilities/types.ts').MessageNoteInfo[] | undefined;
    /**
     * Step list to surface as a stepper before the body.
     * Each entry maps to one `step` part in the derived parts.
     */
    steps?: ReadonlyArray<StepInfo> | undefined;
    /** Whether the reasoning disclosure is expanded. Owned by the container's reasoning state. */
    reasoningExpanded?: boolean | undefined;
    /** Called when the reasoning disclosure toggle is activated. */
    onreasoning?: (() => void) | undefined;
    /** Whether the grouped steps disclosure is expanded. */
    stepsExpanded?: boolean | undefined;
    /** Called when the grouped steps disclosure is toggled. */
    onsteps?: (() => void) | undefined;
    /**
     * Whether the tool-call card disclosure is expanded. Collapsed by default —
     * kept separate from `expanded` (which drives markdown "Show more/less"),
     * since a tool-call message never carries a markdown body. Bindable, like
     * `expanded`: the `Chat` container drives it from its own per-message
     * disclosure state (one-way, via `ontoolcalltoggle`), but a standalone
     * `ChatMessage` used outside `Chat` still gets working, self-contained
     * disclosure with no wiring required.
     */
    toolCallExpanded?: boolean | undefined;
    /** Called when the tool-call card disclosure toggle is activated. */
    ontoolcalltoggle?: (() => void) | undefined;
    /**
     * Suggestion labels to surface as clickable chips after the body.
     * Each entry maps to one `suggestion` part in the derived parts.
     */
    suggestions?: ReadonlyArray<string> | undefined;
    /** Called when the user selects a suggestion chip. */
    onSuggestionSelect?: ((label: string) => void) | undefined;
    /**
     * The sources behind this message, in the order to show them. Only an assistant message with
     * at least one source shows the Sources control; the sources are presentation only and never
     * written to the transcript.
     */
    sources?: readonly CitationSource[] | undefined;
    /**
     * How the Sources control shows the sources: `'compact'` opens Cinder's Citation panel, `'list'`
     * is a disclosure that lists them under the message, and `'inline'` draws one chip per source,
     * each reading the source's host (or its label when it has no web address) and opening that
     * source in Citation's panel. The chips flow like words and wrap with the line. Default
     * `'compact'`.
     */
    sourcePresentation?: 'compact' | 'list' | 'inline' | undefined;
    /**
     * With `sourcePresentation="list"`, whether the list is open. Bindable, like `toolCallExpanded`:
     * `Chat` drives it one-way through `onsourcestoggle`, and a standalone `ChatMessage` still gets
     * a working disclosure.
     */
    sourcesExpanded?: boolean | undefined;
    /** Called when the source list's disclosure is toggled. */
    onsourcestoggle?: (() => void) | undefined;
    /**
     * Where this assistant turn stands (COR-2283), as the host knows it. A `reconnecting` turn reads
     * muted with no caret, under a warning Callout with Retry and a bar that drains until the next try;
     * a `stopped` one carries one neutral Callout with Continue and Discard; a `failed` one a danger
     * Callout that says the answer is incomplete, why, and what Retry keeps; an `empty` one a neutral
     * Callout in place of its line, with its time and Retry. Left out, the turn streams while text arrives
     * and is complete after. Ignored on a message that is not the assistant's.
     */
    turnState?: ChatTurnState | undefined;
    /** The words of the turn's outcome, any of which the host can replace. */
    turnLabels?: Partial<ChatTurnLabels> | undefined;
    /** Host-overridable message action labels. */
    labels?: Partial<ChatLabels> | undefined;
    /** Called with this message's id when the person chooses Retry now on a reconnecting turn. Retry now shows only when this is set. */
    onRetryConnection?: ((messageId: string) => void) | undefined;
    /** Called with this message's id when the person chooses Continue on a stopped turn. Continue shows only when this is set. */
    onContinueTurn?: ((messageId: string) => void) | undefined;
    /** Called with this message's id when the person chooses Discard on a stopped turn. Discard shows only when this is set; the host removes the turn. */
    onDiscardTurn?: ((messageId: string) => void) | undefined;
    /** Called with this message's id when the person chooses Retry on a failed turn or Try again on an empty one. Each shows only when this is set. */
    onRetryTurn?: ((messageId: string) => void) | undefined;
    /** Called with a failed tool call's id when the person chooses Retry this step under it. The button shows only when this is set. */
    onRetryStep?: ((toolCallId: string) => void) | undefined;
    /** Says a sentence to a screen reader through the container's announcer, outside the transcript's log. */
    onAnnounce?: ((message: string) => void) | undefined;
    /** How long each tool call of this message took, in milliseconds, keyed by call id. */
    toolCallDurations?: ReadonlyMap<string, number> | undefined;
    /** When each tool call of this message started, in milliseconds since the Unix epoch, keyed by call id. */
    toolCallStartTimes?: ReadonlyMap<string, number> | undefined;
  };

  const escapeHtml = (value: string): string =>
    value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
</script>

<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { classNames } from '../../../utilities/class-names.ts';
  import { formatCountdown } from '../../../utilities/format-countdown.ts';
  import { isStreamingMessage, mediaDisplayUrl } from '../builders.ts';
  import {
    deriveMessageParts,
    getMessageRoleLabel,
    getMessageText,
  } from '../utilities/utilities.ts';
  import {
    Button,
    Callout,
    CircleAlert,
    CopyButton,
    Info,
    Pencil,
    Popover,
    Progress,
    Quote,
    ChevronRight,
    RefreshCw,
    RotateCcw,
    Tooltip,
    WifiOff,
  } from '@lostgradient/cinder';
  import ChatMessagePartsRenderer from './chat-message-parts-renderer.svelte';
  import RetryButton from './retry-button.svelte';
  import MessageSources from './message-sources.svelte';
  import { sourceChipKeys } from './source-chip-label.ts';
  import { resolveTurnLabels } from './turn-labels.ts';
  import { resolveChatLabels } from '../chat-labels.ts';
  import { effectiveTurnState, presentTurnState, reconnectWaitFraction } from './turn-state.ts';
  import { useQuestionStore } from '../question/question-store.svelte.ts';
  import { escapeClipboardHtmlAttribute } from '../../../utilities/clipboard.ts';

  let {
    message,
    idPrefix,
    toolCallPairs = [],
    expanded = $bindable(true),
    class: className,
    searchMatch = false,
    actions,
    status,
    metadata,
    messagePart,
    approvalLayout = 'decision',
    markdownNode,
    showDefaultActions = true,
    streaming = false,
    toolActivityActive = true,
    overrideContent,
    onExpandedChange,
    onRetry,
    presentation = 'default',
    notSent,
    notSentOpen = $bindable(false),
    onRemoveQueued,
    noteAction,
    onEdit,
    onQuote,
    onRegenerate,
    quoteDisabled = false,
    quoteDisabledDescriptionId,
    oneditingchange,
    onRollback,
    rollbackDiscarded = false,
    approvalStates,
    approvalResolutionInFlightIds,
    approvalReceipts,
    describeApproval,
    onApprovalResolve,
    onApprovalRequestAgain,
    onInputSubmit,
    toolCallPresentation,
    reasoning,
    entries,
    notes,
    steps,
    suggestions,
    reasoningExpanded = false,
    onreasoning,
    stepsExpanded = true,
    onsteps,
    toolCallExpanded = $bindable(false),
    ontoolcalltoggle,
    onSuggestionSelect,
    sources,
    sourcePresentation = 'compact',
    sourcesExpanded = $bindable(false),
    onsourcestoggle,
    turnState,
    turnLabels,
    labels,
    onRetryConnection,
    onContinueTurn,
    onDiscardTurn,
    onRetryTurn,
    onRetryStep,
    onAnnounce,
    toolCallDurations,
    toolCallStartTimes,
    tabindex,
    ...rest
  }: ChatMessageProps = $props();

  // Where this turn stands (COR-2283). Only an assistant turn takes the host's state; every other
  // message streams or is complete as Chat sees it.
  const turn = $derived(
    effectiveTurnState(
      message.role === 'assistant' ? turnState : undefined,
      streaming,
      isStreamingMessage(message),
    ),
  );
  const turnPresentation = $derived(presentTurnState(turn));
  const turnWords = $derived(resolveTurnLabels(turnLabels));
  const messageLabels = $derived(resolveChatLabels(labels));
  // Text arrives with a caret only in a state that draws one: a reconnecting turn's partial text
  // stops where it is, muted, until the stream comes back.
  const contentStreaming = $derived(streaming && turnPresentation.caret);
  // A turn that draws its own stop (the pill or the alert) leaves out a stop note the run left too.
  const turnOwnsStop = $derived(turn.kind === 'stopped' || turn.kind === 'failed');

  // Quote state. The rendered text of an assistant message is quotable; the
  // parts renderer's wrapper around the markdown body carries
  // `data-quote-source` when `onQuote` is set.
  let articleElement = $state<HTMLElement | null>(null);
  const canQuote = $derived(
    message.role === 'assistant' && onQuote !== undefined && getMessageText(message).trim() !== '',
  );

  // Regenerate. Only a finished assistant answer that the host can write again offers it; a
  // stopped, failed or empty turn offers its own recovery instead.
  const canRegenerate = $derived(
    message.role === 'assistant' &&
      onRegenerate !== undefined &&
      !streaming &&
      !isStreamingMessage(message) &&
      turnPresentation.regenerate,
  );

  function regenerateMessage(): void {
    // The click only hands over the message id; the host reports its own failures.
    void onRegenerate?.(message.id);
  }

  function selectionInside(elements: readonly Element[]): string | undefined {
    const selection = document.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
    const range = selection.getRangeAt(0);
    const insideOneSource = elements.some(
      (source) => source.contains(range.startContainer) && source.contains(range.endContainer),
    );
    return insideOneSource ? selection.toString() : undefined;
  }

  /** What selecting all of the sources would give, leaving the reader's selection as it was. */
  function renderedText(elements: readonly Element[]): string {
    const first = elements[0];
    const last = elements.at(-1);
    const selection = document.getSelection();
    if (!first || !last || !selection) return getMessageText(message);
    const saved = Array.from({ length: selection.rangeCount }, (_, index) =>
      selection.getRangeAt(index).cloneRange(),
    );
    const range = document.createRange();
    range.setStartBefore(first);
    range.setEndAfter(last);
    selection.removeAllRanges();
    selection.addRange(range);
    const text = selection.toString();
    selection.removeAllRanges();
    for (const savedRange of saved) selection.addRange(savedRange);
    return text;
  }

  function quoteMessage(): void {
    const quoteSources = Array.from(
      articleElement?.querySelectorAll<Element>('[data-quote-source]') ?? [],
    );
    onQuote?.(selectionInside(quoteSources) ?? renderedText(quoteSources));
  }

  // Sources. Only an assistant message shows them, and only when it has at least one; a user
  // message given the same input never gains the control.
  const shownSources = $derived(
    message.role === 'assistant' && sources !== undefined && sources.length > 0
      ? sources
      : undefined,
  );
  let sourcesElement = $state<HTMLElement | null>(null);
  let sourcesWereShown = false;
  let previousChipKeys: string[] = [];
  let sourceAnnouncement = $state('');
  let pendingSourceFocus = $state<{ article: HTMLElement; preferAction: boolean }>();

  /** A trigger owns both its local focus and focus inside its portaled panel or sheet. */
  function sourceOwnsFocus(container: Element, active: Element | null): boolean {
    if (active === null) return false;
    if (container.contains(active)) return true;
    for (const control of container.querySelectorAll('[aria-controls]')) {
      const panelId = control.getAttribute('aria-controls');
      if (!panelId) continue;
      const panel = document.getElementById(panelId);
      if ((panel?.closest('dialog') ?? panel)?.contains(active) === true) return true;
    }
    return false;
  }

  function returnSourceFocus(article: HTMLElement, preferAction: boolean): void {
    const target =
      (preferAction &&
        article.parentElement?.querySelector<HTMLElement>(
          '.chat-message-action-button:not(:disabled)',
        )) ||
      article;
    target.focus({ preventScroll: true });
    if (document.activeElement === target && preferAction) {
      target.setAttribute('data-citation-focus', '');
      target.addEventListener('blur', () => target.removeAttribute('data-citation-focus'), {
        once: true,
      });
    }
  }

  function completeSourceWithdrawal(): void {
    const pending = pendingSourceFocus;
    if (pending === undefined) {
      return;
    }
    pendingSourceFocus = undefined;
    if (pending.article.isConnected) returnSourceFocus(pending.article, pending.preferAction);
  }

  // Read the old triggers before Svelte removes them. Retry after the update because an open
  // mobile sheet makes the underlying message inert until the dialog is removed.
  $effect.pre(() => {
    const shown = shownSources !== undefined;
    const inline = sourcePresentation === 'inline';
    const currentKeys = shownSources !== undefined ? sourceChipKeys(shownSources) : [];
    const active = document.activeElement;
    const article = articleElement;
    if (article !== null && sourcesElement !== null && sourcesWereShown) {
      const sourceChips = sourcesElement.querySelectorAll('[data-chat-source-index]');
      const withdrawnOpenChip =
        inline &&
        Array.from(sourceChips).some((chip, index) => {
          const key = previousChipKeys[index];
          return (
            key !== undefined &&
            !currentKeys.includes(key) &&
            chip.querySelector('[aria-expanded="true"]') !== null &&
            sourceOwnsFocus(chip, active)
          );
        });
      const withdrawnSource =
        shown &&
        previousChipKeys.some((key) => !currentKeys.includes(key)) &&
        sourceOwnsFocus(sourcesElement, active);
      const compactPanelOpen =
        (active !== null && active.closest('dialog') !== null) ||
        sourcesElement.querySelector('.cinder-citation__marker[aria-expanded="true"]') !== null;
      // While another chip remains in this message (not the one compact marker), the sources control moves focus to the next
      // chip and says so itself; the message action takes focus only when no chip is left.
      const chipRemains =
        inline &&
        shown &&
        currentKeys.length > 0 &&
        sourcesElement.querySelector('.chat-message-sources-citation') === null;
      if (
        !chipRemains &&
        (withdrawnOpenChip ||
          withdrawnSource ||
          (!shown && sourceOwnsFocus(sourcesElement, active)))
      ) {
        sourceAnnouncement = 'Sources were removed';
        const preferAction = withdrawnOpenChip || withdrawnSource;
        if (withdrawnSource && !withdrawnOpenChip && compactPanelOpen) {
          pendingSourceFocus = { article, preferAction };
        } else {
          returnSourceFocus(article, preferAction);
          void (async () => {
            await tick();
            if (article.isConnected && !article.parentElement?.contains(document.activeElement)) {
              returnSourceFocus(article, preferAction);
            }
          })();
        }
      } else if (shown && currentKeys.some((key) => !previousChipKeys.includes(key))) {
        sourceAnnouncement = '';
      }
    }
    sourcesWereShown = shown;
    previousChipKeys = currentKeys;
  });

  // Edit state
  let isEditing = $state(false);
  let editContent = $state('');
  let editPointerCapture: { pointerId: number; clientX: number; clientY: number } | undefined;
  const editPointerDragThreshold = 8;
  const canEdit = $derived(message.role === 'user' && onEdit !== undefined && !streaming);

  function startEditing() {
    editContent = textContent;
    isEditing = true;
    oneditingchange?.(true);
  }

  function captureEditPointer(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0) return;
    const button = event.currentTarget as HTMLButtonElement;
    try {
      button.setPointerCapture(event.pointerId);
      editPointerCapture = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
      };
    } catch {
      editPointerCapture = undefined;
    }
  }

  function releaseEditPointerAfterDrag(event: PointerEvent) {
    if (!editPointerCapture || event.pointerId !== editPointerCapture.pointerId) return;
    const horizontalMovement = event.clientX - editPointerCapture.clientX;
    const verticalMovement = event.clientY - editPointerCapture.clientY;
    if (Math.hypot(horizontalMovement, verticalMovement) < editPointerDragThreshold) return;

    editPointerCapture = undefined;
    try {
      (event.currentTarget as HTMLButtonElement).releasePointerCapture(event.pointerId);
    } catch {
      // The browser may already have released capture after pointer cancellation.
    }
  }

  function clearEditPointerCapture(event: PointerEvent) {
    if (editPointerCapture?.pointerId === event.pointerId) editPointerCapture = undefined;
  }

  function cancelEditing() {
    isEditing = false;
    editContent = '';
    oneditingchange?.(false);
  }

  function saveEdit() {
    const trimmedContent = editContent.trim();
    if (trimmedContent && trimmedContent !== textContent) {
      onEdit?.({ messageId: message.id, content: trimmedContent });
    }
    isEditing = false;
    editContent = '';
    oneditingchange?.(false);
  }

  onDestroy(() => {
    if (isEditing) oneditingchange?.(false);
  });

  function handleEditKeyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelEditing();
    }
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      saveEdit();
    }
  }

  // Detect failed delivery status from transient metadata
  const deliveryStatus = $derived(
    (message.metadata as Record<string, unknown>)?.['_deliveryStatus'] as string | undefined,
  );
  const isFailed = $derived(deliveryStatus === 'failed');
  // Sent but not yet acknowledged by the transport (a follow-up during a run).
  const isPending = $derived(deliveryStatus === 'sending');

  const messageTimeFormatter = new Intl.DateTimeFormat(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });
  const messageDateTimeFormatter = new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });

  /**
   * The time of day for a message written today, and the date with it ("Oct 29, 11:04 AM") for one
   * written on another day, so a message read later still says which day it is from.
   */
  function formatMessageTimestamp(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    const timestamp = new Date(value);
    if (Number.isNaN(timestamp.getTime())) return undefined;
    const today = timestamp.toDateString() === new Date().toDateString();
    return (today ? messageTimeFormatter : messageDateTimeFormatter).format(timestamp);
  }

  // Derived values for content processing. `textContent` drives message chrome
  // (copy, edit, the Show more/less control) — the rendered body itself flows
  // through deriveMessageParts + the parts renderer below.
  const textContent = $derived(getMessageText(message));
  const messageDirection = $derived(/[\u0590-\u08ff]/u.test(textContent) ? 'rtl' : 'ltr');
  const roleLabel = $derived(getMessageRoleLabel(message));
  const formattedCreatedAt = $derived(formatMessageTimestamp(message.createdAt));
  const createdAtValue = $derived(
    typeof message.createdAt === 'string' && formattedCreatedAt ? message.createdAt : undefined,
  );
  const hasMetadata = $derived(Boolean(formattedCreatedAt || metadata));

  // Role detection — kept for wrapper-level layout + a11y (data-tool-pair,
  // aria-label). The body branches that used to live here are now derived parts.
  const isToolCall = $derived(message.role === 'tool-call');

  // Find matching tool pair for tool-call messages. Resolved here (the container
  // hands down the pairs for this message) and threaded into deriveMessageParts
  // so the bridge stays pure; also gates the data-tool-pair wrapper styling.
  const questionStore = useQuestionStore();

  const toolPair = $derived.by(() => {
    if (!isToolCall || !message.toolCall) return null;
    return toolCallPairs.find((pair) => pair.call.id === message.toolCall?.id) ?? null;
  });

  // The cinder-owned render parts for this message. The streaming override and
  // expanded state are resolved into the parts here so the renderer + part
  // components stay dumb (no override/streaming plumbing leaks into them).
  // Approval state is UI-only and is threaded in so tool-approval parts
  // derive their Cinder state without mutating the transcript.
  const messageParts = $derived(
    deriveMessageParts(message, {
      toolCallPair: toolPair ?? undefined,
      overrideContent,
      streaming: contentStreaming,
      expanded,
      approvalStates,
      approvalResolutionInFlightIds,
      approvalReceipts,
      describeApproval,
      questionAnswers: questionStore?.answers,
      toolCallPresentation,
      // C4: reasoning and steps are UI-only overlays derived from metadata or
      // explicit per-message props; never written back to the transcript.
      reasoning,
      entries,
      notes,
      steps,
      // C5: suggestions are UI-only overlays; never written back to the transcript.
      suggestions,
    }),
  );

  // Whether this message has a markdown body part — gates the Show more/less
  // control (a tool-call/tool-result message has no markdown body to truncate).
  const hasMarkdownBody = $derived(messageParts.some((part) => part.type === 'markdown'));
  const approvalOnlyTurn = $derived(
    messageParts.some(
      (part) =>
        part.type === 'tool-approval' || (part.type === 'tool-input' && part.resolved !== true),
    ),
  );

  // Split the parts so the rendered DOM matches the historical structure: body
  // parts (text/markdown/tool) live inside `.chat-message-body`, image parts
  // render as a sibling AFTER it — exactly where MessageAttachments used to sit,
  // so the flex layout and spacing are unchanged.
  const transcript = $derived(presentation === 'transcript');

  // A settled assistant turn in the transcript shows the same actions every time: an action the
  // host offers that this turn cannot take is drawn disabled rather than left out, so the row never
  // changes shape from one turn to the next. A host that offers no handler gets no action.
  const settledAssistantTurn = $derived(
    transcript &&
      message.role === 'assistant' &&
      !isPending &&
      !streaming &&
      !isStreamingMessage(message),
  );
  const quoteAvailable = $derived(canQuote && !(transcript && isFailed));
  const regenerateAvailable = $derived(canRegenerate && !(transcript && isFailed));
  const showQuoteAction = $derived(
    quoteAvailable || (settledAssistantTurn && onQuote !== undefined),
  );
  const showRegenerateAction = $derived(
    regenerateAvailable || (settledAssistantTurn && onRegenerate !== undefined),
  );

  // The agent's instructions open the transcript as muted text, folded to one line by default.
  const systemRow = $derived(transcript && message.role === 'system');
  let systemOpen = $state(false);
  const shownParts = $derived(
    turnOwnsStop
      ? messageParts.filter((part) => !(part.type === 'note' && part.kind === 'stopped'))
      : messageParts,
  );
  // In the transcript a run's notes are rows of their own under the message, not lines inside its bubble.
  const noteParts = $derived(transcript ? shownParts.filter((part) => part.type === 'note') : []);
  const bodyParts = $derived(
    shownParts.filter((part) => part.type !== 'image' && !(transcript && part.type === 'note')),
  );
  const imageParts = $derived(shownParts.filter((part) => part.type === 'image'));
  const copyHtml = $derived.by(() => {
    const body = `<div data-cinder-chat-message style="white-space: pre-wrap">${escapeHtml(textContent)}</div>`;
    const attachmentChips = imageParts
      .map(
        (part, index) =>
          `<span data-cinder-chat-attachment data-url="${escapeClipboardHtmlAttribute(mediaDisplayUrl(part.image) ?? '')}">${escapeHtml(part.image.alt || `Image attachment ${index + 1}`)}</span>`,
      )
      .join('');
    return `${body}${attachmentChips}`;
  });
  // Copy carries the message's text. An image-only message has no text to copy, so it offers no
  // Copy action; a message with text still copies its images alongside it (`copyHtml`, `copyImage`).
  const copyValue = $derived(textContent);
  const copyImage = $derived.by(() => {
    return imageParts[0] === undefined ? undefined : mediaDisplayUrl(imageParts[0].image);
  });

  // Content truncation threshold (characters)
  const TRUNCATE_THRESHOLD = 500;

  // Accessibility IDs
  const messageId = $derived(idPrefix ? `${idPrefix}-message` : `message-${message.id}`);
  const roleId = $derived(`${messageId}-role`);
  const retryNoteId = $derived(`${messageId}-retry-note`);

  function toggleExpanded() {
    expanded = !expanded;
    onExpandedChange?.(expanded);
  }

  // Local fallback so a standalone <ChatMessage> (used outside <Chat>, with no
  // ontoolcalltoggle wired up) still has a working disclosure — mirrors
  // toggleExpanded above. When Chat DOES own this message's disclosure, it
  // passes toolCallExpanded down one-way (not bind:) and reads/writes its own
  // state via ontoolcalltoggle; this local flip is then a harmless echo that
  // gets overwritten by the container's next render. onExpandedChange also
  // fires here (not just ontoolcalltoggle) to preserve the pre-split contract,
  // where a single expanded/onExpandedChange pair covered every disclosure on
  // the message, including tool-call cards.
  function toggleToolCallExpanded() {
    toolCallExpanded = !toolCallExpanded;
    ontoolcalltoggle?.();
    onExpandedChange?.(toolCallExpanded);
  }

  // The same local fallback for the source list: `Chat` overwrites it on its next render.
  function toggleSourcesExpanded() {
    sourcesExpanded = !sourcesExpanded;
    onsourcestoggle?.();
  }
</script>

{#snippet transcriptLine()}
  <div
    class="chat-message-line"
    dir="ltr"
    data-message-direction={messageDirection}
    data-state={isFailed ? 'not-sent' : isPending ? 'queued' : 'sent'}
    role="group"
    aria-label="Message details"
  >
    {#if isFailed}
      <Popover
        bind:open={notSentOpen}
        placement="bottom-end"
        label="Not sent"
        focusManagement="panel"
      >
        {#snippet trigger()}
          <button
            type="button"
            class="chat-message-not-sent-icon"
            aria-label="Not sent: details"
            aria-expanded={notSentOpen}
            onclick={() => (notSentOpen = !notSentOpen)}
          >
            <CircleAlert aria-hidden="true" />
          </button>
        {/snippet}
        <div class="chat-message-not-sent-popover">
          <p class="chat-message-not-sent-summary">
            <CircleAlert class="chat-message-not-sent-glyph" aria-hidden="true" />
            <span>{notSent?.summary ?? 'Not sent. Your message is kept.'}</span>
          </p>
          {#if onRetry}
            <div class="chat-message-not-sent-actions">
              <Button
                type="button"
                class="chat-message-retry"
                size="xs"
                variant="secondary"
                aria-disabled={notSent?.retryDisabled === true ? 'true' : undefined}
                aria-describedby={notSent?.retryDisabled === true && notSent?.retryNote
                  ? retryNoteId
                  : undefined}
                onclick={() => onRetry(message.id)}
              >
                Retry
              </Button>
              {#if notSent?.retryNote}
                <span class="chat-message-not-sent-note" id={retryNoteId}>{notSent.retryNote}</span>
              {/if}
            </div>
          {/if}
        </div>
      </Popover>
      {#if createdAtValue && formattedCreatedAt && !approvalOnlyTurn}
        <time datetime={createdAtValue}><bdi>{formattedCreatedAt}</bdi></time>
      {/if}
      <span class="chat-message-not-sent-label" role="status">Not sent</span>
    {:else if isPending}
      <span class="chat-message-queued-label">Queued until the run is ready</span>
      {#if onRemoveQueued}
        <Button
          type="button"
          class="chat-message-remove-queued"
          size="xs"
          variant="ghost-accent"
          onclick={() => onRemoveQueued(message.id)}
        >
          Remove
        </Button>
      {/if}
    {:else if createdAtValue && formattedCreatedAt && !approvalOnlyTurn}
      <time datetime={createdAtValue}><bdi>{formattedCreatedAt}</bdi></time>
    {/if}
    {#if !isPending && !streaming}
      <span class="chat-message-line-actions">
        {@render messageIconActions()}
        {#if actions}
          {@render actions()}
        {/if}
        {#if metadata}
          {@render metadata()}
        {/if}
      </span>
    {/if}
  </div>
{/snippet}

{#snippet messageIconActions()}
  {#if showDefaultActions && copyValue}
    <Tooltip text={messageLabels.copy} placement="bottom" describe={false}>
      <CopyButton
        value={copyValue}
        html={copyHtml}
        {...copyImage ? { image: copyImage } : {}}
        label={transcript ? messageLabels.copy : messageLabels.copyMessage}
        iconOnly
        copiedLabel={messageLabels.copied}
        confirmDuration={2000}
        class="chat-message-action-button chat-message-copy"
      />
    </Tooltip>
  {/if}
  {#if showQuoteAction}
    <Tooltip text={messageLabels.quoteMessage} placement="bottom" describe={false}>
      <button
        type="button"
        class="chat-message-action-button chat-message-quote-button"
        onclick={quoteMessage}
        disabled={quoteDisabled || !quoteAvailable}
        aria-label={messageLabels.quoteMessage}
        aria-describedby={quoteDisabled && quoteAvailable ? quoteDisabledDescriptionId : undefined}
      >
        <Quote class="cinder-icon-xs" aria-hidden="true" />
      </button>
    </Tooltip>
  {/if}
  {#if showRegenerateAction}
    <Tooltip text={messageLabels.regenerate} placement="bottom" describe={false}>
      <button
        type="button"
        class="chat-message-action-button chat-message-regenerate-button"
        onclick={regenerateMessage}
        disabled={!regenerateAvailable}
        aria-label={transcript ? messageLabels.regenerate : messageLabels.regenerateResponse}
      >
        <RefreshCw class="cinder-icon-xs" aria-hidden="true" />
      </button>
    </Tooltip>
  {/if}
{/snippet}

{#snippet retryConnectionAction()}
  <RetryButton
    class="chat-turn-action"
    label={turnWords.retryNow}
    onclick={() => onRetryConnection?.(message.id)}
  />
{/snippet}

<!-- Continue first, as the primary choice, and Discard beside it; each says in its accessible
     description what it does to the partial answer above. -->
{#snippet stoppedTurnActions()}
  <span class="chat-turn-actions">
    {#if onContinueTurn}
      <Button
        type="button"
        class="chat-turn-action"
        size="sm"
        variant="primary"
        aria-describedby={`${messageId}-continue-description`}
        onclick={() => onContinueTurn(message.id)}>{turnWords.continue}</Button
      >
      <span id={`${messageId}-continue-description`} class="cinder-sr-only"
        >{turnWords.continueDescription}</span
      >
    {/if}
    {#if onDiscardTurn}
      <Button
        type="button"
        class="chat-turn-action"
        size="sm"
        variant="secondary"
        aria-describedby={`${messageId}-discard-description`}
        onclick={() => onDiscardTurn(message.id)}>{turnWords.discard}</Button
      >
      <span id={`${messageId}-discard-description`} class="cinder-sr-only"
        >{turnWords.discardDescription}</span
      >
    {/if}
  </span>
{/snippet}

<!-- What a turn that has not simply finished says on itself (COR-2283), with the controls that
     recover it. Every notice is the one Cinder Callout: the tone icon, the text, and the action
     inline at the end. A streaming or complete turn draws nothing here. -->
{#snippet turnOutcome()}
  {#if turn.kind === 'reconnecting'}
    <div class="chat-turn-outcome" data-kind="reconnecting">
      <Callout
        variant="warning"
        semantic="note"
        class="chat-turn-callout"
        {...onRetryConnection ? { action: retryConnectionAction } : {}}
      >
        {#snippet icon()}<WifiOff aria-hidden="true" />{/snippet}
        <p class="chat-turn-text" dir="auto">
          {turnWords.reconnecting(turn.attempt, turn.attempts, turn.nextTryIn)}
        </p>
        {#snippet progress()}
          <Progress
            class="chat-turn-wait"
            value={Math.round(reconnectWaitFraction(turn) * 100)}
            max={100}
            size="sm"
            ariaLabel={turnWords.nextTry}
            label={formatCountdown(turn.nextTryIn)}
          />
        {/snippet}
      </Callout>
    </div>
  {:else if turn.kind === 'stopped'}
    <div class="chat-turn-outcome" data-kind="stopped">
      <Callout
        variant="neutral"
        semantic="note"
        class="chat-turn-callout chat-turn-stopped-card"
        {...onDiscardTurn || onContinueTurn ? { action: stoppedTurnActions } : {}}
      >
        {#snippet icon()}<Info aria-hidden="true" />{/snippet}
        <p class="chat-turn-text" dir="auto">{turnWords.stopped}</p>
      </Callout>
    </div>
  {:else if turn.kind === 'failed'}
    <div class="chat-turn-outcome" data-kind="failed">
      <Callout
        variant="danger"
        semantic="note"
        class="chat-turn-callout chat-turn-alert"
        title={turnWords.incomplete}
        {...onRetryTurn ? { action: retryTurnAction } : {}}
      >
        {#snippet icon()}<CircleAlert aria-hidden="true" />{/snippet}
        <p class="chat-turn-text chat-turn-failure-body" dir="auto">
          {turn.cause}
          {turn.keeps ?? turnWords.retryKeeps}
        </p>
      </Callout>
    </div>
  {:else if turn.kind === 'empty'}
    <div class="chat-turn-outcome chat-turn-empty" data-kind="empty">
      <Callout
        variant="neutral"
        semantic="note"
        class="chat-turn-callout chat-turn-empty-card"
        {...onRetryTurn ? { action: retryTurnAction } : {}}
      >
        {#snippet icon()}<Info aria-hidden="true" />{/snippet}
        <p class="chat-turn-text" dir="auto" role="status">{turnWords.empty}</p>
      </Callout>
    </div>
  {/if}
{/snippet}

{#snippet retryTurnAction()}
  <RetryButton
    class="chat-turn-action"
    label={turn.kind === 'empty' ? turnWords.tryAgain : turnWords.retry}
    onclick={() => onRetryTurn?.(message.id)}
  />
{/snippet}

<div
  class={classNames('chat-message-wrapper', className)}
  dir="ltr"
  data-presentation={transcript ? 'transcript' : undefined}
  data-streaming={streaming || undefined}
  data-turn-state={turn.kind === 'complete' ? undefined : turn.kind}
  data-role={message.role}
  data-message-direction={messageDirection}
  data-hidden={message.hidden || undefined}
  data-failed={isFailed || undefined}
  data-pending={isPending || undefined}
  data-search-match={searchMatch || undefined}
  data-tool-pair={isToolCall && toolPair ? '' : undefined}
  data-cinder-rollback-discarded={rollbackDiscarded || undefined}
  {...rest}
>
  {#if message.role === 'assistant'}
    <span class="cinder-sr-only" role="status">{sourceAnnouncement}</span>
  {/if}
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <article
    bind:this={articleElement}
    id={messageId}
    class="chat-message chat-navigation-row"
    dir="ltr"
    data-message-id={message.id}
    data-message-role={message.role}
    aria-labelledby={isToolCall && toolPair ? undefined : roleId}
    aria-label={isToolCall && toolPair ? `Tool call: ${toolPair.call.name}` : undefined}
    aria-busy={streaming ? 'true' : undefined}
    {tabindex}
  >
    <header class="chat-message-header">
      <span id={roleId} class="chat-message-role">{roleLabel}</span>
    </header>

    {#if systemRow}
      <button
        type="button"
        class="chat-message-system-toggle"
        aria-expanded={systemOpen}
        aria-controls={`${messageId}-body`}
        onclick={() => (systemOpen = !systemOpen)}
      >
        <ChevronRight class="chat-message-system-chevron" aria-hidden="true" />
        Instructions
      </button>
    {/if}

    <div
      class="chat-message-body"
      dir="auto"
      id={systemRow ? `${messageId}-body` : undefined}
      hidden={systemRow && !systemOpen}
    >
      {#if isEditing}
        <!-- Edit mode replaces the body parts with a textarea, but attachments
             stay visible (they were never inside the editable body). -->
        <div class="chat-message-edit">
          <!-- svelte-ignore a11y_autofocus -->
          <textarea
            class="chat-message-edit-textarea"
            bind:value={editContent}
            onkeydown={handleEditKeyDown}
            dir="auto"
            autofocus
            aria-label="Edit message content"
            rows={Math.min(Math.max(editContent.split('\n').length, 2), 10)}></textarea>
          <div class="chat-message-edit-actions">
            <Button
              type="button"
              class="chat-message-edit-save"
              size="xs"
              variant="primary"
              aria-label="Save & Resend"
              onclick={saveEdit}
            >
              Save
            </Button>
            <Button
              type="button"
              class="chat-message-edit-cancel"
              size="xs"
              variant="secondary"
              onclick={cancelEditing}
            >
              Cancel
            </Button>
          </div>
        </div>
      {:else}
        <!-- Replaces the historical role-branch body: every body render shape
             (tool call, tool result, markdown text) flows through the cinder-
             owned parts spine. The renderer keeps stable DOM identity across
             streaming updates via per-part keys, so the markdown body never
             remounts as its text grows. Image parts render below, as a sibling
             of this body div, matching the historical structure. -->
        <ChatMessagePartsRenderer
          parts={bodyParts}
          {messageId}
          {messagePart}
          {approvalLayout}
          {markdownNode}
          quoteSource={canQuote ? message.id : undefined}
          expanded={toolCallExpanded}
          onToggle={toggleToolCallExpanded}
          {onApprovalResolve}
          {onApprovalRequestAgain}
          {onInputSubmit}
          {reasoningExpanded}
          {onreasoning}
          {stepsExpanded}
          {onsteps}
          {onSuggestionSelect}
          {toolActivityActive}
          {onRetryStep}
          {toolCallDurations}
          {toolCallStartTimes}
          {turnLabels}
          labels={messageLabels}
        />

        {#if hasMarkdownBody && textContent.length > TRUNCATE_THRESHOLD}
          <button type="button" class="chat-message-expand" onclick={toggleExpanded}>
            {expanded ? messageLabels.showLess : messageLabels.showMore}
          </button>
        {/if}
      {/if}
    </div>

    {#if imageParts.length > 0}
      <!-- Images render through the grouped default path (the attachment grid
           lays out by total count); they do not flow through `messagePart`. -->
      <ChatMessagePartsRenderer parts={imageParts} {messageId} />
    {/if}

    {#if shownSources && !transcript}
      <div class="chat-message-sources" dir={messageDirection} bind:this={sourcesElement}>
        <MessageSources
          sources={shownSources}
          presentation={sourcePresentation}
          expanded={sourcesExpanded}
          ontoggle={toggleSourcesExpanded}
          listId={`${messageId}-sources`}
          announce={onAnnounce}
          onCitationCloseComplete={completeSourceWithdrawal}
          labels={messageLabels}
        />
      </div>
    {/if}

    {#if isPending && !transcript}
      <div class="chat-message-pending-actions">
        <span class="chat-message-pending-label">{messageLabels.sending}</span>
      </div>
    {/if}

    {#if isFailed && onRetry && !transcript}
      <div class="chat-message-failed-actions">
        <span class="chat-message-failed-label" role="alert">Failed to send</span>
        <Button
          type="button"
          class="chat-message-retry"
          size="xs"
          variant="ghost-danger"
          iconOnly
          label="Retry"
          onclick={() => onRetry(message.id)}
        >
          <RotateCcw class="cinder-icon-xs" />
        </Button>
      </div>
    {/if}

    {#if status}
      <div class="chat-message-status">
        {@render status()}
      </div>
    {/if}
  </article>

  {#if !isEditing}
    {@render turnOutcome()}
  {/if}

  {#if transcript}
    <!-- A reply that is unfinished (streaming now, or its stream dropped and is reconnecting) has no
         line under it yet: no time, Copy or Quote until it ends. A stopped or failed turn has its
         line again, and so does an empty one, which carries its time there. -->
    {#if !isEditing && !systemRow && turnPresentation.line}
      <!-- The sources sit under the prose, on their own block; the line below keeps only the time
           and the actions, on one row. -->
      {#if shownSources}
        <div class="chat-message-sources" dir={messageDirection} bind:this={sourcesElement}>
          <MessageSources
            sources={shownSources}
            presentation={sourcePresentation}
            expanded={sourcesExpanded}
            ontoggle={toggleSourcesExpanded}
            listId={`${messageId}-sources`}
            onCitationCloseComplete={completeSourceWithdrawal}
            labels={messageLabels}
          />
        </div>
      {/if}
      {@render transcriptLine()}
    {/if}
    {#if noteParts.length > 0}
      <div class="chat-message-notes">
        <ChatMessagePartsRenderer parts={noteParts} {messageId} {noteAction} />
      </div>
    {/if}
  {/if}

  {#if hasMetadata && !transcript}
    <div class="chat-message-metadata">
      {#if createdAtValue && formattedCreatedAt}
        <time datetime={createdAtValue}><bdi>{formattedCreatedAt}</bdi></time>
      {/if}
      {#if metadata}
        {@render metadata()}
      {/if}
    </div>
  {/if}

  {#if !transcript && !isEditing && (actions || canQuote || canRegenerate || (showDefaultActions && copyValue) || canEdit || (message.role === 'user' && onRollback))}
    <footer class="chat-message-footer" role="none">
      <div class="chat-message-actions" role="group" aria-label="Message actions">
        {#if actions}
          {@render actions()}
        {/if}
        {@render messageIconActions()}
        {#if canEdit}
          <button
            type="button"
            class="chat-message-action-button chat-message-edit-button"
            onpointerdown={captureEditPointer}
            onpointermove={releaseEditPointerAfterDrag}
            onpointerup={clearEditPointerCapture}
            onpointercancel={clearEditPointerCapture}
            onlostpointercapture={clearEditPointerCapture}
            onclick={startEditing}
            aria-label="Edit message"
          >
            <Pencil class="cinder-icon-xs" />
          </button>
        {/if}
        {#if message.role === 'user' && onRollback}
          <button
            type="button"
            class="chat-message-action-button chat-message-rollback-button"
            onclick={() => onRollback?.(message.id)}
            aria-label="Rollback conversation to this message"
          >
            <RotateCcw class="cinder-icon-xs" />
          </button>
        {/if}
      </div>
    </footer>
  {/if}
</div>

<style>
  /* Wrapper — handles layout positioning, width constraints, and hover delegation.
   * position: relative anchors the absolutely-positioned action footer below. */
  .chat-message-wrapper {
    display: flex;
    flex-direction: column;
    position: relative;
    width: fit-content;
    /* Cap at 80% of container OR the shared readability max-width (768px
     * default) for wide screens. Same token tool-call-timeline.svelte's
     * .chat-tool-call-timeline reads, so the two can never drift apart. */
    max-width: min(80%, var(--cinder-chat-message-max-width, 48rem));
  }

  .chat-message-wrapper[data-cinder-rollback-discarded] {
    opacity: 0.32;
    filter: saturate(0.35);
    pointer-events: none;
    transition:
      opacity var(--cinder-duration-fast) var(--cinder-ease-standard),
      filter var(--cinder-duration-fast) var(--cinder-ease-standard);
  }

  /* Bubble — visual container for the message content */
  .chat-message {
    display: flex;
    flex-direction: column;
    gap: 0;
    padding: var(--cinder-space-2) var(--cinder-space-3);
    border-radius: var(--cinder-radius-lg);
    background: var(--cinder-surface);

    /* Performance: Skip rendering for off-screen messages in long conversations.
     * content-visibility: auto tells browser to skip layout/paint for off-screen elements.
     * contain-intrinsic-size: auto <fallback> uses cached height after render, fallback before.
     *
     * Trade-off: Before messages are rendered, scrollHeight uses the fallback estimate.
     * This can affect isAtBottom calculations for variable-height content (images, code blocks).
     * The 180px fallback is conservative to minimize scroll metric inaccuracy.
     * Once scrolled into view, actual heights are cached and metrics become accurate. */
    content-visibility: auto;
    contain-intrinsic-size: auto 180px;
  }

  /* Virtual rows already bind mounted content to the visible window, so they
   * must measure their real message height instead of an intrinsic fallback. */
  :global(.chat-virtual-row) .chat-message {
    content-visibility: visible;
  }

  /* A card that waits on a decision is always laid out and hit-testable: the transcript scrolls
   * its buttons into view, and a row still skipped for the frame that scroll lands in would take
   * the tap itself. */
  .chat-message:has(:global(.cinder-approval-card[data-cinder-state='pending'])) {
    content-visibility: visible;
  }

  /* An answered question ends its message on the receipt's "Change" action, whose 44px hit area
   * overhangs the 28px control. `content-visibility: auto` contains paint at the message's own
   * edge, so the overhang below the last line would not be hit-testable; the row is laid out in
   * full instead (one receipt is a few lines, so nothing is saved by skipping it). */
  .chat-message:has(:global(.chat-question-receipt)) {
    content-visibility: visible;
  }

  /* Escape hatch for a deliberate programmatic scroll-to-bottom
     (use-chat-scroll-state.svelte.ts): while `.chat-timeline` carries
     `data-cinder-force-visible`, every row lays out at its real height up
     front instead of the 180px estimate above. Without this, off-screen rows
     resize as they cross into view DURING an animated scrollTo(), which
     shifts content under a fixed pixel target and reads as a jerk right as
     the scroll finishes. */
  :global(.chat-timeline[data-cinder-force-visible]) .chat-message {
    content-visibility: visible;
  }

  /* Focus visible style for keyboard navigation */
  .chat-message:focus {
    outline: none;
  }

  .chat-message:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: var(--_cinder-focus-ring-shadow);
  }

  /* Search match highlight — subtle accent-tinted ring */
  .chat-message-wrapper[data-search-match] .chat-message {
    outline: 2px solid color-mix(in oklch, var(--cinder-accent-solid), transparent 40%);
    outline-offset: 2px;
    background: color-mix(in oklch, var(--cinder-accent-solid), transparent 92%);
  }

  /* Role-based alignment (on wrapper) and visual styling (on bubble) */
  .chat-message-wrapper[data-role='user'] {
    margin-inline-start: auto;
    /* Anchor for absolutely-positioned user-message header (see below). */
    position: relative;
  }

  .chat-message-wrapper[data-role='user'] .chat-message {
    /* Distinctive user bubble - subtle blue tint */
    background: var(
      --user-message-background,
      color-mix(in oklch, var(--cinder-accent-solid), transparent 88%)
    );
    border-radius: var(--cinder-radius-lg) var(--cinder-radius-lg) var(--cinder-radius-sm)
      var(--cinder-radius-lg);
  }

  .chat-message-wrapper[data-role='assistant'] {
    margin-inline-end: auto;
    inline-size: min(100%, var(--cinder-chat-message-max-width, 48rem));
  }

  .chat-message-wrapper[data-role='assistant'] .chat-message {
    box-sizing: border-box;
    inline-size: min(100%, var(--cinder-chat-message-max-width, 48rem));
    background: var(--cinder-surface);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-lg) var(--cinder-radius-lg) var(--cinder-radius-lg)
      var(--cinder-radius-sm);
    box-shadow: var(--cinder-shadow-sm);
    padding-block: 0;
  }

  .chat-message-wrapper[data-role='system'] {
    margin-inline: auto;
    max-width: min(90%, var(--cinder-chat-message-max-width, 48rem));
  }

  .chat-message-wrapper[data-role='system'] .chat-message {
    background: var(--cinder-status-info-background);
    color: var(--cinder-status-info-text);
    text-align: center;
  }

  .chat-message-wrapper[data-role='developer'] {
    margin-inline-end: auto;
  }

  .chat-message-wrapper[data-role='developer'] .chat-message {
    background: var(--cinder-status-warning-background);
    color: var(--cinder-status-warning-text);
  }

  .chat-message-wrapper[data-role='tool-call'],
  .chat-message-wrapper[data-role='tool-result'] {
    margin-inline-end: auto;
    min-width: min(18rem, 100%);
    max-width: min(100%, var(--cinder-chat-message-max-width, 48rem));
  }

  .chat-message-wrapper[data-role='tool-call'] .chat-message,
  .chat-message-wrapper[data-role='tool-result'] .chat-message {
    background: var(--cinder-surface-inset);
    font-family: var(--cinder-font-mono);
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
  }

  /* When a tool-call has a paired result, ToolCallTimeline is the canonical card.
   * Strip the outer bubble shell (background, border, padding, role label, footer)
   * so the unified card is the only visible boundary. The wrapper expands
   * within the same readability cap as regular bubbles — chat bubbles hug
   * their content, but a tool-call card is structural data that benefits
   * from horizontal room without stretching across the entire timeline. */
  .chat-message-wrapper[data-tool-pair] {
    inline-size: 100%;
    max-inline-size: var(--cinder-chat-message-max-width, 48rem);
    min-inline-size: 0;
  }

  @container (max-width: 480px) {
    .chat-message-wrapper[data-tool-pair] {
      width: 100%;
    }
  }

  .chat-message-wrapper[data-tool-pair] .chat-message {
    background: none;
    border: none;
    padding: 0;
    border-radius: 0;
    gap: 0;
    font-family: inherit;
    font-size: inherit;
  }

  .chat-message-wrapper[data-tool-pair] .chat-message-header {
    display: none;
  }

  /* Hidden-by-default like every other row's footer (opacity/pointer-events,
   * toggled visible on :hover/:focus-within by the shared rule below) rather
   * than `display: none` — a `display: none` element can never be hovered,
   * focused, or hit-tested, which would make retry/edit/copy and any
   * consumer-supplied `messageActions` snippet content permanently
   * unreachable by mouse or keyboard on tool-paired rows. */
  .chat-message-wrapper[data-tool-pair] .chat-message-footer {
    opacity: 0;
    pointer-events: none;
  }

  .chat-message-wrapper[data-role='snapshot'] {
    margin-inline: auto;
  }

  .chat-message-wrapper[data-role='snapshot'] .chat-message {
    background: var(--cinder-surface-inset);
    opacity: 0.7;
  }

  .chat-message-wrapper[data-hidden] .chat-message {
    /* Use visual styling that maintains WCAG AA contrast ratios */
    border: 1px dashed var(--cinder-border);
    background: color-mix(in oklch, var(--cinder-surface), var(--cinder-border-muted) 10%);
  }

  .chat-message-wrapper[data-hidden] .chat-message::before {
    content: 'Hidden';
    display: inline-block;
    font-size: var(--_cinder-chat-text-xs, var(--cinder-text-xs));
    font-weight: var(--cinder-font-medium);
    color: var(--cinder-text-muted);
    padding: var(--cinder-space-0-5) var(--cinder-space-1);
    background: var(--cinder-surface);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-sm);
    margin-inline-end: var(--cinder-space-2);
  }

  /* Header */
  .chat-message-header {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-2);
    flex-wrap: wrap;
  }

  .chat-message-role {
    font-size: var(--_cinder-chat-text-xs, var(--cinder-text-xs));
    font-weight: var(--cinder-font-semibold);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--cinder-text-muted);
  }

  /* Take the header OUT of the bubble's flex flow for user messages so the
     bubble's row gap is not allocated for an empty header row, which would
     create visible empty space above the message text. `position: absolute`
     removes it from the flex axis entirely (flex `gap` applies only to
     in-flow children) while keeping it in the accessibility tree with its
     implicit role intact — `display: contents` would strip that role.
     The role label is already visually hidden via .chat-message-role below;
     do NOT clip the whole header, or any `status` snippet a consumer passes
     (e.g. "sending…", "failed") would also disappear. Anchor the header to
     the bubble's top-right so status content stays visible without
     displacing the message text. */
  .chat-message-wrapper[data-role='user'] .chat-message-header {
    position: absolute;
    inset-block-start: 0;
    inset-inline-end: 0;
    padding: 0;
    margin: 0;
  }

  /* Hide role label for user messages since alignment makes it clear */
  .chat-message-wrapper[data-role='user'] .chat-message-role {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .chat-message-metadata {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-2);
    min-height: 1rem;
    margin-block-start: var(--cinder-space-1);
    padding-inline: var(--cinder-space-1);
    color: var(--cinder-text-muted);
    font-size: var(--_cinder-chat-text-xs, var(--cinder-text-xs));
    line-height: 1.2;
  }

  .chat-message-metadata time {
    opacity: 1;
    transition: opacity var(--cinder-duration-fast) var(--cinder-ease-standard);
  }

  @media (hover: hover) and (pointer: fine) {
    .chat-message-metadata time {
      opacity: 0;
    }

    .chat-message-wrapper:hover .chat-message-metadata time,
    .chat-message-wrapper:focus-within .chat-message-metadata time {
      opacity: 1;
    }
  }

  .chat-message-wrapper[data-role='user'] .chat-message-metadata {
    justify-content: flex-end;
  }

  .chat-message-status {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-1);
  }

  /* Body */
  /* Flex column so stacked body parts (e.g. a tool-call card followed by a
     tool-approval prompt, or a step list + reasoning block + final markdown
     answer) get visible breathing room between them via `gap`. Without this,
     parts are plain block children with zero margin and sit flush against
     each other. */
  .chat-message-body {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    font-size: var(--_cinder-chat-text-base, var(--cinder-text-base));
    line-height: 1.6;
  }

  /* Tool-result body styling moved to tool-result-part.svelte alongside its
     markup (the parts spine now owns that body shape). */

  .chat-message-expand {
    /* .chat-message-body is a flex column now (for inter-part gap); without
       this, the default flex align-items:stretch would balloon this button to
       the container's full width instead of shrinking to its label. */
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: var(--cinder-space-0-5);
    position: relative;
    padding: var(--cinder-space-0-5) var(--cinder-space-1);
    font-size: var(--_cinder-chat-text-xs, var(--cinder-text-xs));
    font-weight: var(--cinder-font-medium);
    color: var(--cinder-accent-text);
    background: transparent;
    border: none;
    cursor: pointer;
  }

  .chat-message-expand:hover {
    text-decoration: underline;
  }

  /* The painted label stays compact; its 44px hit area is a pseudo-element that takes no layout. */
  .chat-message-expand::after {
    content: '';
    position: absolute;
    inset-block: min(0px, calc((100% - var(--cinder-touch-target-min)) / 2));
    inset-inline: 0;
  }

  /* The Sources control sits under the body, on its own line, and never widens the message. */
  .chat-message-sources {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    min-width: 0;
    margin-block-start: var(--cinder-space-1);
  }

  /* The Sources block takes the message's direction (`dir` on the block), so its control and list
     start at the message's inline start in either; no physical alignment is needed. */

  .chat-message-expand:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: var(--_cinder-focus-ring-shadow);
  }

  /* Failed message styling */
  .chat-message-wrapper[data-failed] .chat-message {
    border: 1px solid var(--cinder-status-danger-border);
    background: var(--cinder-status-danger-background);
  }

  /* Pending (sent, not yet acknowledged): the label carries the state, not opacity. */
  .chat-message-pending-actions {
    display: flex;
    align-items: center;
    margin-top: var(--cinder-space-1);
  }

  .chat-message-pending-label {
    font-size: var(--_cinder-chat-text-xs, var(--cinder-text-xs));
    color: var(--cinder-text-muted);
  }

  .chat-message-failed-actions {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-2);
    margin-top: var(--cinder-space-1);
  }

  .chat-message-failed-label {
    font-size: var(--_cinder-chat-text-xs, var(--cinder-text-xs));
    color: var(--cinder-status-danger-text);
    font-weight: var(--cinder-font-medium);
  }

  :global(.chat-message-retry) {
    inline-size: 2rem;
    min-inline-size: 2rem;
    max-inline-size: 2rem;
    block-size: 2rem;
    min-block-size: 2rem;
    padding: 0;
  }

  .chat-message-retry:focus-visible,
  .chat-message-edit-save:focus-visible,
  .chat-message-edit-cancel:focus-visible,
  :global(.chat-message-retry:focus-visible),
  :global(.chat-message-edit-save:focus-visible),
  :global(.chat-message-edit-cancel:focus-visible) {
    outline: var(--cinder-ring-width) solid transparent;
    outline-offset: var(--cinder-ring-offset);
    box-shadow: var(--_cinder-focus-ring-shadow);
  }

  /* Footer — absolutely positioned outside the bubble's flow so revealing it on
   * hover/focus does not change the bubble's height. Default geometry: below the
   * bubble at the leading edge, which works for any role. Padding preserves the
   * visual spacing while making that space part of the footer's hit area, so the
   * wrapper stays hovered as the pointer crosses from bubble to actions. The
   * user/assistant rules below override this to put the icon beside the bubble
   * on the center-facing edge. Roles like developer / system / unpaired
   * tool-result inherit this default and place the footer below the bubble.
   * LTR-only: the left/right physical properties below assume left-to-right layout.
   * RTL support is a follow-up that swaps to inset-inline-start/end. */
  .chat-message-footer {
    position: absolute;
    top: 100%;
    left: 0;
    width: max-content;
    padding-top: var(--cinder-space-1);
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--cinder-duration-fast) var(--cinder-ease-standard);
  }

  /* User bubbles are right-aligned; copy icon sits to their LEFT (toward chat center).
   * The footer is anchored to the wrapper's bottom edge AND to the bubble's
   * outer edge horizontally; the action button inside aligns its own bottom
   * with the wrapper bottom so it sits flush with the bubble bottom.
   * padding (not margin) creates a hover bridge so the pointer never leaves a
   * hovered surface while crossing from bubble to icon. */
  .chat-message-wrapper[data-role='user'] .chat-message-footer {
    top: auto;
    bottom: 0;
    left: auto;
    right: 100%;
    margin-top: 0;
    padding-top: 0;
    display: flex;
    align-items: flex-end;
    /* Padding stays physical to match the physical `right: 100%` placement
       above; the whole block is the LTR-only fast path called out in the
       comment at the top of this section. */
    padding-right: var(--cinder-space-1);
  }

  /* Assistant bubbles are left-aligned; copy icon sits to their RIGHT. */
  .chat-message-wrapper[data-role='assistant'] .chat-message-footer {
    top: auto;
    bottom: 0;
    left: 100%;
    right: auto;
    margin-top: 0;
    padding-top: 0;
    display: flex;
    align-items: flex-end;
    padding-left: var(--cinder-space-1);
  }

  /* Keep the action tray on the center-facing side when message prose sets the
   * inherited direction to RTL. The tray order remains LTR so Copy/Quote and
   * the other controls keep their documented sequence. */
  .chat-message-wrapper:dir(rtl)[data-role='user'] .chat-message-footer {
    left: 100%;
    right: auto;
    padding-left: var(--cinder-space-1);
    padding-right: 0;
  }

  .chat-message-wrapper:dir(rtl)[data-role='assistant'] .chat-message-footer {
    left: auto;
    right: 100%;
    padding-left: 0;
    padding-right: var(--cinder-space-1);
  }

  .chat-message-wrapper:has(:global(.message-content):dir(rtl))[data-role='assistant']
    .chat-message-footer {
    left: auto;
    right: 0;
    padding-inline: 0;
  }

  .chat-message-wrapper[data-message-direction='rtl'][data-role='assistant'] .chat-message-footer {
    left: auto;
    right: 0;
    padding-inline: 0;
  }

  .chat-message-wrapper:hover .chat-message-footer,
  .chat-message-wrapper:focus-within .chat-message-footer {
    opacity: 1;
    pointer-events: auto;
  }

  .chat-message-actions {
    display: flex;
    gap: 0;
    direction: ltr;
  }

  /* Narrow viewports: every role falls back to below-bubble where horizontal
   * space is tight. Each selector explicitly matches the same specificity as
   * the role-specific desktop rules above ([data-role='…'] = 0-1-1), so the
   * media query actually wins inside its breakpoint. */
  @media (max-width: 480px) {
    .chat-message-wrapper[data-role='user'] .chat-message-footer,
    .chat-message-wrapper[data-role='assistant'] .chat-message-footer,
    .chat-message-wrapper[data-role='system'] .chat-message-footer,
    .chat-message-wrapper[data-role='developer'] .chat-message-footer,
    .chat-message-wrapper[data-role='tool-call'] .chat-message-footer,
    .chat-message-wrapper[data-role='tool-result'] .chat-message-footer,
    .chat-message-wrapper[data-role='snapshot'] .chat-message-footer {
      top: 100%;
      bottom: auto;
      inset-inline-start: 0;
      inset-inline-end: auto;
      transform: none;
      padding-inline: 0;
      padding-top: var(--cinder-space-1);
      margin-top: 0;
    }

    /* User and assistant footers move below the bubble only at this breakpoint.
     * On touch/coarse-pointer devices they are persistently visible, so reserve
     * their action row here. Hover-capable layouts reveal it on demand and must
     * not reserve an empty row while the footer is hidden. */
    @media (hover: none) or (pointer: coarse) {
      .chat-message-wrapper[data-role='user']:has(
          > .chat-message-footer .chat-message-actions > :global(*)
        ),
      .chat-message-wrapper[data-role='assistant']:has(
          > .chat-message-footer .chat-message-actions > :global(*)
        ) {
        margin-block-end: calc(var(--cinder-touch-target-min) + var(--cinder-space-1));
      }
    }
  }

  /* Touch devices: always show actions. The tool-pair override above has
   * higher specificity ([data-tool-pair] + .chat-message-wrapper +
   * .chat-message-footer) than the bare `.chat-message-footer` below, so it
   * needs its own entry here — otherwise touch users would hit the same
   * "always opacity: 0" dead end on tool-paired rows that :hover/:focus-within
   * fixes for pointer/keyboard. */
  @media (hover: none) or (pointer: coarse) {
    .chat-message-footer,
    .chat-message-wrapper[data-tool-pair] .chat-message-footer {
      opacity: 1;
      pointer-events: auto;
    }

    /* These roles use the default below-bubble footer at every width. Reserve
     * space whenever that persistently visible touch footer has content. */
    .chat-message-wrapper[data-role='system']:has(
        > .chat-message-footer .chat-message-actions > :global(*)
      ),
    .chat-message-wrapper[data-role='developer']:has(
        > .chat-message-footer .chat-message-actions > :global(*)
      ),
    .chat-message-wrapper[data-role='tool-call']:has(
        > .chat-message-footer .chat-message-actions > :global(*)
      ),
    .chat-message-wrapper[data-role='tool-result']:has(
        > .chat-message-footer .chat-message-actions > :global(*)
      ),
    .chat-message-wrapper[data-role='snapshot']:has(
        > .chat-message-footer .chat-message-actions > :global(*)
      ) {
      margin-block-end: calc(var(--cinder-touch-target-min) + var(--cinder-space-1));
    }
  }

  /* Shared base for the built-in copy and edit action buttons — small
   * icon-only affordances. The icon size comes from the `cinder-icon-xs` class on the
   * SVG (defined in styles/utilities.css). A transparent border reserves layout
   * space so the touch-context border swap below does not shift the icon.
   *
   * These rules use :global() because the copy button is rendered by the
   * CopyButton child component — Svelte's scoped hash would not reach an
   * element whose <button> lives in a different component's template. The edit
   * button is still a native button in this template and matches via class
   * name either way. */
  :global(.chat-message-action-button) {
    display: grid;
    place-items: center;
    box-sizing: border-box;
    min-width: var(--cinder-touch-target-min);
    min-height: var(--cinder-touch-target-min);
    padding: 0;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--cinder-radius-sm);
    color: var(--cinder-text-muted);
    cursor: pointer;
    transition:
      color var(--cinder-duration-fast) var(--cinder-ease-standard),
      border-color var(--cinder-duration-fast) var(--cinder-ease-standard),
      background var(--cinder-duration-fast) var(--cinder-ease-standard);
  }

  @media (hover: hover) {
    :global(.chat-message-action-button:hover) {
      color: var(--cinder-text-default);
      background: var(--cinder-surface-hover);
    }
  }

  :global(.chat-message-action-button:focus-visible),
  :global(.chat-message-action-button[data-citation-focus]:focus),
  .chat-message[data-citation-focus]:focus {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: var(--_cinder-focus-ring-shadow);
  }

  :global(.chat-message-action-button:disabled) {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Touch devices: without hover discoverability, bare icons read as
   * decoration. Give the action buttons a resting surface + border so they look
   * tappable. Placed after the base rule so it wins at equal specificity; the
   * transparent base border reserves the space, so this only swaps color — no
   * layout shift. */
  @media (hover: none) or (pointer: coarse) {
    :global(.chat-message-action-button) {
      background: var(--cinder-surface-raised);
      border-color: var(--cinder-border-control);
    }
  }

  /* Copy success state overrides the shared color.
   * CopyButton uses `data-cinder-copied` when the copy succeeds.
   * Keep `.chat-message-copy-success` as a selector alias so existing
   * external callers that target it continue to work. */
  :global(.chat-message-copy[data-cinder-copied]) {
    color: var(--cinder-status-success-text);
  }

  /* CopyButton renders cinder-icon-sm (16px) icons by default. Override to cinder-icon-xs
   * (14px) to match the sibling edit/retry action buttons in the chat footer. */
  :global(.chat-message-copy svg) {
    width: 0.875rem;
    height: 0.875rem;
  }

  @media (hover: hover) {
    :global(.chat-message-copy[data-cinder-copied]:hover) {
      color: var(--cinder-status-success-text);
      background: var(--cinder-status-success-background);
    }
  }

  /* Edit mode */
  .chat-message-edit {
    display: flex;
    flex-direction: column;
    gap: 0;
  }

  .chat-message-edit-textarea {
    width: 100%;
    padding: var(--cinder-space-2);
    font-family: inherit;
    font-size: var(--_cinder-chat-text-base, var(--cinder-text-base));
    line-height: 1.6;
    color: var(--cinder-text-default);
    background: var(--cinder-control-background);
    border: 1px solid var(--cinder-accent-solid);
    border-radius: var(--cinder-control-radius);
    resize: vertical;
    outline: none;
  }

  .chat-message-edit-textarea:focus {
    outline: var(--cinder-ring-width) solid transparent;
    outline-offset: var(--cinder-ring-offset);
    box-shadow: var(--_cinder-focus-ring-shadow);
  }

  .chat-message-edit-actions {
    display: flex;
    gap: var(--cinder-space-2);
    align-items: center;
  }

  /* Responsive sizing for narrow viewports */
  @media (max-width: 480px) {
    .chat-message-wrapper {
      /* On narrow screens, allow messages to use more of the width */
      max-width: 95%;
    }

    .chat-message {
      padding: var(--cinder-space-2) var(--cinder-space-3);
    }
  }

  /* Forced-colors: box-shadow rings are suppressed in Windows High Contrast Mode,
     so repaint the reserved transparent outline channel with a system color.
     Text-entry focus uses Highlight; pressable regions use ButtonText.
     Placed after the base rules per the focus-ring policy's cascade note. */
  @media (forced-colors: active) {
    .chat-message-edit-textarea:focus {
      outline: var(--cinder-ring-width) solid Highlight;
      outline-offset: 1px;
    }

    .chat-message:focus-visible,
    .chat-message-expand:focus-visible,
    .chat-message-retry:focus-visible,
    .chat-message-edit-save:focus-visible,
    .chat-message-edit-cancel:focus-visible,
    :global(.chat-message-retry:focus-visible),
    :global(.chat-message-action-button:focus-visible),
    :global(.chat-message-edit-save:focus-visible),
    :global(.chat-message-edit-cancel:focus-visible) {
      outline: var(--cinder-ring-width) solid ButtonText;
      outline-offset: 3px;
    }
  }
  /* ----------------------------------------
   * Transcript presentation
   *
   * A reply is plain text on the page, with no card and no role label; a person's message keeps its
   * tinted bubble. One muted line under each message carries its time, the host's actions, Copy and
   * Quote, always visible. A message that was not sent keeps its bubble under a red icon;
   * a queued follow-up is a dashed, pale bubble. A run's notes sit outside the bubble, full width.
   * ---------------------------------------- */
  .chat-message-wrapper[data-presentation='transcript'] {
    gap: var(--cinder-space-1);
  }

  .chat-message-wrapper[data-presentation='transcript'][data-role='assistant'] {
    inline-size: 100%;
    max-inline-size: 100%;
  }

  /* The role stays in the accessible name; it is not drawn. */
  .chat-message-wrapper[data-presentation='transcript'] .chat-message-header {
    position: absolute;
    inline-size: 1px;
    block-size: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .chat-message-wrapper[data-presentation='transcript'][data-role='assistant'] .chat-message {
    background: none;
    border: none;
    box-shadow: none;
    padding-inline: 0;
    border-radius: 0;
  }

  /* Sources sit under the answer, on their own block above the time and actions line. The
   * article's normal bottom padding is useful for boxed messages, but it creates a second full
   * rhythm unit in the borderless transcript when sources are present. */
  .chat-message-wrapper[data-presentation='transcript']:has(> .chat-message-sources)
    > .chat-message {
    padding-block-end: 0;
  }

  /* Markdown owns paragraph spacing in normal messages. In a transcript with a Sources control,
     that last paragraph margin is a redundant third rhythm unit before the separate 44px target;
     remove only the trailing margin while keeping the target rows disjoint. */
  .chat-message-wrapper[data-presentation='transcript']:has(> .chat-message-sources)
    > .chat-message
    :global(
      .message-content-preview :is(p, li, blockquote, h1, h2, h3, h4, h5, h6, dt, dd):last-child
    ) {
    margin-block-end: 0;
  }

  .chat-message-wrapper[data-presentation='transcript'][data-pending][data-role='user']
    .chat-message {
    background: color-mix(in oklch, var(--cinder-accent-solid), transparent 94%);
    border: 1px dashed color-mix(in oklch, var(--cinder-accent-solid), transparent 55%);
  }

  .chat-message-wrapper[data-presentation='transcript'][data-failed] .chat-message {
    border: none;
    background: var(
      --user-message-background,
      color-mix(in oklch, var(--cinder-accent-solid), transparent 88%)
    );
  }

  /* The line's actions reach 44px by a hit area that overhangs the line by about 10px. The next
   * message's bubble (`content-visibility: auto` makes it a stacking context painted in tree order)
   * would otherwise paint over that overhang, so a tap just under Copy would land on the next
   * message's text. A stacking position of its own puts the line's overhang above it. */
  .chat-message-line {
    position: relative;
    z-index: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-1);
    min-block-size: 1.5rem;
    color: var(--cinder-text-muted);
    font-size: var(--_cinder-chat-text-xs, var(--cinder-text-xs));
    line-height: 1.2;
  }

  /* Keep the glyph readable while the action retains its full coarse-pointer hit cell. */
  .chat-message-line :global(.chat-message-action-button svg) {
    inline-size: 1rem;
    block-size: 1rem;
  }

  .chat-message-wrapper[data-role='user'] .chat-message-line {
    justify-content: flex-end;
  }

  /* The trailing Copy glyph meets the bubble's edge: its 24px box overhangs by its own inset
   * (the 16px glyph sits 4px inside it), and its hit area extends outward with it. */
  .chat-message-wrapper[data-role='user'] .chat-message-line-actions {
    margin-inline-end: calc((1rem - 1.5rem) / 2);
  }

  /* The time sits the same distance under an assistant's last text line as under a user's bubble
   * (about 9 to 12px of ink): the line box's leading below the last text line is pulled back. */
  .chat-message-wrapper[data-presentation='transcript'][data-role='assistant']
    > .chat-message
    + .chat-message-line {
    margin-block-start: calc(var(--cinder-space-1) * -1.5);
  }

  /* Prose to Sources is one small step, not a blank line: the block's own margin cancels the
   * wrapper's gap, and the text's trailing leading plus the control's own slack read as the step. */
  .chat-message-wrapper[data-presentation='transcript'] > .chat-message-sources {
    margin-block-start: calc(var(--cinder-space-1) * -1);
  }

  /* A bubble that ends in an attachment tile has the same inset below the tile as beside it. */
  .chat-message-wrapper[data-role='user']
    .chat-message:has(:global(.message-attachments:last-child)) {
    padding-block-end: var(--cinder-space-3);
  }

  /* An RTL reply's line takes the message's direction: the time at inline start, the actions
   * following it. */
  .chat-message-wrapper[data-message-direction='rtl'][data-role='assistant'] .chat-message-line {
    direction: rtl;
    justify-content: flex-start;
  }

  .chat-message-wrapper[data-message-direction='rtl'][data-role='assistant']
    .chat-message-line-actions {
    direction: rtl;
  }

  .chat-message-line-actions {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    direction: ltr;
    gap: var(--cinder-space-1);
  }

  /* Message actions stay visible beside the timestamp. */
  .chat-message-line :global(.chat-message-action-button) {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-block-size: 1.5rem;
    min-inline-size: 1.5rem;
    padding: 0;
    border: none;
    border-radius: var(--cinder-radius-sm);
    background: transparent;
    color: var(--cinder-text-muted);
    font: inherit;
    cursor: pointer;
  }

  /* On a touch screen an action keeps its painted 1.5rem box and takes the 44px hit region from a
   * pseudo-element that adds no layout, so the glyphs pitch at the painted size plus the gap and
   * their hit regions overlap invisibly. Copy is a Cinder Button, which draws its own region. */
  @media (any-pointer: coarse) {
    .chat-message-line :global(.chat-message-action-button:not(.cinder-button))::after {
      content: '';
      position: absolute;
      inset: calc((1.5rem - var(--cinder-touch-target-min)) / 2);
    }
  }

  .chat-message-line :global(.chat-message-action-button:hover) {
    color: var(--cinder-text-default);
    text-decoration: underline;
  }

  .chat-message-line :global(.chat-message-action-button:disabled) {
    cursor: not-allowed;
    opacity: 0.5;
    text-decoration: none;
  }

  /* The ring wraps the painted face, which is the whole box now. */
  .chat-message-line :global(.chat-message-action-button:focus-visible) {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: var(--_cinder-focus-ring-shadow);
  }

  .chat-message-not-sent-icon:focus-visible {
    outline: var(--cinder-ring-width) solid var(--cinder-ring-color);
    outline-offset: var(--cinder-ring-offset);
  }

  .chat-message-queued-label {
    color: var(--cinder-text-muted);
  }

  .chat-message-not-sent-label {
    color: var(--cinder-status-danger-text);
    font-weight: var(--cinder-font-medium);
  }

  .chat-message-not-sent-icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    inline-size: 1.5rem;
    block-size: 1.5rem;
    padding: 0;
    border: none;
    border-radius: 999px;
    background: var(--cinder-status-danger-background);
    color: var(--cinder-status-danger-text);
    cursor: pointer;
  }

  .chat-message-not-sent-icon :global(svg) {
    inline-size: 1rem;
    block-size: 1rem;
  }

  .chat-message-not-sent-popover {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    max-inline-size: 20rem;
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
  }

  .chat-message-not-sent-summary {
    display: flex;
    gap: var(--cinder-space-2);
    margin: 0;
    color: var(--cinder-text-default);
  }

  .chat-message-not-sent-summary :global(.chat-message-not-sent-glyph) {
    flex: none;
    inline-size: 1rem;
    block-size: 1rem;
    margin-block-start: 0.125rem;
    color: var(--cinder-status-danger-text);
  }

  .chat-message-not-sent-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2);
  }

  .chat-message-not-sent-actions :global(.chat-message-retry) {
    inline-size: auto;
    min-inline-size: 0;
    max-inline-size: none;
    padding-inline: var(--cinder-space-3);
  }

  .chat-message-not-sent-note {
    color: var(--cinder-text-muted);
  }

  .chat-message-notes {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    inline-size: 100%;
  }

  /* A streaming reply ends in a caret, not three dots, and the caret sits at the end of the last
   * line of text, never on a line of its own: it is drawn after the last block of the rendered
   * Markdown, or after the raw tail that has not been rendered yet. The caret is a 2 px bar in the
   * accent colour (COR-2283, R2). */
  .chat-message-wrapper[data-presentation='transcript'] :global(.chat-message-streaming-progress) {
    display: none;
  }

  .chat-message-wrapper[data-presentation='transcript']
    :global(
      .message-content-streaming:not([data-streaming-tail])
        .message-content-preview
        > :last-child::after
    ),
  .chat-message-wrapper[data-presentation='transcript']
    :global(.message-content-streaming[data-streaming-tail] .message-content-tail::after) {
    content: '';
    display: inline-block;
    inline-size: 2px;
    block-size: 1.05em;
    margin-inline-start: 0.125em;
    vertical-align: text-bottom;
    background: var(--cinder-accent-solid);
    animation: chat-message-caret 1.1s steps(1) infinite;
  }

  @keyframes chat-message-caret {
    50% {
      opacity: 0;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .chat-message-wrapper[data-presentation='transcript']
      :global(
        .message-content-streaming:not([data-streaming-tail])
          .message-content-preview
          > :last-child::after
      ),
    .chat-message-wrapper[data-presentation='transcript']
      :global(.message-content-streaming[data-streaming-tail] .message-content-tail::after) {
      animation: none;
    }
  }
  .chat-message-wrapper[data-presentation='transcript'][data-role='system'] {
    margin-inline: 0;
    max-inline-size: 100%;
    inline-size: 100%;
  }

  .chat-message-wrapper[data-presentation='transcript'][data-role='system'] .chat-message {
    background: none;
    color: var(--cinder-text-muted);
    padding-inline: 0;
    text-align: start;
  }

  .chat-message-wrapper[data-presentation='transcript'] .chat-message-body[hidden] {
    display: none;
  }

  .chat-message-system-toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--cinder-space-1);
    align-self: flex-start;
    padding: 0;
    border: none;
    background: none;
    color: var(--cinder-text-muted);
    font: inherit;
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
    cursor: pointer;
  }

  .chat-message-system-toggle:hover {
    color: var(--cinder-text-default);
    text-decoration: underline;
  }

  .chat-message-system-toggle :global(.chat-message-system-chevron) {
    flex: none;
    inline-size: 12px;
    block-size: 12px;
    transition: transform 120ms ease;
  }

  .chat-message-system-toggle[aria-expanded='true'] :global(.chat-message-system-chevron) {
    transform: rotate(90deg);
  }

  @media (prefers-reduced-motion: reduce) {
    .chat-message-system-toggle :global(.chat-message-system-chevron) {
      transition: none;
    }
  }

  .chat-message-system-toggle:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: var(--_cinder-focus-ring-shadow);
  }

  /* ----------------------------------------
   * Run outcomes on the turn (COR-2283)
   *
   * A turn that has not simply finished says so on itself, under its text, with the controls that
   * recover it: a warning while the stream reconnects, a neutral note on a stopped turn, a danger
   * note on one that failed partway, and a neutral note on one that finished with no answer. Each is
   * the Cinder Callout.
   * ---------------------------------------- */

  /* A reconnecting turn's partial text reads muted: it may not be the final answer yet. */
  .chat-message-wrapper[data-turn-state='reconnecting'] .chat-message-body {
    color: var(--cinder-text-muted);
  }

  /* An empty answer has no text, so its turn takes no room above the row that says so. */
  .chat-message-wrapper[data-turn-state='empty'] .chat-message {
    padding-block: 0;
  }

  .chat-turn-outcome {
    inline-size: 100%;
    min-inline-size: 0;
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
    text-align: start;
  }

  /* Keep the stopped notice's text and controls off the card border while preserving the compact
   * neutral surface; the Callout itself remains responsible for its semantic tone. */
  .chat-turn-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2) var(--cinder-space-3);
  }

  .chat-turn-text {
    display: block;
    min-inline-size: 0;
    overflow-wrap: anywhere;
    text-align: start;
  }

  .chat-turn-row .chat-turn-text {
    flex: 1 1 12rem;
  }

  .chat-turn-actions {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2);
    margin-inline-start: 0;
  }

  .chat-turn-outcome :global(.chat-turn-wait) {
    margin-block-start: var(--cinder-space-2);
  }

  .chat-turn-outcome :global(.chat-turn-action) {
    inline-size: auto;
    min-inline-size: 0;
    max-inline-size: none;
    padding-inline: var(--cinder-space-3);
  }

  .chat-turn-text {
    margin: 0;
  }

  .chat-turn-failure-body {
    color: var(--cinder-text-default);
  }

  .chat-turn-outcome :global(.chat-turn-inline-icon) {
    display: inline-block;
    inline-size: 1em;
    block-size: 1em;
    margin-inline-end: var(--cinder-space-1);
    vertical-align: -0.125em;
  }

  /* RTL message chrome follows the prose edge even when the narrow-screen footer rule moves
   * every role below its bubble. Keep the action order LTR, but anchor the tray to the reading
   * edge selected by the actual message direction. */
  .chat-message-wrapper[data-message-direction='rtl'][data-role='assistant'] .chat-message-footer {
    inset-inline-start: auto;
    inset-inline-end: 0;
    left: auto;
    right: 0;
    padding-inline: 0;
  }
</style>
