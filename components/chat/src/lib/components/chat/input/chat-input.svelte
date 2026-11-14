<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { HTMLFormAttributes } from 'svelte/elements';
  import type { MessageInput } from '../conversation-model.ts';
  import type {
    ChatAttachment,
    ChatAttachmentErrorFormatter,
    ChatAttachmentFailure,
    ChatAttachmentUpload,
  } from './chat-attachment.ts';
  import type { AttachmentKind } from './attachment-kind.ts';
  import type { ChatComposerControlsContext } from './composer-controls.ts';
  import type { ChatComposerFormat, ChatComposerToolbarContext } from './composer-markdown.ts';
  import type { ChatComposerBlockedAction, ChatComposerStatus } from './composer-status.ts';
  import type { ChatLabels } from '../chat-labels.ts';

  export type { ChatAttachment } from './chat-attachment.ts';

  export type ChatInputProps = Omit<HTMLFormAttributes, 'onsubmit' | 'class'> & {
    /** Unique ID for accessibility (required) */
    id: string;
    /** Current markdown content (two-way bindable) */
    value?: string;
    /** Placeholder text */
    placeholder?: string | undefined;
    /**
     * The placeholder while a run is working and the composer takes follow-ups (`sending` with
     * `allowFollowUp`), where what is typed waits for the run. Default `Add another follow-up…`.
     */
    followUpPlaceholder?: string | undefined;
    /** Accessible label passed to the inner message editor */
    composerLabel?: string;
    /** Explicit role for the inner message editor, for overlay patterns such as ARIA comboboxes. */
    composerRole?: string | undefined;
    /** `aria-expanded` passed to the inner message editor for composer overlays. */
    composerAriaExpanded?: boolean | 'true' | 'false' | undefined;
    /** `aria-controls` passed to the inner message editor for composer overlays. */
    composerAriaControls?: string | undefined;
    /** `aria-activedescendant` passed to the inner message editor for composer overlays. */
    composerAriaActiveDescendant?: string | undefined;
    /** `aria-autocomplete` passed to the inner message editor for composer overlays. */
    composerAriaAutocomplete?: 'none' | 'inline' | 'list' | 'both' | undefined;
    /** Whether the input is disabled */
    disabled?: boolean;
    /**
     * Whether typing and sending are paused by the host. The editor is read-only rather than
     * disabled, so it keeps focus and its text, and takes keys again once this clears.
     */
    paused?: boolean;
    /**
     * A one-line composer for a small surface: the field and Send (or Stop) share one row, with no
     * controls, attachments or formatting, and the hint stays under it. Default `false`.
     */
    compact?: boolean;
    /**
     * Why typing and sending are paused, as muted text beside Send. Shown only while `paused`, and
     * named by Send's `aria-describedby`, so a screen reader hears the reason on the button.
     */
    pausedReason?: string | undefined;
    /** Whether a submission is in progress */
    sending?: boolean;
    /**
     * Keep the composer usable while `sending` is `true`, so a follow-up can be
     * submitted during a run. Send stays available and, when `onstop` is
     * provided, Stop is shown beside it instead of replacing it. Default `false`.
     */
    allowFollowUp?: boolean;
    /**
     * Whether anything sent now waits, behind a decision such as a tool approval or for a run to
     * finish. While a draft is present, Send reads Queue with the queue icon. Default `false`.
     */
    queueing?: boolean;
    /**
     * Why a send waits, while a tool approval holds the run: the Queue button's tooltip ends with
     * it and its `aria-describedby` points at it.
     */
    queueNote?: string | undefined;
    /** Error message to display */
    error?: string;
    /** Additional CSS class */
    class?: string;

    // Form action support
    /** Form action URL (enables form action mode) */
    action?: string;
    /** Name for the hidden input field (default: 'content') */
    name?: string;

    // Submission behavior
    /** Whether to clear input after submit (default: true). Set to false for error recovery. */
    clearOnSubmit?: boolean;
    /**
     * Set while the host is starting what the message belongs to, such as the conversation its first
     * message opens. Send reads this word with a spinner and is off, and there is no Stop, because
     * nothing is running yet. The text and files stay in the box. Left out, Send is Send.
     */
    starting?: string | undefined;
    /** Keyboard gesture that submits the composer. Default `'enter'`. */
    submitOn?: 'enter' | 'modifier-enter' | 'enter-if-single-line';

    // Attachment configuration
    /** Enable file attachments (default: true) */
    allowAttachments?: boolean;
    /** Maximum file size in bytes (default: 10MB) */
    maxFileSize?: number | undefined;
    /** Accepted MIME types (default: ['image/*']) */
    acceptedTypes?: string[] | undefined;
    /** Plain-text paste length promoted to a reversible attachment. Default `8000`. */
    largePasteThreshold?: number;
    /** Host-overridable attachment and approval-drawer words. */
    labels?: Partial<ChatLabels> | undefined;
    /**
     * Uploads each attached file as soon as it is added. The attachment is `uploading` until the
     * hook settles, then `ready` carrying the hook's reference, or `error`; Send waits for every
     * upload. A file the composer refuses (too large, or a type it does not accept) never reaches
     * the hook. A promoted text paste is sent inline and is not uploaded.
     */
    uploadAttachment?: ChatAttachmentUpload | undefined;
    /** The words shown for an attachment in the `error` state. Defaults to a plain English message. */
    formatAttachmentError?: ChatAttachmentErrorFormatter | undefined;

    // Events
    /** Called when the message is submitted */
    onsubmit?: (message: MessageInput, attachments: ChatAttachment[]) => void;
    /** Called when stop is requested (transforms send button into stop button when sending=true) */
    onstop?: (() => void) | undefined;
    /** Called when user input or insertAtRange changes the composer's plain-text value. */
    onComposerInput?: ((value: string, event?: Event) => void) | undefined;
    /**
     * Called before ChatInput's internal Enter-to-send handling when a keydown
     * originates from the composer textarea. Calling `preventDefault()` skips
     * the internal key handling for that event.
     */
    oncomposerkeydown?: ((event: KeyboardEvent) => void) | undefined;
    /** Called after pointer or selection activity may have moved the composer caret. */
    oncomposerselectionchange?: ((event: Event) => void) | undefined;
    /** Called when focus leaves the composer textarea. */
    oncomposerblur?: ((event: FocusEvent) => void) | undefined;
    /** Called when an attachment is added */
    onAttachmentAdd?: ((attachment: ChatAttachment) => void) | undefined;
    /** Called when an attachment is removed */
    onAttachmentRemove?: ((attachment: ChatAttachment) => void) | undefined;
    /** Called when an attachment fails validation */
    onAttachmentFailure?: ((file: File, error: string) => void) | undefined;

    // Markdown
    /**
     * Style Markdown in place: markers dim, and emphasis, code, links, and list
     * markers show as they will render. The text stays the Markdown that is sent.
     * Default `true`.
     */
    markdownStyling?: boolean;
    /**
     * Show a row of Bold, Italic, Code, Link, and List buttons above the text, with the words of
     * their shortcuts at its right, while the composer has focus. Default `false`.
     */
    formattingToolbar?: boolean;
    /**
     * The line under the composer (a reconnect, queued follow-ups, a note of the host's own), or,
     * with `kind: 'blocked'`, the whole composer: sending is not possible, so one compact row says
     * why in place of the text box and the controls. `offline` and `draft-restored` are drawers
     * above the composer: offline keeps the draft and turns Send off, naming the drawer as the
     * reason; a restored draft says when it is from, with Discard draft.
     */
    status?: ChatComposerStatus | undefined;
    /**
     * The composer is answering a question the run asked: the button reads `Answer` instead of
     * `Send`, and the placeholder is the host's to set. Default `false`.
     */
    answering?: boolean;
    /**
     * The line of help under the composer while no status is showing. Default
     * `Enter to send. Shift and Enter for a new line.` (worded for the `submitOn` gesture);
     * `false` hides it.
     */
    hint?: string | false | undefined;

    // Snippets for extensibility
    /**
     * Controls at the start of the footer, right after the attach button: the host's own selects
     * for the model, effort and permissions. They stay interactive while a run streams. The
     * snippet is told whether the composer is too narrow for them (`folded`), so a host can draw
     * one Settings control in their place; the footer never wraps.
     */
    controls?: Snippet<[ChatComposerControlsContext]> | undefined;
    /**
     * The top row inside the composer's border, above the text: the host's own control for who the
     * message goes to, such as an agent select.
     */
    header?: Snippet | undefined;
    /**
     * A notice about the connection, drawn directly above the composer's own drawers (offline, a
     * restored draft) because the connection is what it affects. Only the composer box shows it;
     * a blocked, archived or read-only bar has no text box to sit by.
     */
    connectionNotice?: Snippet | undefined;
    /** Custom actions area (e.g., additional buttons) beside Send, such as a context meter. */
    actions?: Snippet | undefined;
    /** Toolbar slot at the start of the footer, given a `format` command for the selection. */
    toolbar?: Snippet<[ChatComposerToolbarContext]> | undefined;
  };
</script>

<script lang="ts">
  /**
   * ChatInput is a ChatGPT/Claude-style chat composer.
   *
   * Features:
   * - Uses a native textarea composer so Chat does not require the rich editor bundle
   * - Keyboard shortcuts: Enter to send, Shift+Enter for newline; Cmd/Ctrl+B, I, E and Cmd/Ctrl+Shift+K format Markdown
   * - Styles Markdown in place over the textarea, which still holds the Markdown that is sent
   * - IME-aware: composition input (Japanese/Chinese/Korean) won't trigger send
   * - File attachments (images, code, documents) via paste, drag-drop, or file picker
   * - Blocks whitespace-only submit
   * - Works standalone or with SvelteKit form actions
   *
   * @example
   * ```svelte
   * <ChatInput
   *   id="chat"
   *   bind:value={message}
   *   onsubmit={(msg, attachments) => sendMessage(msg, attachments)}
   * />
   * ```
   */

  import { flushSync, tick, untrack } from 'svelte';
  import { classNames } from '../../../utilities/class-names.ts';
  import { resolveChatLabels } from '../chat-labels.ts';
  import { useAnnouncer } from '../../../utilities/use-announcer.svelte.ts';
  import { createIdFactory, useStableId } from '../../../utilities/id-factory.ts';
  import {
    Bold,
    Button,
    Code,
    Info,
    Italic,
    LinkIcon,
    List,
    Paperclip,
    ListOrdered,
    RotateCcw,
    scrollEdgeFade,
    SendHorizontal,
    Square,
    Callout,
    Spinner,
    Tooltip,
    TriangleAlert,
    X,
  } from '@lostgradient/cinder';
  import {
    applyComposerFormat,
    composerShortcutFormat,
    highlightComposerMarkdown,
  } from './composer-markdown.ts';
  import { composerControlsFold } from './composer-controls.ts';
  import {
    COMPOSER_DISCARD_DRAFT_LABEL,
    composerStatusText,
    isComposerDrawerStatus,
    isComposerNoticeStatus,
  } from './composer-status.ts';
  import {
    COMPOSER_FOLLOW_UP_PLACEHOLDER,
    COMPOSER_RUNNING_LABEL,
    formatRunElapsed,
  } from './composer-run-clock.ts';
  import { deriveAttachmentKind } from './attachment-kind.ts';
  import {
    acceptedKindsText,
    attachmentFailureLine,
    canRetry,
    classifyUploadFailure,
    isRetryableFailure,
    needsAttention,
    typeNotAcceptedText,
  } from './attachment-tile.ts';
  import { formatBytes } from '../../../utilities/format-bytes.ts';
  import ChatAttachmentPreview from './chat-attachment-preview.svelte';
  import RetryButton from '../message/retry-button.svelte';

  // Per-instance fallback factory for attachments whose file metadata is unavailable
  // AND as a collision-disambiguation counter when two files share identical metadata.
  const attachmentIdFactory = createIdFactory('attachment');
  // Tracks hash-derived IDs used in this instance so collisions (same name/size/mtime)
  // get a unique suffix rather than a duplicate DOM ID.
  const usedAttachmentIds = new Set<string>();

  /**
   * The width `element` needs to draw every value in it in full: its width with nothing in it
   * squeezed, plus what each value that still ends in an ellipsis is short by (a ghost select caps
   * its value below its text). The style is put back before anything is painted.
   */
  function naturalWidth(element: HTMLElement): number {
    const { flex, inlineSize } = element.style;
    element.style.flex = 'none';
    element.style.inlineSize = 'max-content';
    let width = element.getBoundingClientRect().width;
    for (const descendant of element.querySelectorAll<HTMLElement>('*')) {
      // A visually hidden element is clipped to a pixel on purpose and draws nothing.
      if (descendant.clientWidth <= 1) continue;
      const shortBy = descendant.scrollWidth - descendant.clientWidth;
      if (shortBy > 1 && getComputedStyle(descendant).textOverflow === 'ellipsis') width += shortBy;
    }
    element.style.flex = flex;
    element.style.inlineSize = inlineSize;
    return width;
  }

  /**
   * The words of the shortcuts, drawn at the right of the toolbar while the composer has focus. Each
   * is its own element, spaced apart, never joined by a separator glyph.
   */
  const FORMATTING_HINTS = ['⌘B bold', '⌘I italic', '⌘E code', '⌘⇧K link'] as const;

  const FORMATTING_BUTTONS = [
    { format: 'bold', label: 'Bold', keyshortcuts: 'Meta+B Control+B', icon: Bold },
    { format: 'italic', label: 'Italic', keyshortcuts: 'Meta+I Control+I', icon: Italic },
    { format: 'code', label: 'Code', keyshortcuts: 'Meta+E Control+E', icon: Code },
    { format: 'link', label: 'Link', keyshortcuts: 'Meta+Shift+K Control+Shift+K', icon: LinkIcon },
    { format: 'list', label: 'List', keyshortcuts: undefined, icon: List },
  ] as const satisfies readonly {
    format: ChatComposerFormat;
    label: string;
    keyshortcuts: string | undefined;
    icon: unknown;
  }[];

  let {
    id,
    value = $bindable(''),
    placeholder = 'Type a message…',
    followUpPlaceholder = COMPOSER_FOLLOW_UP_PLACEHOLDER,
    composerLabel = 'Message',
    composerRole,
    composerAriaExpanded,
    composerAriaControls,
    composerAriaActiveDescendant,
    composerAriaAutocomplete,
    disabled = false,
    paused = false,
    compact = false,
    pausedReason,
    sending = false,
    allowFollowUp = false,
    queueing = false,
    queueNote,
    error,
    class: className,
    action,
    name = 'content',
    clearOnSubmit = true,
    starting,
    submitOn = 'enter',
    allowAttachments = true,
    maxFileSize = 10 * 1024 * 1024, // 10MB
    acceptedTypes = [
      'image/*',
      'text/*',
      'application/json',
      'application/pdf',
      'application/javascript',
      'application/typescript',
      'application/xml',
      'application/yaml',
      'application/x-yaml',
      // Keep in sync with CODE_MIME_TYPES in attachment-kind.ts
      'application/x-sh',
      'application/sql',
      'application/toml',
    ],
    largePasteThreshold = 8_000,
    labels: labelOverrides,
    uploadAttachment,
    formatAttachmentError,
    onsubmit,
    onstop,
    onComposerInput,
    oncomposerkeydown,
    oncomposerselectionchange,
    oncomposerblur,
    onAttachmentAdd,
    onAttachmentRemove,
    onAttachmentFailure,
    markdownStyling = true,
    formattingToolbar = false,
    status,
    answering = false,
    hint,
    controls,
    header,
    connectionNotice,
    actions,
    toolbar,
    ...rest
  }: ChatInputProps = $props();

  const labels = $derived(resolveChatLabels(labelOverrides));

  const resolvedComposerLabel = $derived(composerLabel.trim() || 'Message');

  const markdownSegments = $derived(markdownStyling ? highlightComposerMarkdown(value) : []);
  const statusText = $derived(status ? composerStatusText(status) : undefined);
  /** A status drawn as a drawer above the composer (offline, a restored draft), not the line. */
  const drawerStatus = $derived(isComposerDrawerStatus(status) ? status : undefined);
  /** The browser has no connection: the draft stays, and Send waits for it to come back. */
  const offline = $derived(status?.kind === 'offline');
  /** The tone one composer notice paints: offline is a warning, the rest say their own. */
  const drawerTone = $derived<'neutral' | 'info' | 'warning' | 'danger'>(
    drawerStatus?.kind === 'offline' || drawerStatus?.kind === 'reconnecting'
      ? 'warning'
      : drawerStatus?.kind === 'drawer-notice'
        ? (drawerStatus.tone ?? 'neutral')
        : 'neutral',
  );
  const toolbarContext: ChatComposerToolbarContext = { format: applyFormat };
  let markdownBackdrop = $state<HTMLDivElement | null>(null);

  function syncBackdropScroll(): void {
    if (!markdownBackdrop || !editorElement) return;
    markdownBackdrop.scrollTop = editorElement.scrollTop;
    markdownBackdrop.scrollLeft = editorElement.scrollLeft;
  }

  $effect(() => {
    void markdownSegments;
    syncBackdropScroll();
  });

  const showSendingSpinner = $derived((sending && !allowFollowUp) || starting !== undefined);
  // While a run works and the composer takes follow-ups, the placeholder says what typing does now.
  const resolvedPlaceholder = $derived(
    sending && allowFollowUp && !answering && starting === undefined
      ? followUpPlaceholder
      : placeholder,
  );

  // The run toolbar's clock: how long the run has been working, from when `sending` turned on.
  let runStartedAt = $state<number | undefined>(undefined);
  let runNow = $state(0);
  $effect(() => {
    if (!sending || starting !== undefined) {
      runStartedAt = undefined;
      return undefined;
    }
    const startedAt = Date.now();
    runStartedAt = startedAt;
    runNow = startedAt;
    const timer = setInterval(() => {
      runNow = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });
  const runElapsed = $derived(
    runStartedAt === undefined ? undefined : formatRunElapsed(runNow - runStartedAt),
  );
  const sendBlocked = $derived(
    (sending && !allowFollowUp) ||
      starting !== undefined ||
      (drawerStatus?.kind === 'drawer-notice' && drawerStatus.sendDisabledReason !== undefined),
  );
  // Names the key the composer's `submitOn` actually listens for, so a
  // modifier-enter composer never announces a bare Enter.
  const followUpInstruction = $derived.by(() => {
    if (submitOn === 'modifier-enter')
      return 'Press Command+Enter or Control+Enter to send a follow-up.';
    if (submitOn === 'enter-if-single-line')
      return value.includes('\n')
        ? 'This message has multiple lines. Use the send button to send a follow-up.'
        : 'Press Enter to send a single-line follow-up.';
    return 'Press Enter to send a follow-up.';
  });

  // Refs
  let sendButtonRef = $state<HTMLElement | null>(null);
  let stopButtonRef = $state<HTMLElement | null>(null);
  let formElement = $state<HTMLFormElement | null>(null);
  let editorElement = $state<HTMLTextAreaElement | null>(null);
  let fileInputRef = $state<HTMLInputElement | null>(null);

  // Whether the host's controls fold into one: below the fold width of the composer's own width,
  // so a docked side panel and a phone fold them alike, and at any width when their values in full
  // do not fit beside the meter and Send, so a desktop composer never shows them cut to stubs. A
  // composer that cannot measure (no ResizeObserver) draws the full row.
  let folded = $state(false);
  let footerLeftElement = $state<HTMLDivElement | null>(null);
  $effect(() => {
    const element = formElement;
    const footerLeft = footerLeftElement;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const remInPixels =
      Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    // The width the unfolded row needed, kept while it is folded, when it cannot be measured.
    let neededWidth: number | undefined;
    let disposed = false;
    const measure = (): void => {
      if (disposed) return;
      const availableWidth = footerLeft?.getBoundingClientRect().width ?? 0;
      if (footerLeft !== null && !untrack(() => folded)) {
        neededWidth = naturalWidth(footerLeft);
      }
      const next = composerControlsFold({
        composerWidth: element.getBoundingClientRect().width,
        remInPixels,
        availableWidth,
        neededWidth,
      });
      if (next === untrack(() => folded)) return;
      folded = next;
      // Unfolded again: measure the full row once it is drawn, before it is painted.
      if (!next) void tick().then(measure);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (footerLeft !== null) observer.observe(footerLeft);
    // A value the host's controls load or change alters what they need without resizing anything.
    const mutations = new MutationObserver(measure);
    if (footerLeft !== null) {
      mutations.observe(footerLeft, { childList: true, subtree: true, characterData: true });
    }
    return () => {
      disposed = true;
      observer.disconnect();
      mutations.disconnect();
    };
  });
  const controlsContext = $derived<ChatComposerControlsContext>({ folded });

  // The formatting row opens when the box or the row itself takes focus and stays open while focus
  // is anywhere in the composer. A control elsewhere in the composer (the host's agent select above
  // the box, its Model and Permissions selects under it) taking focus does not open it: the row's
  // height would move that control between the press and the release of a click, and the click would
  // be lost, most of all in a composer centered in its surface.
  let formattingOpen = $state(false);
  function handleFocusIn(event: FocusEvent): void {
    const target = event.target;
    if (
      target === editorElement ||
      (target instanceof Element && target.closest('.chat-input-toolbar'))
    ) {
      formattingOpen = true;
    }
  }
  // A press that takes focus out of the composer closes the row, which gives its height back to the
  // page: whatever sits above the composer in a docked transcript (an approval's Approve, a link)
  // moves down between the press and the release, and the click is lost. So while a press is still
  // down the row closes once the press is over, after the click it makes has been delivered.
  let pressing = false;
  let closeAfterPress = false;
  function handleFocusOut(event: FocusEvent): void {
    const next = event.relatedTarget;
    if (next instanceof Node && formElement?.contains(next)) return;
    if (pressing) closeAfterPress = true;
    else formattingOpen = false;
  }
  $effect(() => {
    if (!formattingToolbar) return undefined;
    const press = (): void => {
      pressing = true;
    };
    const release = (): void => {
      pressing = false;
      if (!closeAfterPress) return;
      closeAfterPress = false;
      // The click follows the release in the same task; this runs after it.
      setTimeout(() => {
        if (!formElement?.contains(document.activeElement)) formattingOpen = false;
      }, 0);
    };
    document.addEventListener('pointerdown', press, true);
    document.addEventListener('pointerup', release, true);
    document.addEventListener('pointercancel', release, true);
    return () => {
      document.removeEventListener('pointerdown', press, true);
      document.removeEventListener('pointerup', release, true);
      document.removeEventListener('pointercancel', release, true);
    };
  });

  // Internal state
  let attachments = $state<ChatAttachment[]>([]);
  let isDragOver = $state(false);
  let dragEnterDepth = 0;
  let isComposing = $state(false);

  // Screen reader announcements
  const announcer = useAnnouncer();

  // The visible status line is not a live region (one mounted with its text
  // is not reliably read), so a change is announced through the composer's.
  let announcedStatusText: string | undefined;
  $effect(() => {
    const text = statusText;
    if (text === announcedStatusText) return;
    announcedStatusText = text;
    if (text !== undefined) untrack(() => announcer.announce(text));
  });

  // Derived state
  const errorId = $derived(`${id}-error`);
  const shortcutDescriptionId = $derived(`${id}-shortcut-description`);
  const queueNoteId = $derived(`${id}-queue-note`);
  const pausedReasonId = $derived(`${id}-paused-reason`);
  const drawerId = $derived(`${id}-drawer`);
  const drawerReasonId = $derived(`${drawerId}-reason`);
  const attachmentReasonId = $derived(`${id}-attachment-reason`);
  const attachmentListId = $derived(`${id}-attachments`);
  /** The reason Send is off, while the host has paused the composer and said why. */
  const shownPausedReason = $derived(paused && pausedReason ? pausedReason : undefined);
  const isWhitespaceOnly = $derived(value.trim().length === 0);
  const hasPendingAttachments = $derived(
    attachments.some((a) => a.status === 'pending' || a.status === 'uploading'),
  );
  /** The files that block Send until each is retried or removed. */
  const attentionCount = $derived(attachments.filter(needsAttention).length);
  // With several failed files, the person can pick one to read why it failed: the line under the
  // strip then speaks of that file alone. The pick lapses once its file is no longer failed, or only
  // one file is left that failed.
  let pickedFailureId = $state<string | undefined>(undefined);
  $effect(() => {
    if (pickedFailureId === undefined) return;
    const failed = attachments.filter(needsAttention);
    if (failed.length < 2 || !failed.some((entry) => entry.id === pickedFailureId)) {
      pickedFailureId = undefined;
    }
  });
  /** The one line under the strip while a failure blocks Send, before it is put in words. */
  const failureLine = $derived(attachmentFailureLine(attachments, pickedFailureId));
  const failureLineText = $derived.by((): string | undefined => {
    if (failureLine === undefined) return undefined;
    // What one refused file is told to attach instead: what the composer took when it refused the
    // file, from the host's accept list when it gives one, so the words keep to what was true then.
    const acceptedFor = (kept: readonly string[] | undefined) =>
      acceptedKindsText(kept ?? acceptedTypes);
    if (failureLine.type === 'many') {
      // One short sentence for each kind of reason: a shared reason reads as that one sentence.
      return failureLine.reasons
        .map(({ kind, count, maxFileSize: limit }) => {
          if (kind === 'network') return labels.attachmentFailureNetworkMany(count);
          if (kind === 'unsupported-type') return labels.attachmentFailureUnsupportedMany(count);
          if (kind === 'unknown') return labels.attachmentFailureUnknownMany(count);
          return labels.attachmentFailureTooLargeMany(
            count,
            limit === undefined ? undefined : formatBytes(limit),
          );
        })
        .join(' ');
    }
    const { attachment, kind } = failureLine;
    const fileName = attachment.file.name;
    if (kind === 'network') return labels.attachmentFailureNetwork(fileName);
    if (kind === 'unsupported-type') {
      return labels.attachmentFailureUnsupported(fileName, acceptedFor(attachment.acceptedTypes));
    }
    if (kind === 'unknown') return labels.attachmentFailureUnknown(fileName);
    return labels.attachmentFailureTooLarge(
      fileName,
      attachment.maxFileSize === undefined ? undefined : formatBytes(attachment.maxFileSize),
    );
  });
  /**
   * The line's words around the file's name, so the name can be drawn as the thing it is and not as
   * prose: the same face as the chip above it, on one line, shortening before the sentence wraps.
   * A host's own label that leaves the name out is drawn as plain words.
   */
  const failureLineParts = $derived.by(
    (): { before: string; name: string; after: string } | undefined => {
      if (failureLineText === undefined || failureLine === undefined) return undefined;
      if (failureLine.type === 'many') return undefined;
      const fileName = failureLine.attachment.file.name;
      const at = fileName === '' ? -1 : failureLineText.indexOf(fileName);
      if (at === -1) return undefined;
      return {
        before: failureLineText.slice(0, at),
        name: fileName,
        after: failureLineText.slice(at + fileName.length),
      };
    },
  );
  const failureLineActionLabel = $derived(
    failureLine === undefined
      ? undefined
      : failureLine.action === 'retry'
        ? labels.retryAttachment
        : failureLine.action === 'remove'
          ? labels.removeAttachment
          : failureLine.action === 'retry-all'
            ? labels.retryAllAttachments
            : failureLine.action === 'retry-some'
              ? labels.retryAttachments(failureLine.retryable)
              : labels.removeAllFailedAttachments,
  );
  // The line is announced through the composer's live region when it appears or changes, as the
  // status line is: it is not a live region itself, and a file's failure is told once, here.
  let announcedFailureText: string | undefined;
  $effect(() => {
    const text = failureLineText;
    if (text === announcedFailureText) return;
    announcedFailureText = text;
    if (text !== undefined) untrack(() => announcer.announce(text));
  });
  const hasReadyPromotedPaste = $derived(
    attachments.some(
      (attachment) =>
        attachment.status === 'ready' &&
        attachment.restoreText !== undefined &&
        attachment.restoreText.trim().length > 0,
    ),
  );
  const hasReadyAttachments = $derived(
    attachments.some((attachment) => attachment.status === 'ready' && !attachment.restoreText),
  );
  // Allow submit when text or a ready attachment is present. Block while an attachment is still
  // pending or uploading, and while one has failed: it is retried or removed before anything sends.
  const canSubmit = $derived(
    (!isWhitespaceOnly || hasReadyAttachments || hasReadyPromotedPaste) &&
      !disabled &&
      !paused &&
      !offline &&
      !sendBlocked &&
      !hasPendingAttachments &&
      attentionCount === 0,
  );
  // With a draft in the box and a decision ahead of it, Send says what will happen to the draft.
  const queued = $derived(queueing && !answering && canSubmit);
  const sendTooltipText = $derived.by(() => {
    if (starting !== undefined) return starting;
    if (offline) return labels.sendOffline;
    if (hasPendingAttachments) return labels.waitForAttachments;
    if (attentionCount > 0 && failureLineText !== undefined) return failureLineText;
    if (showStopButton) return labels.stopGenerating;
    if (isWhitespaceOnly && !hasReadyAttachments && !hasReadyPromotedPaste) {
      return answering ? labels.typeAnswer : labels.addMessageOrAttachment;
    }
    if (queued) {
      const shortcut = labels.queueShortcut(
        submitOn === 'modifier-enter' ? 'Command or Control + Enter' : 'Enter',
      );
      return queueNote === undefined ? shortcut : `${shortcut}. ${queueNote}`;
    }
    if (submitOn === 'modifier-enter') return labels.sendShortcut('Command or Control + Enter');
    if (submitOn === 'enter-if-single-line' && value.includes('\n')) return labels.sendMessage;
    return answering ? labels.answerShortcut : labels.sendShortcut('Enter');
  });
  /** Remembers a button the composer owns, so its tooltip can anchor to it. */
  function holdButton(assign: (element: HTMLElement | null) => void) {
    return (element: Element): (() => void) => {
      assign(element as HTMLElement);
      return () => assign(null);
    };
  }
  // Stop takes Send's place while the chat is working. In follow-up mode Send comes back beside
  // Stop once a message is typed, so the message can still be sent without a keyboard.
  const stopOffered = $derived(sending && onstop !== undefined && starting === undefined);
  const showStopButton = $derived(stopOffered && (!allowFollowUp || !canSubmit));
  const showSideStopButton = $derived(stopOffered && allowFollowUp && canSubmit);
  // When the run ends, Stop goes away: the side button unmounts, and the main button turns back into
  // a Send that is disabled while the box is empty. If either held focus, hand focus to Send (or
  // the textarea while Send is disabled) before it goes, so focus is not dropped to the body.
  $effect.pre(() => {
    const send = untrack(() => sendButtonRef);
    if (!showSideStopButton) {
      const stopButton = untrack(() => stopButtonRef);
      if (stopButton !== null && document.activeElement === stopButton) {
        (canSubmit ? send : editorElement)?.focus();
      }
    }
    if (!showStopButton && !canSubmit && send !== null && send.hasAttribute('data-stop')) {
      if (document.activeElement === send) editorElement?.focus();
    }
  });

  const sendLabel = $derived(
    starting ?? (answering ? labels.answer : queued ? labels.queue : labels.send),
  );
  const sendAccessibleName = $derived(
    showStopButton
      ? labels.stopGenerating
      : starting !== undefined
        ? starting
        : showSendingSpinner
          ? labels.sendingMessage
          : answering
            ? labels.answer
            : queued
              ? labels.queueMessage
              : labels.sendMessage,
  );
  const sendButtonIconOnly = $derived(showStopButton || showSendingSpinner || queued || !answering);
  const hintText = $derived.by(() => {
    if (hint === false) return undefined;
    if (hint !== undefined) return hint;
    if (submitOn === 'modifier-enter') {
      return labels.modifierEnterHint;
    }
    return labels.enterHint;
  });
  /** Marks the default hint, which names keys, so a touch-only device leaves it out. */
  const keyboardHint = $derived(hint === undefined ? '' : undefined);
  const blocked = $derived(status?.kind === 'blocked' ? status : undefined);
  /** The neutral bar that replaces the composer for an archived or a read-only chat. */
  const notice = $derived(isComposerNoticeStatus(status) ? status : undefined);
  let noticeLabelRef = $state<HTMLButtonElement | null>(null);
  const noticeHasActions = $derived(
    notice?.kind === 'archived'
      ? notice.newChat !== undefined || notice.unarchive !== undefined
      : notice?.request !== undefined,
  );
  // Send is filled with the accent only while it would send: an empty or held composer leaves it
  // outlined and quiet, and Stop stays outlined.
  const sendVariant = $derived<'primary' | 'secondary'>(
    !showStopButton && canSubmit ? 'primary' : 'secondary',
  );
  /** What Send's `aria-describedby` names besides the shortcut description: each visible reason. */
  const sendReasonIds = $derived([
    ...(offline ? [drawerId] : []),
    ...(drawerStatus?.kind === 'drawer-notice' && drawerStatus.sendDisabledReason !== undefined
      ? [drawerReasonId]
      : []),
    ...(attentionCount > 0 ? [attachmentReasonId] : []),
    ...(shownPausedReason === undefined ? [] : [pausedReasonId]),
    ...(queued && queueNote !== undefined ? [queueNoteId] : []),
  ]);

  function discardRestoredDraft(): void {
    const restored = status?.kind === 'draft-restored' ? status : undefined;
    clear();
    editorElement?.focus();
    restored?.ondiscard?.();
  }

  // Determine if we're in form action mode
  const isFormActionMode = $derived(!!action);

  // =========================================================================
  // Attachment Handling
  // =========================================================================

  function handleSendButtonClick(event: MouseEvent): void {
    if (!showStopButton) return;
    event.preventDefault();
    onstop?.();
  }

  function isValidType(file: File): boolean {
    return acceptedTypes.some((type) => {
      if (type.endsWith('/*')) {
        const category = type.slice(0, -2);
        return file.type.startsWith(category);
      }
      return file.type === type;
    });
  }

  const kindLabel = (kind: AttachmentKind): string =>
    kind === 'image' ? labels.image : kind === 'code' ? labels.codeFile : labels.document;

  /** Names an attachment's file the way the composer keys its rows and its announcements. */
  function newAttachmentId(file: File): string {
    // Derive a stable ID from the file's identity metadata so repeated snapshot
    // renders of the same attachment produce the same DOM ID. Fall back to the
    // per-instance counter when lastModified is absent (e.g. synthetic File objects
    // constructed in tests with lastModified = 0).
    // If two different files hash to the same ID (identical name/size/mtime),
    // append the counter-factory suffix to guarantee document-level uniqueness.
    let attachmentId =
      file.lastModified !== 0
        ? useStableId(`${file.name}\0${file.size}\0${file.lastModified}`)
        : attachmentIdFactory.next();
    if (usedAttachmentIds.has(attachmentId)) {
      attachmentId = `${attachmentId}-${attachmentIdFactory.next()}`;
    }
    usedAttachmentIds.add(attachmentId);
    return attachmentId;
  }

  function describeFailure(failure: ChatAttachmentFailure): string {
    if (formatAttachmentError) return formatAttachmentError(failure);
    if (failure.kind === 'type-not-accepted') {
      return typeNotAcceptedText(failure.acceptedTypes);
    }
    if (failure.kind === 'too-large') {
      return `File exceeds ${Math.round(failure.maxFileSize / (1024 * 1024))}MB limit`;
    }
    return labels.uploadFailed;
  }

  /** Why the composer refuses `file` before reading or uploading it, or `undefined` to take it. */
  function refusalOf(file: File): ChatAttachmentFailure | undefined {
    if (!isValidType(file)) {
      return { kind: 'type-not-accepted', file, acceptedTypes };
    }
    if (file.size > maxFileSize) return { kind: 'too-large', file, maxFileSize };
    return undefined;
  }

  /** What a refusal is, as the attachment keeps it: the kind that words it, and the limit. */
  function refusalDetails(
    refusal: ChatAttachmentFailure,
  ): Pick<ChatAttachment, 'failureKind' | 'maxFileSize' | 'acceptedTypes'> {
    if (refusal.kind === 'too-large') {
      return { failureKind: 'too-large', maxFileSize: refusal.maxFileSize };
    }
    return { failureKind: 'unsupported-type', acceptedTypes };
  }

  /** `attachment` as an `error` row: its upload reference is dropped, so it can never be sent. */
  function refused(
    attachment: ChatAttachment,
    message: string,
    refusal: ChatAttachmentFailure,
  ): ChatAttachment {
    const { reference: _reference, progress: _progress, ...others } = attachment;
    return { ...others, status: 'error', error: message, ...refusalDetails(refusal) };
  }

  /**
   * The limits are the host's to change after files are in the composer (it changes the agent a
   * person writes to, and the agent's model decides what it takes). A file the new limits refuse
   * is stopped, shown as an `error` row with the reason, and never sent, as one refused when it
   * was added is. A file the limits still take is left alone.
   */
  $effect(() => {
    // Only a change to the limits runs this; the attachments are read without being tracked.
    void acceptedTypes;
    void maxFileSize;
    untrack(() => {
      for (const attachment of attachments) {
        if (attachment.status === 'error' || attachment.restoreText !== undefined) continue;
        const refusal = refusalOf(attachment.file);
        if (refusal === undefined) continue;
        abortUploads([attachment.id]);
        const message = describeFailure(refusal);
        attachments = attachments.map((entry) =>
          entry.id === attachment.id ? refused(entry, message, refusal) : entry,
        );
        onAttachmentFailure?.(attachment.file, message);
      }
    });
  });

  function addAttachment(
    file: File,
    restoreText: string | undefined = undefined,
    restoreRange: { start: number; end: number } | undefined = undefined,
  ): ChatAttachment | null {
    const refusal = refusalOf(file);
    if (refusal) {
      const message = describeFailure(refusal);
      onAttachmentFailure?.(file, message);
      // A promoted paste that is refused simply pastes as text. A file the person chose is shown
      // as an error row, so they see which one was left out and why.
      if (restoreText === undefined) {
        const kind = deriveAttachmentKind(file.type);
        attachments = [
          ...attachments,
          {
            id: newAttachmentId(file),
            file,
            previewUrl: URL.createObjectURL(file),
            kind,
            status: 'error',
            error: message,
            ...refusalDetails(refusal),
          },
        ];
      }
      return null;
    }

    const kind = deriveAttachmentKind(file.type);
    const uploads = uploadAttachment !== undefined && restoreText === undefined;

    const attachment: ChatAttachment = {
      id: newAttachmentId(file),
      file,
      previewUrl: URL.createObjectURL(file),
      kind,
      status: uploads
        ? 'uploading'
        : kind === 'code' && restoreText === undefined
          ? 'pending'
          : 'ready',
      ...(restoreText === undefined ? {} : { textContent: restoreText }),
      ...(restoreText === undefined ? {} : { restoreText }),
      ...(restoreRange === undefined ? {} : { restoreRange }),
    };

    attachments = [...attachments, attachment];
    onAttachmentAdd?.(attachment);
    announcer.announce(`${kindLabel(kind)} attached: ${file.name}`);

    if (uploads) {
      startUpload(attachment, uploadAttachment);
      return attachment;
    }

    // Fire-and-forget text extraction for code files
    if (kind === 'code' && restoreText === undefined) {
      void file.text().then(
        (text) => {
          attachments = attachments.map((a) =>
            a.id === attachment.id ? { ...a, textContent: text, status: 'ready' as const } : a,
          );
          return undefined;
        },
        () => {
          attachments = attachments.map((a) =>
            a.id === attachment.id
              ? {
                  ...a,
                  status: 'error' as const,
                  error: 'Failed to read file',
                  failureKind: 'unknown' as const,
                }
              : a,
          );
          return undefined;
        },
      );
    }
    return attachment;
  }

  /** The uploads still going, by attachment, so removing an attachment can stop its upload. */
  const uploadControllers = new Map<string, AbortController>();

  function startUpload(attachment: ChatAttachment, upload: ChatAttachmentUpload): void {
    const controller = new AbortController();
    uploadControllers.set(attachment.id, controller);
    const settle = (changes: Partial<ChatAttachment>): void => {
      // An attachment removed or cleared meanwhile is gone, and what the upload answers is moot.
      if (controller.signal.aborted) return;
      attachments = attachments.map((a) => (a.id === attachment.id ? { ...a, ...changes } : a));
    };
    void (async () => {
      try {
        const reference = await upload(attachment.file, {
          signal: controller.signal,
          onProgress: (fraction) => {
            if (controller.signal.aborted || !Number.isFinite(fraction)) return;
            settle({ progress: Math.min(1, Math.max(0, fraction)) });
          },
        });
        settle({ status: 'ready', reference });
        if (!controller.signal.aborted) announcer.announce(`${attachment.file.name} is ready`);
      } catch (failure) {
        // Removing the attachment aborts the upload, and the rejection that follows is not a failure.
        if (controller.signal.aborted) return;
        const message = describeFailure({
          kind: 'upload-failed',
          file: attachment.file,
          error: failure,
        });
        const { kind, maxFileSize: limit } = classifyUploadFailure(failure);
        settle({
          status: 'error',
          error: message,
          failureKind: kind,
          ...(limit === undefined ? {} : { maxFileSize: limit }),
          ...(kind === 'unsupported-type' ? { acceptedTypes } : {}),
          retryable: isRetryableFailure(kind),
        });
      } finally {
        uploadControllers.delete(attachment.id);
      }
    })();
  }

  /** Uploads a failed attachment again, as it was first uploaded. */
  function retryAttachment(attachmentId: string): boolean {
    const upload = uploadAttachment;
    const attachment = attachments.find((entry) => entry.id === attachmentId);
    if (upload === undefined || attachment === undefined || !canRetry(attachment)) return false;
    const {
      error: _error,
      progress: _progress,
      retryable: _retryable,
      reference: _reference,
      failureKind: _failureKind,
      maxFileSize: _maxFileSize,
      acceptedTypes: _acceptedTypes,
      ...others
    } = attachment;
    const retrying: ChatAttachment = { ...others, status: 'uploading' };
    attachments = attachments.map((entry) => (entry.id === attachmentId ? retrying : entry));
    startUpload(retrying, upload);
    return true;
  }

  /**
   * Retries what the line under the strip offers: one file, or every failed file that can be tried
   * again. The controls that asked go away with the failure, so focus moves to the first retried
   * chip's remove control, which stays.
   */
  async function retryFailed(attachmentIds: readonly string[]): Promise<void> {
    const retried = attachmentIds.filter((attachmentId) => retryAttachment(attachmentId));
    const [first] = retried;
    if (first === undefined) return;
    announcer.announce(
      retried.length === 1
        ? `Retrying ${attachments.find((entry) => entry.id === first)?.file.name ?? ''}`
        : `Retrying ${retried.length} files`,
    );
    await tick();
    removeControlOf(first)?.focus();
  }

  /** Removes the failed files the line under the strip is about, and moves focus on. */
  function removeFailed(attachmentIds: readonly string[]): void {
    const before = attachments.map((entry) => entry.id);
    const removed = new Set(attachmentIds);
    for (const attachmentId of attachmentIds) removeAttachment(attachmentId, { moveFocus: false });
    void focusStripAfterRemoval(before, removed);
  }

  /**
   * What the line's action does, for the failed files it speaks of. With some files that can be
   * tried again and some that cannot, the line has two actions: `retry` tries again the files that
   * can be, and `remove` takes away the rest.
   */
  function runFailureLineAction(part: 'retry' | 'remove' | undefined = undefined): void {
    const line = failureLine;
    if (line === undefined) return;
    const failed = attachments.filter(needsAttention);
    if (line.type === 'one') {
      if (line.action === 'retry') void retryFailed([line.attachment.id]);
      else removeFailed([line.attachment.id]);
    } else if (line.action === 'retry-all' || (line.action === 'retry-some' && part === 'retry')) {
      void retryFailed(failed.filter(canRetry).map((entry) => entry.id));
    } else if (line.action === 'retry-some') {
      removeFailed(failed.filter((entry) => !canRetry(entry)).map((entry) => entry.id));
    } else {
      removeFailed(failed.map((entry) => entry.id));
    }
  }

  /**
   * What activating a failed chip's main area does. One failed file is retried, when it can be.
   * Among several, the chip is picked and the line says why that file failed; activating the picked
   * chip again lets the line speak of them all.
   */
  function chipActivation(attachment: ChatAttachment): (() => void) | undefined {
    if (!needsAttention(attachment)) return undefined;
    if (attachments.filter(needsAttention).length > 1) {
      return () => {
        pickedFailureId = pickedFailureId === attachment.id ? undefined : attachment.id;
      };
    }
    return canRetry(attachment) ? () => void retryFailed([attachment.id]) : undefined;
  }

  function abortUploads(ids?: readonly string[]): void {
    for (const [attachmentId, controller] of uploadControllers) {
      if (ids === undefined || ids.includes(attachmentId)) controller.abort();
    }
  }

  /** The remove control of an attached file's chip, which stays while the chip's other controls go. */
  function removeControlOf(attachmentId: string): HTMLElement | null {
    return (
      formElement?.querySelector<HTMLElement>(
        `[data-attachment-id="${CSS.escape(attachmentId)}"] .chat-input-attachment-remove`,
      ) ?? null
    );
  }

  /**
   * Puts focus back where it can act once the chips it was on are gone: the remove control of the
   * chip that took the first one's place, else the one before it, else the text field. `before` is
   * the strip's order before the removal.
   */
  async function focusStripAfterRemoval(before: readonly string[], removed: ReadonlySet<string>) {
    const first = before.findIndex((entryId) => removed.has(entryId));
    await tick();
    const remaining = before.filter((entryId) => !removed.has(entryId));
    const following = before.slice(first + 1).find((entryId) => !removed.has(entryId));
    const preceding = before
      .slice(0, Math.max(first, 0))
      .findLast((entryId) => !removed.has(entryId));
    const target = following ?? preceding;
    const control =
      target === undefined || !remaining.includes(target) ? null : removeControlOf(target);
    (control ?? editorElement)?.focus();
  }

  function removeAttachment(attachmentId: string, options: { moveFocus?: boolean } = {}): void {
    const attachment = attachments.find((a) => a.id === attachmentId);
    if (attachment) {
      const before = attachments.map((entry) => entry.id);
      const held = formElement?.contains(document.activeElement) === true;
      const moveFocus =
        options.moveFocus ??
        (held &&
          document.activeElement
            ?.closest('[data-attachment-id]')
            ?.getAttribute('data-attachment-id') === attachmentId);
      if (moveFocus && attachment.restoreText === undefined) {
        void focusStripAfterRemoval(before, new Set([attachmentId]));
      }
      abortUploads([attachmentId]);
      URL.revokeObjectURL(attachment.previewUrl);
      attachments = attachments.filter((a) => a.id !== attachmentId);
      if (attachment.restoreText) {
        const start = Math.min(attachment.restoreRange?.start ?? value.length, value.length);
        const end = Math.min(attachment.restoreRange?.end ?? value.length, value.length);
        const insertedLength = attachment.restoreText.length;
        const replacedLength = end - start;
        const translatePosition = (position: number): number => {
          if (position <= start) return position;
          if (position >= end) return position + insertedLength - replacedLength;
          return start + insertedLength;
        };
        attachments = attachments.map((remainingAttachment) =>
          remainingAttachment.restoreRange
            ? {
                ...remainingAttachment,
                restoreRange: {
                  start: translatePosition(remainingAttachment.restoreRange.start),
                  end: translatePosition(remainingAttachment.restoreRange.end),
                },
              }
            : remainingAttachment,
        );
        value = `${value.slice(0, start)}${attachment.restoreText}${value.slice(end)}`;
        onComposerInput?.(value);
        const caretIndex = start + attachment.restoreText.length;
        previousComposerValue = value;
        queueMicrotask(() => editorElement?.setSelectionRange(caretIndex, caretIndex));
      }
      onAttachmentRemove?.(attachment);
      announcer.announce(`${kindLabel(attachment.kind)} removed`);
    }
  }

  function handleFileSelect(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = input.files;
    if (files) {
      Array.from(files).forEach((file) => addAttachment(file));
    }
    // Reset input for re-selection of same file
    input.value = '';
  }

  function handlePaste(event: ClipboardEvent): void {
    if (!allowAttachments) return;

    const items = event.clipboardData?.items;
    if (!items) return;

    // Collect all files from clipboard
    const files: File[] = [];
    for (const item of items) {
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    // If we have files, prevent default and let addAttachment handle all validation
    // (including calling onAttachmentFailure for invalid types/sizes)
    if (files.length > 0) {
      event.preventDefault();
      files.forEach((file) => addAttachment(file));
      return;
    }

    const pastedText = event.clipboardData?.getData('text/plain') ?? '';
    if (pastedText.length >= largePasteThreshold) {
      const file = new File([pastedText], 'pasted-text.txt', {
        type: 'text/plain',
        lastModified: 0,
      });
      const restoreRange = {
        start: editorElement?.selectionStart ?? value.length,
        end: editorElement?.selectionEnd ?? value.length,
      };
      if (addAttachment(file, pastedText, { start: restoreRange.start, end: restoreRange.start })) {
        event.preventDefault();
        if (editorElement) {
          editorElement.setRangeText('', restoreRange.start, restoreRange.end, 'start');
          value = editorElement.value;
          previousComposerValue = value;
          onComposerInput?.(value, event);
        }
      }
    }
  }

  function handleDrop(event: DragEvent): void {
    isDragOver = false;
    dragEnterDepth = 0;

    if (!allowAttachments || !isFileDrag(event)) return;

    // Prevent default (browser opening/downloading the file) and stop propagation
    // only when attachments are enabled and we are actually handling the drop.
    // When attachments are disabled, the event bubbles and the browser's default
    // behavior is preserved.
    event.preventDefault();
    event.stopPropagation();

    const files = event.dataTransfer?.files;
    if (files) {
      // Let addAttachment handle all validation (type and size)
      Array.from(files).forEach((file) => addAttachment(file));
    }
  }

  function handleDragOver(event: DragEvent): void {
    if (!allowAttachments || !isFileDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    isDragOver = true;
  }

  function handleDragEnter(event: DragEvent): void {
    if (!allowAttachments || !isFileDrag(event)) return;
    event.preventDefault();
    dragEnterDepth += 1;
    isDragOver = true;
  }

  function handleDragLeave(event: DragEvent): void {
    if (!allowAttachments) return;
    dragEnterDepth = Math.max(0, dragEnterDepth - 1);
    if (dragEnterDepth === 0 || !formElement?.contains(event.relatedTarget as Node)) {
      dragEnterDepth = 0;
      isDragOver = false;
    }
  }

  function isFileDrag(event: DragEvent): boolean {
    const transfer = event.dataTransfer;
    return Boolean(transfer?.types.includes('Files') || transfer?.files.length);
  }

  // =========================================================================
  // Form Submission
  // =========================================================================

  function handleSubmit(event: SubmitEvent): void {
    if (!canSubmit) {
      event.preventDefault();
      return;
    }

    // Get the latest content directly from the textarea to avoid bind update lag.
    // The bound `value` may be stale if the user typed and pressed Enter quickly.
    const latestContent = editorElement?.value ?? value;
    const trimmedContent = latestContent.trim();

    // Re-check for whitespace-only after getting latest content
    const readyAttachments = attachments.filter((a) => a.status === 'ready');
    const promotedPastes = readyAttachments.filter(
      (attachment) => attachment.restoreText !== undefined,
    );
    if (trimmedContent.length === 0 && promotedPastes.length === 0 && !hasReadyAttachments) {
      event.preventDefault();
      return;
    }

    const submittedContent = promotedPastes
      .map((attachment, index) => ({ attachment, index }))
      .slice()
      .sort(
        (left, right) =>
          (right.attachment.restoreRange?.start ?? latestContent.length) -
            (left.attachment.restoreRange?.start ?? latestContent.length) ||
          right.index - left.index,
      )
      .reduce((content, { attachment }) => {
        const start = Math.min(attachment.restoreRange?.start ?? content.length, content.length);
        const end = Math.min(attachment.restoreRange?.end ?? start, content.length);
        return `${content.slice(0, start)}${attachment.restoreText ?? ''}${content.slice(end)}`;
      }, latestContent)
      .trim();
    if (submittedContent.length === 0 && !hasReadyAttachments) {
      event.preventDefault();
      return;
    }
    const message: MessageInput = {
      role: 'user',
      content: submittedContent,
    };

    // Call onsubmit callback. A failed file blocks Send, so every attachment here is ready.
    onsubmit?.(
      message,
      readyAttachments.filter((attachment) => attachment.restoreText === undefined),
    );

    // In standalone mode, prevent default form submission
    if (!isFormActionMode) {
      event.preventDefault();

      if (clearOnSubmit) {
        // Clear state
        value = '';
        previousComposerValue = '';
        abortUploads();
        attachments.forEach((a) => URL.revokeObjectURL(a.previewUrl));
        attachments = [];
      }

      // Restore focus to editor
      editorElement?.focus();
      announcer.announce('Message sent');
    } else {
      // In form action mode, sync the bound value with trimmed content
      // so the hidden input sends the same content as the callback.
      // This fixes debounce lag and ensures consistent data.
      flushSync(() => {
        value = submittedContent;
        for (const attachment of promotedPastes) URL.revokeObjectURL(attachment.previewUrl);
        attachments = attachments.filter((attachment) => attachment.restoreText === undefined);
      });
      previousComposerValue = submittedContent;
    }
  }

  // =========================================================================
  // Keyboard Handling
  // =========================================================================

  function handleKeyDown(event: KeyboardEvent): void {
    // Ignore keydown events during IME composition (e.g., Japanese/Chinese/Korean input).
    // During composition, Enter confirms the candidate, not sends the message.
    if (event.isComposing || isComposing) {
      return;
    }

    if (event.target === editorElement) {
      oncomposerkeydown?.(event);
      if (event.defaultPrevented) {
        return;
      }
      const format = composerShortcutFormat(event);
      if (format) {
        event.preventDefault();
        applyFormat(format);
        return;
      }
    }

    if (event.key !== 'Enter' || event.shiftKey || event.altKey) return;

    const modifierPressed = event.metaKey || event.ctrlKey;
    const shouldSubmit =
      submitOn === 'modifier-enter'
        ? modifierPressed
        : !modifierPressed &&
          (submitOn === 'enter' || (submitOn === 'enter-if-single-line' && !value.includes('\n')));

    if (shouldSubmit) {
      event.preventDefault();
      if (canSubmit) {
        formElement?.requestSubmit();
      }
    }
  }

  function handleCompositionStart(): void {
    isComposing = true;
  }

  function handleCompositionEnd(): void {
    isComposing = false;
  }

  // Fires after `bind:value` has already applied the textarea's new value
  // (Svelte merges the binding's own input listener with this handler on the
  // same event), so `value` here is always current — never one keystroke stale.
  let previousComposerValue = value;
  let pendingInputRange: { start: number; end: number } | null = null;

  function translatePromotedPasteRanges(
    previousValue: string,
    nextValue: string,
    replacementRange: { start: number; end: number } | null | undefined = undefined,
  ): void {
    let prefixLength = replacementRange?.start ?? 0;
    let replacedEnd = replacementRange?.end ?? 0;
    if (!replacementRange) {
      while (
        prefixLength < previousValue.length &&
        prefixLength < nextValue.length &&
        previousValue[prefixLength] === nextValue[prefixLength]
      ) {
        prefixLength += 1;
      }
      let suffixLength = 0;
      while (
        suffixLength < previousValue.length - prefixLength &&
        suffixLength < nextValue.length - prefixLength &&
        previousValue[previousValue.length - 1 - suffixLength] ===
          nextValue[nextValue.length - 1 - suffixLength]
      ) {
        suffixLength += 1;
      }
      replacedEnd = previousValue.length - suffixLength;
    }
    const insertedLength = nextValue.length - (previousValue.length - (replacedEnd - prefixLength));
    const translatePosition = (position: number): number => {
      if (position <= prefixLength) return position;
      if (position >= replacedEnd) {
        return position + insertedLength - (replacedEnd - prefixLength);
      }
      return prefixLength + insertedLength;
    };
    attachments = attachments.map((attachment) =>
      attachment.restoreRange
        ? {
            ...attachment,
            restoreRange: {
              start: translatePosition(attachment.restoreRange.start),
              end: translatePosition(attachment.restoreRange.end),
            },
          }
        : attachment,
    );
  }

  $effect(() => {
    const synchronizedValue = value;
    if (editorElement?.value === synchronizedValue && synchronizedValue !== previousComposerValue) {
      translatePromotedPasteRanges(previousComposerValue, synchronizedValue);
      previousComposerValue = synchronizedValue;
    }
  });

  function handleInput(event: Event): void {
    if (value !== previousComposerValue) {
      translatePromotedPasteRanges(previousComposerValue, value, pendingInputRange);
      previousComposerValue = value;
    }
    pendingInputRange = null;
    onComposerInput?.(value, event);
  }

  function handleBeforeInput(event: InputEvent): void {
    if (!editorElement) return;
    if (
      event.inputType.startsWith('delete') &&
      event.inputType !== 'deleteContentBackward' &&
      event.inputType !== 'deleteContentForward'
    ) {
      pendingInputRange = null;
      return;
    }
    let start = editorElement.selectionStart;
    let end = editorElement.selectionEnd;
    if (start === end && event.inputType === 'deleteContentBackward')
      start = Math.max(0, start - 1);
    if (start === end && event.inputType === 'deleteContentForward') {
      end = Math.min(previousComposerValue.length, end + 1);
    }
    pendingInputRange = { start, end };
  }

  /** Apply the Web IDL unsigned-long coercion used by textarea range methods. */
  function toUnsignedLong(index: number): number {
    return index >>> 0;
  }

  // =========================================================================
  // Imperative API
  // =========================================================================

  export function focus(): void {
    editorElement?.focus();
  }

  export function clear(): void {
    value = '';
    previousComposerValue = '';
    abortUploads();
    attachments.forEach((a) => URL.revokeObjectURL(a.previewUrl));
    attachments = [];
  }

  export function getAttachments(): ChatAttachment[] {
    return [...attachments];
  }

  export function getValue(): string {
    return value;
  }

  export function getEditorElement(): HTMLTextAreaElement | null {
    return editorElement;
  }

  /** Replace a composer range using native textarea range semantics. */
  export function insertAtRange(range: { start: number; end: number }, text: string): void {
    if (!editorElement) return;

    const previousValue = editorElement.value;
    const replacementStart = Math.min(toUnsignedLong(range.start), previousValue.length);
    const replacementEnd = Math.min(toUnsignedLong(range.end), previousValue.length);
    editorElement.setRangeText(text, replacementStart, replacementEnd, 'end');
    const nextValue = editorElement.value;
    const caret = nextValue.length - (previousValue.length - replacementEnd);
    const delta = text.length - (replacementEnd - replacementStart);
    const translatePosition = (position: number): number => {
      if (position <= replacementStart) return position;
      if (position >= replacementEnd) return position + delta;
      return replacementStart + text.length;
    };
    attachments = attachments.map((attachment) =>
      attachment.restoreRange
        ? {
            ...attachment,
            restoreRange: {
              start: translatePosition(attachment.restoreRange.start),
              end: translatePosition(attachment.restoreRange.end),
            },
          }
        : attachment,
    );
    flushSync(() => {
      value = nextValue;
    });
    previousComposerValue = nextValue;
    editorElement.focus();
    editorElement.setSelectionRange(caret, caret);
    onComposerInput?.(value);
  }

  /**
   * Applies a formatting command to the composer's selection: wraps it in
   * `**`, `*`, or backticks (unwrapping an already-wrapped selection), makes
   * it a link, or toggles list markers on its lines.
   */
  export function applyFormat(format: ChatComposerFormat): void {
    if (!editorElement || disabled) return;
    const edit = applyComposerFormat(
      editorElement.value,
      editorElement.selectionStart,
      editorElement.selectionEnd,
      format,
    );
    insertAtRange({ start: edit.start, end: edit.end }, edit.text);
    editorElement.setSelectionRange(edit.selectionStart, edit.selectionEnd);
  }

  export function addFiles(files: File[]): void {
    if (!allowAttachments) return;
    files.forEach((file) => addAttachment(file));
  }

  // =========================================================================
  // Cleanup
  // =========================================================================

  // The composer's own teardown rather than the form's: a blocked row replaces the form for a
  // while, and the files attached before it came must outlive it.
  $effect(() => () => {
    abortUploads();
    attachments.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
  });
</script>

<div class="chat-input-shell">
  {#if blocked !== undefined}
    <div
      class={classNames('chat-input', 'chat-input-blocked', className)}
      data-chat-composer-status="blocked"
      role="group"
      aria-label={labels.composerUnavailable}
    >
      <div class="chat-input-blocked-message">
        <TriangleAlert class="chat-input-blocked-glyph cinder-icon-sm" aria-hidden="true" />
        <p class="chat-input-blocked-reason">{blocked.reason}</p>
      </div>
      {#if blocked.action !== undefined || blocked.link !== undefined}
        <div class="chat-input-blocked-actions">
          {#if blocked.link !== undefined}
            {#if blocked.link.href !== undefined}
              <Button
                variant="ghost"
                size="sm"
                href={blocked.link.href}
                label={blocked.link.label}
                onclick={blocked.link.onclick}
              />
            {:else}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                label={blocked.link.label}
                onclick={blocked.link.onclick}
              />
            {/if}
          {/if}
          {#if blocked.action !== undefined}
            {#if blocked.action.href !== undefined}
              <Button
                variant={blocked.action.primary === true ? 'primary' : 'secondary'}
                size="sm"
                href={blocked.action.href}
                label={blocked.action.label}
                onclick={blocked.action.onclick}
              />
            {:else}
              <Button
                type="button"
                variant={blocked.action.primary === true ? 'primary' : 'secondary'}
                size="sm"
                label={blocked.action.label}
                onclick={blocked.action.onclick}
              />
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  {:else if notice !== undefined}
    <!-- Archived or read only: one neutral bar in place of the composer. It is not a Callout because
         it is the composer's own box (same frame, role group and tooltip label), not a notice about
         the transcript above it. The secondary action sits on the left and the primary one on the
         right, after the words. -->
    <div
      class={classNames('chat-input', 'chat-input-blocked', 'chat-input-notice', className)}
      data-chat-composer-status={notice.kind}
      role="group"
      aria-label={notice.kind === 'archived' ? labels.chatArchived : labels.chatReadOnly}
    >
      <div class="chat-input-blocked-message">
        {#if notice.kind === 'archived'}
          <svg
            class="chat-input-notice-glyph cinder-icon-sm"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect width="20" height="5" x="2" y="3" rx="1" />
            <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
            <path d="M10 12h4" />
          </svg>
          <p class="chat-input-blocked-reason" dir="auto">{statusText}</p>
        {:else}
          <svg
            class="chat-input-notice-glyph cinder-icon-sm"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
          <p class="chat-input-blocked-reason" dir="auto">
            {#if notice.tooltip !== undefined}
              <button type="button" class="chat-input-notice-label" bind:this={noticeLabelRef}>
                {statusText}
              </button>
              <Tooltip
                text={notice.tooltip}
                class="chat-input-tooltip"
                placement="top"
                triggerRef={noticeLabelRef}
              />
            {:else}
              {statusText}
            {/if}
          </p>
        {/if}
      </div>
      {#if noticeHasActions}
        <div class="chat-input-blocked-actions">
          {#if notice.kind === 'archived'}
            {#if notice.newChat !== undefined}
              {@render noticeAction(notice.newChat, 'secondary')}
            {/if}
            {#if notice.unarchive !== undefined}
              {@render noticeAction(notice.unarchive, 'primary')}
            {/if}
          {:else if notice.request !== undefined}
            {@render noticeAction(notice.request, 'primary')}
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    {#if connectionNotice}
      {@render connectionNotice()}
    {/if}
    {#if drawerStatus !== undefined}
      <!-- A drawer above the box: it pushes the transcript up and leaves the composer's bottom
           edge where it was. -->
      {#snippet drawerIcon()}
        {#if drawerStatus?.kind === 'reconnecting'}
          <Spinner size="sm" label={statusText ?? ''} class="chat-input-drawer-glyph" />
        {:else if drawerTone === 'warning' || drawerTone === 'danger'}
          <TriangleAlert class="chat-input-drawer-glyph cinder-icon-sm" aria-hidden="true" />
        {:else}
          <Info class="chat-input-drawer-glyph cinder-icon-sm" aria-hidden="true" />
        {/if}
      {/snippet}
      <Callout
        id={drawerId}
        class="chat-input-drawer"
        data-chat-composer-drawer={drawerStatus.kind}
        variant={drawerTone}
        semantic="note"
        icon={drawerIcon}
        aria-label={drawerStatus.kind === 'offline'
          ? labels.offline
          : drawerStatus.kind === 'draft-restored'
            ? labels.draftRestored
            : labels.notice}
      >
        {statusText}
        {#if drawerStatus.kind === 'drawer-notice' && drawerStatus.sendDisabledReason !== undefined}
          <span id={drawerReasonId} class="chat-input-drawer-reason" dir="auto">
            {drawerStatus.sendDisabledReason}
          </span>
        {/if}
        {#snippet action()}
          {#if drawerStatus.kind === 'draft-restored'}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              class="chat-input-drawer-action"
              label={COMPOSER_DISCARD_DRAFT_LABEL}
              onclick={discardRestoredDraft}
            />
          {:else if drawerStatus.kind === 'drawer-notice' && drawerStatus.action !== undefined}
            {@render noticeAction(drawerStatus.action, 'secondary')}
          {/if}
        {/snippet}
      </Callout>
    {/if}
    <form
      bind:this={formElement}
      class={classNames('chat-input', isDragOver && 'chat-input-dragover', className)}
      data-compact={compact || undefined}
      data-controls-folded={folded || undefined}
      data-ready={(canSubmit && !offline && !showStopButton) || undefined}
      data-queueing={queueing || undefined}
      data-single-row={!allowAttachments && controls === undefined && toolbar === undefined
        ? ''
        : undefined}
      method="POST"
      {action}
      onsubmit={handleSubmit}
      data-formatting-open={formattingOpen || undefined}
      onfocusin={handleFocusIn}
      onfocusout={handleFocusOut}
      onpaste={handlePaste}
      ondrop={handleDrop}
      ondragenter={handleDragEnter}
      ondragover={handleDragOver}
      ondragleave={handleDragLeave}
      oncompositionstart={handleCompositionStart}
      oncompositionend={handleCompositionEnd}
      aria-label={labels.composer}
      aria-busy={sending || starting !== undefined || undefined}
      {...rest}
    >
      {#if isDragOver}
        <div class="chat-input-drop-overlay" aria-hidden="true">
          <Paperclip class="cinder-icon-md" />
          <span>{labels.dropFiles}</span>
        </div>
      {/if}
      <!-- Hidden input for form action mode -->
      {#if isFormActionMode}
        <input type="hidden" {name} {value} />
      {/if}

      {#if header}
        <div class="chat-input-header">{@render header()}</div>
      {/if}

      {#if formattingToolbar}
        <div class="chat-input-format">
          <div class="chat-input-toolbar" role="toolbar" aria-label={labels.formatting}>
            {#each FORMATTING_BUTTONS as button (button.format)}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={button.label}
                aria-keyshortcuts={button.keyshortcuts}
                disabled={disabled || paused || sendBlocked}
                onmousedown={(event: MouseEvent) => event.preventDefault()}
                onclick={() => applyFormat(button.format)}
              >
                <button.icon class="cinder-icon-sm" />
              </Button>
            {/each}
          </div>
          <p class="chat-input-format-hint" aria-hidden="true">
            {#each FORMATTING_HINTS as shortcut (shortcut)}<span>{shortcut}</span>{/each}
          </p>
        </div>
      {/if}

      <!-- Attachments: one strip of chips that scrolls sideways when they do not fit, and, only
           while a failure blocks Send, one line under it that says what happened. -->
      {#if attachments.length > 0}
        <div class="chat-input-attachment-strip">
          <ul
            id={attachmentListId}
            class="chat-input-attachments"
            aria-label={labels.attachedFiles}
            {@attach scrollEdgeFade('inline')}
          >
            {#each attachments as attachment (attachment.id)}
              <li
                class="chat-input-attachment-wrapper"
                data-attachment-state={attachment.status}
                data-attachment-id={attachment.id}
              >
                <ChatAttachmentPreview
                  {attachment}
                  {labels}
                  picked={pickedFailureId === undefined
                    ? undefined
                    : pickedFailureId === attachment.id}
                  onactivate={chipActivation(attachment)}
                  activateLabel={attachments.filter(needsAttention).length > 1
                    ? labels.showAttachmentFailureAccessible(attachment.file.name)
                    : labels.retryAttachmentAccessible(attachment.file.name)}
                >
                  {#snippet action()}
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      quiet
                      iconOnly
                      class="chat-input-attachment-remove"
                      label={labels.removeAttachment}
                      aria-label={labels.removeAttachmentAccessible(attachment.file.name)}
                      onclick={() => removeAttachment(attachment.id)}
                    >
                      <X class="cinder-icon-xs" aria-hidden="true" />
                    </Button>
                  {/snippet}
                </ChatAttachmentPreview>
              </li>
            {/each}
          </ul>
          {#if failureLine !== undefined}
            <!-- The failure is the standard danger notice, the same Callout every other chat notice
                 is: its glyph, the words with the file's name as the token the chip above has, and
                 the action at the trailing end. It is not a live region; the composer's live
                 region tells it once. -->
            <Callout
              variant="danger"
              semantic="note"
              actionLayout={failureLine.type !== 'many' &&
              (failureLine.action === 'retry' || failureLine.action === 'remove')
                ? 'beside'
                : 'fit'}
              class="chat-input-attachment-reason"
              data-chat-attachment-failure
            >
              {#snippet icon()}
                <TriangleAlert aria-hidden="true" />
              {/snippet}
              <span id={attachmentReasonId} class="chat-input-attachment-reason-text" dir="auto"
                >{#if failureLineParts}{failureLineParts.before}<span
                    class="chat-input-attachment-reason-name"
                    title={failureLineParts.name}>{failureLineParts.name}</span
                  >{failureLineParts.after}{:else}{failureLineText}{/if}</span
              >
              {#snippet action()}
                {#if failureLine.type !== 'many' && (failureLine.action === 'retry' || failureLine.action === 'remove')}
                  <!-- One file, one obvious act: a glyph says it, the way the chip's own remove does.
                       Its name says which file, so it is not only "Remove" to a screen reader. -->
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    quiet
                    iconOnly
                    class="chat-input-attachment-reason-action"
                    label={failureLineActionLabel ?? ''}
                    aria-label={failureLine.action === 'retry'
                      ? labels.retryAttachmentAccessible(failureLine.attachment.file.name)
                      : labels.removeAttachmentAccessible(failureLine.attachment.file.name)}
                    onclick={() => runFailureLineAction()}
                  >
                    {#if failureLine.action === 'retry'}
                      <RotateCcw class="cinder-icon-xs" aria-hidden="true" />
                    {:else}
                      <X class="cinder-icon-xs" aria-hidden="true" />
                    {/if}
                  </Button>
                {:else if failureLine.type === 'many'}
                  <!-- Several files: the action is its words, drawn as every notice's worded
                       action is, a compact secondary button. It offers only what can work: Retry
                       all when every file can be tried again, Retry N with Remove failed for the
                       rest when only some can, and Remove all failed when none can. -->
                  {#if failureLine.action === 'retry-some'}
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      class="chat-input-attachment-reason-action"
                      label={labels.removeFailedAttachments}
                      aria-label={labels.removeFailedAttachmentsAccessible(
                        failureLine.count - failureLine.retryable,
                      )}
                      onclick={() => runFailureLineAction('remove')}
                    />
                    <RetryButton
                      class="chat-input-attachment-reason-action"
                      label={labels.retryAttachments(failureLine.retryable)}
                      ariaLabel={labels.retryAttachmentsAccessible(failureLine.retryable)}
                      onclick={() => runFailureLineAction('retry')}
                    />
                  {:else if failureLine.action === 'retry-all'}
                    <RetryButton
                      class="chat-input-attachment-reason-action"
                      label={labels.retryAllAttachments}
                      onclick={() => runFailureLineAction()}
                    />
                  {:else}
                    <Button
                      type="button"
                      variant="secondary"
                      size="sm"
                      class="chat-input-attachment-reason-action"
                      label={labels.removeAllFailedAttachments}
                      onclick={() => runFailureLineAction()}
                    />
                  {/if}
                {/if}
              {/snippet}
            </Callout>
          {/if}
        </div>
      {/if}

      <!-- Editor area -->
      <div class="chat-input-editor-container">
        {#if markdownStyling}
          <div bind:this={markdownBackdrop} class="chat-input-markdown" aria-hidden="true">
            {#each markdownSegments as segment, index (index)}<span
                class={`chat-input-markdown-${segment.kind}`}>{segment.text}</span
              >{/each}{#if value === '' || value.endsWith('\n')}&#8203;{/if}
          </div>
        {/if}
        <textarea
          bind:this={editorElement}
          id={`${id}-editor`}
          bind:value
          onkeydown={handleKeyDown}
          onbeforeinput={handleBeforeInput}
          oninput={handleInput}
          onpointerup={oncomposerselectionchange}
          onselect={oncomposerselectionchange}
          onblur={oncomposerblur}
          onscroll={syncBackdropScroll}
          placeholder={resolvedPlaceholder}
          role={composerRole}
          aria-label={resolvedComposerLabel}
          aria-expanded={composerAriaExpanded}
          aria-controls={composerAriaControls}
          aria-activedescendant={composerAriaActiveDescendant}
          aria-autocomplete={composerAriaAutocomplete}
          {disabled}
          readonly={paused}
          class={classNames('chat-input-editor', markdownStyling && 'chat-input-editor-styled')}
          aria-describedby={shortcutDescriptionId}
          rows="1"></textarea>
      </div>

      <!-- Footer with actions -->
      <div class="chat-input-footer">
        <div class="chat-input-footer-left" bind:this={footerLeftElement}>
          {#if allowAttachments}
            <input
              bind:this={fileInputRef}
              id={`${id}-file-picker`}
              type="file"
              accept={acceptedTypes.join(',')}
              multiple
              class="cinder-sr-only"
              onchange={handleFileSelect}
              aria-label={labels.attachFiles}
              aria-hidden="true"
              tabindex={-1}
            />
            <Button
              type="button"
              variant="ghost"
              size="sm"
              quiet
              iconOnly
              class="chat-input-attach"
              label={labels.attachFile}
              onclick={() => fileInputRef?.click()}
              disabled={disabled || paused || sendBlocked}
              aria-label={labels.attachFile}
            >
              <Paperclip class="cinder-icon-sm" />
            </Button>
          {/if}

          {#if toolbar}
            {@render toolbar(toolbarContext)}
          {/if}
          {#if controls}
            {@render controls(controlsContext)}
          {/if}

          {#if runElapsed !== undefined}
            <!-- The run toolbar: the word and the clock are their own elements, never joined by a
                 separator glyph. -->
            <span
              class={showStopButton || showSideStopButton ? 'cinder-sr-only' : 'chat-input-running'}
              data-chat-running=""
              aria-live="polite"
            >
              <span class="chat-input-running-label">{COMPOSER_RUNNING_LABEL}</span>
              <span class="chat-input-running-time">{runElapsed}</span>
            </span>
          {/if}

          <!-- Visually hidden shortcut description: always in the accessibility tree even when hint is container-queried away -->
          <span id={shortcutDescriptionId} class="cinder-sr-only">
            {#if showStopButton && !allowFollowUp}
              Response is streaming. Use the stop button to stop generation.
            {:else if showStopButton || showSideStopButton}
              Response is streaming. {followUpInstruction} Use the stop button to stop generation.
            {:else if submitOn === 'modifier-enter'}
              Press Command+Enter or Control+Enter to send. Press Enter for a newline.
            {:else if submitOn === 'enter-if-single-line' && value.includes('\n')}
              This message has multiple lines. Use the send button to send it. Press Enter for a
              newline.
            {:else if submitOn === 'enter-if-single-line'}
              Press Enter to send a single-line message. Press Shift+Enter for a newline.
            {:else}
              Press Enter to send. Press Shift+Enter for a newline.
            {/if}
          </span>
        </div>

        <div class="chat-input-footer-right">
          {#if actions}
            {@render actions()}
          {/if}

          {#if showSideStopButton}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              class="chat-input-send"
              iconOnly
              data-chat-side-stop=""
              data-stop=""
              {@attach holdButton((element) => (stopButtonRef = element))}
              label={labels.stop}
              aria-label={labels.stopGenerating}
              aria-describedby={shortcutDescriptionId}
              onclick={() => onstop?.()}
            >
              {#snippet leadingIcon()}<Square class="cinder-icon-sm" />{/snippet}
            </Button>
            <Tooltip
              text={labels.stopGenerating}
              class="chat-input-tooltip"
              placement="top"
              triggerRef={stopButtonRef}
            />
          {/if}

          {#if shownPausedReason !== undefined}
            <span id={pausedReasonId} class="chat-input-paused-reason">{shownPausedReason}</span>
          {/if}
          {#if queued && queueNote !== undefined}
            <span id={queueNoteId} class="cinder-sr-only">{queueNote}</span>
          {/if}

          <!-- One Send/Stop/Answer button stays mounted, so focus is never dropped as the run starts and ends. -->
          <Button
            type={showStopButton ? 'button' : 'submit'}
            variant={sendVariant}
            size="sm"
            class="chat-input-send"
            data-chat-send=""
            {@attach holdButton((element) => (sendButtonRef = element))}
            data-stop={showStopButton ? '' : undefined}
            disabled={showStopButton ? false : !canSubmit}
            {...sendButtonIconOnly ? { iconOnly: true as const } : { iconOnly: false as const }}
            label={showStopButton ? labels.stop : sendLabel}
            aria-label={sendAccessibleName}
            aria-describedby={[shortcutDescriptionId, ...sendReasonIds].join(' ')}
            onclick={handleSendButtonClick}
          >
            {#snippet leadingIcon()}
              {#if showStopButton}
                <Square class="cinder-icon-sm" />
              {:else if showSendingSpinner}
                <svg
                  class="chat-input-spinner"
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  aria-hidden="true"
                >
                  <circle
                    class="spinner-track"
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    stroke-width="4"
                  ></circle>
                  <path
                    class="spinner-head"
                    fill="currentColor"
                    d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                  ></path>
                </svg>
              {:else if queued}
                <ListOrdered class="cinder-icon-sm" data-chat-queue-icon="" />
              {:else}
                <SendHorizontal class="cinder-icon-sm" />
              {/if}
            {/snippet}
          </Button>
          <Tooltip
            text={sendTooltipText}
            class="chat-input-tooltip"
            placement="top"
            triggerRef={sendButtonRef}
          />
        </div>
      </div>

      <!-- Error display -->
      {#if error}
        <p id={errorId} class="chat-input-error" role="alert">
          {error}
        </p>
      {/if}
    </form>
  {/if}
  {#if blocked === undefined && notice === undefined}
    {#if statusText && drawerStatus === undefined}
      <p class="chat-input-status" data-chat-composer-status={status?.kind}>{statusText}</p>
    {:else if hintText !== undefined && status?.kind !== 'reconnecting'}
      <p class="chat-input-hint" aria-hidden="true" data-chat-keyboard-hint={keyboardHint}>
        {hintText}
      </p>
    {/if}
  {/if}
  <!-- Screen reader announcements -->
  <div aria-live="polite" aria-atomic="true" class="cinder-sr-only">
    {announcer.message}
  </div>
</div>

{#snippet noticeAction(action: ChatComposerBlockedAction, variant: 'primary' | 'secondary')}
  {#if action.href !== undefined}
    <Button {variant} size="sm" href={action.href} label={action.label} onclick={action.onclick} />
  {:else}
    <Button type="button" {variant} size="sm" label={action.label} onclick={action.onclick} />
  {/if}
{/snippet}

<style>
  /* Compact: the field and Send (or Stop) are one row, with no controls beside them. */
  .chat-input[data-compact] {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--cinder-space-0-5, 0.125rem);
    padding: var(--cinder-space-2) var(--cinder-space-2) var(--cinder-space-2) 0;
  }

  .chat-input[data-compact] .chat-input-footer,
  .chat-input[data-compact] .chat-input-footer-right {
    display: contents;
  }

  .chat-input[data-compact] .chat-input-footer-left,
  .chat-input[data-compact] :global(.chat-input-send svg) {
    display: none;
  }

  /* One layout in every state: with nothing in the toolbar but Send, the editor and Send share one
   * row. A second row appears only when the toolbar holds more than Send; a wrapped line grows
   * the editor inside the same row. */
  .chat-input[data-single-row]:not([data-compact]) {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    padding-inline-end: var(--cinder-space-2);
  }

  .chat-input[data-single-row]:not([data-compact]) .chat-input-editor-container {
    grid-column: 1;
    grid-row: 1;
  }

  .chat-input[data-single-row]:not([data-compact]) .chat-input-footer {
    display: contents;
  }

  .chat-input[data-single-row]:not([data-compact]) .chat-input-footer-left {
    display: none;
  }

  .chat-input[data-single-row]:not([data-compact]) .chat-input-footer-right {
    grid-column: 2;
    grid-row: 1;
  }

  .chat-input {
    position: relative;
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-0-5, 0.125rem);
    background: var(--cinder-control-background);
    border: 1px solid var(--cinder-control-border);
    border-radius: var(--cinder-radius-lg);
    padding: var(--cinder-space-0-5, 0.125rem) 0;
    padding-block-end: var(--cinder-space-0-5, 0.125rem);
    transition: border-color var(--cinder-duration-fast) var(--cinder-ease-standard);
  }

  .chat-input:has(.chat-input-editor:focus) {
    border-color: var(--cinder-accent-solid);
  }

  .chat-input:has(.chat-input-editor:focus):not([data-ready]) {
    box-shadow: inset 0 0 0 var(--cinder-ring-width) var(--cinder-ring-color);
  }

  /* Ready to send: the accent border with a 3 px ring around it, and Send filled with the accent. */
  .chat-input[data-ready] {
    border-color: var(--cinder-accent-solid);
    box-shadow: 0 0 0 3px color-mix(in oklch, var(--cinder-accent-solid) 25%, transparent);
  }

  /* A notice above the box (offline, a restored draft, a blocking reason) is Cinder's Callout, one
   * layout for every tone. It starts on the composer's left edge and takes its height from the
   * transcript above, so the composer's bottom edge stays where it was. */
  :global(.chat-input-drawer) {
    padding-inline: var(--cinder-space-3);
    font-size: var(--cinder-text-sm);
  }

  :global(.chat-input-drawer .chat-input-drawer-glyph) {
    flex: none;
  }

  /* The run toolbar: Running and the clock, each its own element, in muted text. */
  .chat-input-running {
    display: inline-flex;
    flex: none;
    align-items: baseline;
    gap: var(--cinder-space-1-5);
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-muted);
    white-space: nowrap;
  }

  .chat-input-running-time {
    font-variant-numeric: tabular-nums;
  }

  .chat-input-dragover {
    border-style: dashed;
    border-color: var(--cinder-accent-solid);
    background: color-mix(in oklch, var(--cinder-accent-solid), transparent 95%);
  }

  .chat-input-drop-overlay {
    position: absolute;
    z-index: 1;
    inset: var(--cinder-space-2);
    display: grid;
    place-content: center;
    justify-items: center;
    gap: var(--cinder-space-2);
    border: 2px dashed var(--cinder-accent-solid);
    border-radius: calc(var(--cinder-radius-lg) - var(--cinder-space-1));
    background: color-mix(in oklch, var(--cinder-surface-raised), transparent 8%);
    color: var(--cinder-text-default);
    font-size: var(--_cinder-chat-text-sm, var(--cinder-text-sm));
    font-weight: var(--cinder-font-medium);
    pointer-events: none;
  }

  /* Attachments: one strip of chips above the text field. It scrolls sideways when they do not fit,
   * and a chip cut by the trailing edge is the only sign that there are more, so it has no
   * scrollbar. A failure that blocks Send says what happened in one line under it. */
  .chat-input-attachment-strip {
    display: flex;
    flex-direction: column;
    /* The notice sits as far under the chips as the editor does: the composer's own gap. */
    gap: var(--cinder-space-0-5, 0.125rem);
    min-inline-size: 0;
    padding-inline: var(--cinder-space-3);
  }

  .chat-input-attachments {
    display: flex;
    flex-flow: row nowrap;
    align-items: center;
    gap: var(--cinder-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
    overflow-x: auto;
    overscroll-behavior-inline: contain;
    scrollbar-width: none;
    /* Where chips are hidden past an edge that edge fades (Cinder's `scrollEdgeFade`), and a chip
     * scrolled to an edge stops clear of the fade, so its remove control is neither clipped nor
     * dimmed. */
  }

  .chat-input-attachments::-webkit-scrollbar {
    display: none;
  }

  /* A scroller clips on both axes, and a coarse pointer's remove control and chip reach 44px by a
   * hit area that overhangs their 28px chip. The strip pads by that overhang so the hit area is not
   * clipped. The room above is taken back with a negative margin, so it costs no layout; the room
   * below stays, so no hit area lies over the editor's own 44px row. The padding answers no tap
   * itself, only a chip does. */
  @media (any-pointer: coarse) {
    .chat-input-attachments {
      box-sizing: border-box;
      padding-block: var(--cinder-space-2);
      margin-block-start: calc(var(--cinder-space-2) * -1);
      padding-inline-end: var(--cinder-space-2);
      pointer-events: none;
    }

    .chat-input-attachment-wrapper {
      pointer-events: auto;
    }

    /* The line's action reaches 44px by a hit area that overhangs it, over the chips above, so the
     * line paints above them and the action keeps every tap on it. The line's words answer no tap,
     * so the hit areas of the chips above reach under them. */
    :global(.chat-input-attachment-reason) {
      position: relative;
      z-index: 1;
      pointer-events: none;
    }

    :global(.chat-input-attachment-reason .chat-input-attachment-reason-action) {
      pointer-events: auto;
    }
  }

  .chat-input-attachment-wrapper {
    display: flex;
    flex: none;
    min-inline-size: 0;
    /* A chip is never wider than 14rem or 70% of the strip, whichever is less (owner, 2026-11-13):
     * a long name ellipsizes sooner, and at least a third of the next chip shows at the edge to
     * say there are more. */
    max-inline-size: min(70%, 14rem);
  }

  /* The failure is Cinder's danger Callout: its box, glyph, tone and action slot are the notice's
   * own. Only the file's name is Chat's: a thing, not prose, so it takes the chip's own face (body
   * colour, medium weight, a quiet fill), stays whole on one line, and shortens to an ellipsis
   * only when it is wider than the notice itself. */
  .chat-input-attachment-reason-name {
    display: inline-block;
    max-inline-size: 100%;
    overflow: hidden;
    box-sizing: border-box;
    padding-inline: var(--cinder-space-1);
    border-radius: var(--cinder-radius-sm);
    background: var(--cinder-surface-inset);
    color: var(--cinder-text-default);
    font-weight: var(--cinder-font-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
    /* An inline block that clips takes its bottom edge as its baseline; this puts its text back on
     * the sentence's line. */
    vertical-align: bottom;
  }

  /* Editor container */
  .chat-input-editor-container {
    --_chat-input-row-height: var(--_cinder-painted-height-sm, 1.75rem);
    min-block-size: var(--_chat-input-row-height);
  }

  /* A textarea cannot carry a hit-area pseudo-element, so on a coarse pointer the editor row itself
   * is a touch target tall. Block padding keeps one line on the centre line Send and Stop share,
   * because the markdown overlay and the editor both derive their padding from this height. */
  @media (any-pointer: coarse) {
    .chat-input-editor-container {
      --_chat-input-row-height: var(--cinder-touch-target-min, 44px);
    }

    /* iOS zooms the page when a focused field's text is under 16px, so on a touch screen the
     * editor and the overlay that mirrors it never go below that, whatever the chat's base size. */
    .chat-input-editor-container .chat-input-editor,
    .chat-input-editor-container .chat-input-markdown {
      font-size: max(1rem, var(--cinder-text-base));
    }
  }

  /* The first line shares a centre with Send or Stop: the editor is as tall as that button and its
   * block padding centres one line in it. */
  .chat-input-editor {
    display: block;
    width: 100%;
    min-block-size: var(--_chat-input-row-height);
    max-height: min(12rem, 35dvh);
    padding-block: calc((var(--_chat-input-row-height) - 1lh) / 2);
    padding-inline: var(--cinder-space-3);
    resize: none;
    field-sizing: content;
    overflow-y: auto;
    font: inherit;
    font-size: var(--cinder-text-base);
    line-height: var(--cinder-leading-normal);
    color: var(--cinder-text-default);
    background: transparent;
    border: none;
    border-radius: 0;
  }

  .chat-input-editor::placeholder {
    color: var(--cinder-text-subtle);
  }

  /* Markdown styling: the textarea keeps the text and the caret but draws no
   * glyphs; a backdrop with the same metrics draws them, styled. Nothing in the
   * backdrop may change a glyph's width, so strong text is a faux bold and code
   * keeps the composer's font. */
  .chat-input-editor-container {
    position: relative;
  }

  /* Both layers reserve the same scrollbar gutter, so a classic scrollbar on
   * a long draft narrows them alike and they wrap at the same places. */
  .chat-input-editor-styled,
  .chat-input-markdown {
    scrollbar-gutter: stable;
  }

  .chat-input-editor-styled {
    position: relative;
    color: transparent;
    caret-color: var(--cinder-text-default);
  }

  /* Stay transparent when disabled, too; the backdrop dims instead. */
  .chat-input-editor-styled:is(:read-only, :disabled) {
    color: transparent;
  }

  .chat-input-markdown:has(~ .chat-input-editor-styled:is(:read-only, :disabled)) {
    color: var(--cinder-text-muted);
  }

  .chat-input-editor-styled::selection {
    color: transparent;
    background: color-mix(in oklch, var(--cinder-accent-solid) 25%, transparent);
  }

  .chat-input-markdown {
    position: absolute;
    inset: 0;
    overflow: hidden;
    padding-block: calc((var(--_chat-input-row-height) - 1lh) / 2);
    padding-inline: var(--cinder-space-3);
    font: inherit;
    font-size: var(--cinder-text-base);
    line-height: var(--cinder-leading-normal);
    color: var(--cinder-text-default);
    white-space: pre-wrap;
    overflow-wrap: break-word;
    pointer-events: none;
  }

  .chat-input-markdown-marker,
  .chat-input-markdown-list-marker {
    color: var(--cinder-text-subtle);
  }

  .chat-input-markdown-strong {
    text-shadow: 0.35px 0 0 currentColor;
  }

  .chat-input-markdown-emphasis {
    font-style: italic;
  }

  .chat-input-markdown-code {
    border-radius: var(--cinder-radius-sm);
    background: var(--cinder-surface-inset);
  }

  .chat-input-markdown-link {
    color: var(--cinder-accent-text);
    text-decoration: underline;
  }

  /* The top row inside the border: the host's control for who the message goes to. */
  .chat-input-header {
    display: flex;
    align-items: center;
    min-inline-size: 0;
    margin-inline-start: 0;
  }

  /* The formatting row: the toolbar at the left, the words of its shortcuts at the right. It is
   * there only while the composer has been focused at its box, so an idle composer stays quiet. */
  .chat-input-format {
    display: none;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-3);
    padding-inline: var(--cinder-space-2) var(--cinder-space-3);
    padding-block-end: var(--cinder-space-1);
    border-block-end: 1px solid var(--cinder-border-muted);
  }

  .chat-input[data-formatting-open] .chat-input-format {
    display: flex;
  }

  .chat-input-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    margin-inline-start: calc(var(--cinder-space-2) * -1);
  }

  .chat-input-format-hint {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0 var(--cinder-space-3);
    min-inline-size: 0;
    margin: 0;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-muted);
  }

  /* Too narrow for the shortcuts' words: the buttons carry them in their names. */
  @container (max-inline-size: 30rem) {
    .chat-input-format-hint {
      display: none;
    }
  }

  .chat-input-shell {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-inline-size: 0;
  }

  /* The line under the box: a status reads from the box's left edge, the hint is centred. */
  /* The reason may wrap on a narrow composer, so it never pushes Send past the composer's edge. */
  .chat-input-paused-reason {
    min-width: 0;
    font-size: var(--cinder-text-xs);
    line-height: 1.3;
    text-align: end;
    color: var(--cinder-text-muted);
  }

  .chat-input-status,
  .chat-input-hint {
    margin: 0;
    padding-inline: var(--cinder-space-1);
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-muted);
  }

  .chat-input-hint {
    text-align: center;
  }

  /* The default keyboard reminder is available through the send button's accessible description;
   * keep the composer footer focused on the draft and controls. Host-provided hints remain visible. */
  .chat-input-hint[data-chat-keyboard-hint] {
    display: none;
  }

  /* A touch-only device has no keys to press: the default keyboard hint and the shortcuts' words are
   * not drawn there. A host's own hint is its own words and stays. */
  @media (hover: none) and (pointer: coarse) {
    .chat-input-format-hint {
      display: none;
    }
  }

  /* The blocked row: one compact row the height of the control row, in place of the composer. */
  .chat-input-blocked {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--cinder-space-2) var(--cinder-space-3);
    padding-block: var(--cinder-space-2);
    padding-inline: var(--cinder-space-3);
  }

  .chat-input-blocked:focus-within {
    border-color: var(--cinder-control-border);
  }

  /* The glyph and the reason are one unit: the reason wraps beside the glyph, never under it, and
   * only the actions leave for a line of their own. */
  .chat-input-blocked-message {
    display: flex;
    flex: 1 1 6rem;
    align-items: flex-start;
    gap: var(--cinder-space-2);
    min-inline-size: 0;
    /* The words' size is set on the row, so the glyph measures one line of the same text. */
    font-size: var(--cinder-text-sm);
  }

  /* The glyph is centred on the first line of the words beside it: its offset is half of what one
   * line (of the words' own size, set on the row) has over the 16px glyph, never a tuned number. */
  .chat-input-blocked :global(.chat-input-blocked-glyph) {
    flex: none;
    margin-block-start: calc((1lh - 1rem) / 2);
    color: var(--cinder-status-warning-text);
  }

  .chat-input-blocked-reason {
    flex: 1 1 auto;
    min-inline-size: 0;
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }

  /* The neutral bar of an archived or read-only chat: the blocked row's layout with no warning
   * colour, the words in the body colour and the secondary action before the primary one. */
  .chat-input-notice :global(.chat-input-notice-glyph) {
    flex: none;
    margin-block-start: calc((1lh - 1rem) / 2);
    color: var(--cinder-text-muted);
  }

  .chat-input-notice .chat-input-blocked-reason {
    color: var(--cinder-text-default);
  }

  /* Archived/read-only status is a single neutral bar: keep the lock and its words together at
   * the logical start, and keep the request action at the logical end. The compact faces still
   * retain their coarse-pointer hit height without forcing a second full-width action row. */
  .chat-input-notice {
    flex-wrap: wrap;
  }

  /* The words break between words only, and the glyph with its words is never narrower than its
   * longest word, so the words are never squeezed under the actions: when the two do not fit on one
   * row the actions drop to a row of their own at the trailing edge. */
  .chat-input-notice .chat-input-blocked-message {
    flex: 1 1 0;
    min-inline-size: min-content;
  }

  .chat-input-notice .chat-input-blocked-reason {
    overflow-wrap: normal;
    word-break: normal;
    min-inline-size: min-content;
  }

  /* "Archived Nov 3" is short and reads on one line: the words ask for their whole width, so the
   * actions leave for their own row as soon as the two do not fit together, and the date (held
   * together with non-breaking spaces) is never cut. */
  .chat-input-notice[data-chat-composer-status='archived'] .chat-input-blocked-message {
    flex-basis: auto;
  }

  .chat-input-notice .chat-input-blocked-actions {
    flex: none;
  }

  .chat-input-notice-label {
    display: inline-flex;
    align-items: center;
    min-block-size: 1.5rem;
    margin: 0;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-decoration: underline dotted;
    text-underline-offset: 0.2em;
    cursor: help;
  }

  /* The label paints 24px tall; on a coarse pointer a pseudo-element that takes no layout lifts its
   * hit area to 44px, so a tap that shows who granted access lands on it and not on the bar. */
  @media (any-pointer: coarse) {
    .chat-input-notice-label {
      position: relative;
    }

    .chat-input-notice-label::before {
      content: '';
      position: absolute;
      inset-block: min(0px, calc((100% - var(--cinder-touch-target-min, 44px)) / 2));
      inset-inline: 0;
    }
  }

  .chat-input-blocked-actions {
    display: flex;
    flex: none;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--cinder-space-2);
    margin-inline-start: auto;
  }

  /* On a phone the actions drop to a line of their own that ends at the trailing edge, as compact
   * touch targets (rows 05a, 06m, 24x), never equal or full width, instead of overlapping the
   * reason. A tablet's conversation pane is as narrow as a phone's screen, so it is the screen
   * that decides, not the pane: there the reason wraps and the action stays at the trailing end
   * (row 06n). */
  @media (max-width: 639.98px) {
    .chat-input-blocked-actions {
      flex: 1 0 100%;
    }

    .chat-input-blocked-actions :global(.cinder-button) {
      flex: 0 0 auto;
    }

    .chat-input-notice .chat-input-blocked-actions {
      flex: none;
    }
  }

  .chat-input-editor:focus {
    outline: none;
  }

  .chat-input-editor:read-only,
  .chat-input-editor:disabled {
    color: var(--cinder-text-muted);
    cursor: not-allowed;
  }

  /* Footer */
  .chat-input-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-2);
    padding-inline: var(--cinder-space-2);
    /* The two-row composer's action row stands as far from the bottom border as from the sides:
     * the composer's own 2px block padding plus this makes the inline inset. */
    padding-block-end: calc(var(--cinder-space-2) - var(--cinder-space-0-5, 0.125rem));
  }

  .chat-input-footer-left,
  .chat-input-footer-right {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-2);
  }

  /* Attach is a 28px rounded square, like the message actions, sitting inside the footer's inset
   * (at least 4px from the composer's edge), with the same quiet ring as they have. */
  .chat-input-footer-left :global(.chat-input-attach) {
    inline-size: 1.75rem;
    block-size: 1.75rem;
    min-inline-size: 0;
    min-block-size: 0;
    padding: 0;
    border-radius: var(--cinder-radius-sm);
  }

  .chat-input-footer-left :global(.chat-input-attach:focus-visible) {
    outline: var(--cinder-ring-width) solid transparent;
    box-shadow: var(--_cinder-focus-ring-shadow);
  }

  /* The row never wraps: the host's selects shrink (a ghost select ellipsizes its value) or fold
   * into one Settings control (`controls` is told when) before anything drops to a second line. */
  .chat-input-footer-left {
    flex: 1 1 auto;
    flex-wrap: nowrap;
    min-inline-size: 0;
  }

  .chat-input-footer-right {
    flex: none;
  }

  /* Send, Queue, Answer and Stop are compact Cinder buttons. Their labels remain available to
   * assistive technology and the tooltip names the icon-only face. On coarse pointers the tooltip
   * remains available from keyboard focus; suppressing its panel would leave the focused Stop
   * control without the visual name the touch review requires. */
  /* Stop is neutral and outlined, with a filled square icon. */
  .chat-input-footer-right :global(.chat-input-send[data-stop] svg) {
    fill: currentColor;
  }

  .chat-input-footer-right :global(.chat-input-send[data-stop]) {
    border-color: var(--cinder-control-border);
  }

  /* An empty composer's Send is outlined and muted, with no grey fill. */
  .chat-input-footer-right :global(.chat-input-send:disabled) {
    border-color: var(--cinder-control-border);
    background: transparent;
    color: var(--cinder-text-muted);
  }

  /* The footer's controls are painted compact: Cinder's Button reaches 44px by a hit area that
   * takes no layout, and its focus ring wraps the painted face (Attach, Send, Stop alike). */
  @media (any-pointer: coarse) {
    /* Send and Stop sit side by side once a follow-up is typed, so their hit areas must not touch. */
    .chat-input-footer-right {
      gap: var(--cinder-space-3);
    }
  }

  /* Spinner */
  .chat-input-spinner {
    width: 1rem;
    height: 1rem;
    animation: spin 1s linear infinite;
  }

  .spinner-track {
    opacity: 0.25;
  }

  .spinner-head {
    opacity: 0.75;
  }

  .chat-input-error {
    margin: 0;
    padding-inline: var(--cinder-space-3);
    font-size: var(--_cinder-chat-text-xs, var(--cinder-text-xs));
    color: var(--cinder-status-danger-text);
  }
</style>
