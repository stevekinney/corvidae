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
    ATTACHMENT_LIST_CAP,
    attachmentViewportCap,
    typeNotAcceptedText,
    attachmentCountText,
    canRetry,
    needsAttention,
  } from './attachment-tile.ts';
  import { hiddenRowCounts, wholeRowsBlockSize, type RowEdges } from '../whole-rows.ts';
  import ChatAttachmentPreview from './chat-attachment-preview.svelte';

  /** The files still out of sight below an opened list, for the "N more" line under it. */
  let hiddenListedAttachments = $state(0);

  /**
   * Sizes an opened attachment list to whole rows plus their gaps, so it ends on a row and no part
   * of the next one shows; the "N more" line under it says how many remain. The list's block
   * padding is the room for its end rows' hit-area overhang; the matching negative margin keeps it
   * out of the layout, so the header-to-first-row and last-row-to-hint distances equal the
   * collapsed shelf's.
   */
  function wholeAttachmentRows(node: HTMLElement): () => void {
    const edgesOf = (): RowEdges[] => {
      const nodeTop = node.getBoundingClientRect().top;
      return [...node.querySelectorAll<HTMLElement>(':scope > li')].map((row) => {
        const box = row.getBoundingClientRect();
        const top = box.top - nodeTop + node.scrollTop;
        return { top, bottom: top + box.height };
      });
    };
    const count = (): void => {
      hiddenListedAttachments = node.hasAttribute('data-expanded')
        ? hiddenRowCounts(edgesOf(), node.scrollTop, node.clientHeight).below
        : 0;
    };
    const fit = (): void => {
      // Growing the list to measure it and shrinking it again clamps its scroll offset twice, which
      // would move a list the person (or a focus move) has scrolled; the offset is put back.
      const scrollTop = node.scrollTop;
      measure();
      node.scrollTop = scrollTop;
      count();
    };
    const measure = (): void => {
      node.style.removeProperty('max-block-size');
      if (!node.hasAttribute('data-expanded')) return;
      const paddingEnd = Number.parseFloat(getComputedStyle(node).paddingBlockEnd) || 0;
      const blockSize = wholeRowsBlockSize(edgesOf(), node.clientHeight, paddingEnd);
      if (blockSize !== undefined) node.style.setProperty('max-block-size', `${blockSize}px`);
    };

    let frame = 0;
    const schedule = (): void => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        fit();
      });
    };
    const resize = typeof ResizeObserver === 'undefined' ? undefined : new ResizeObserver(schedule);
    resize?.observe(node);
    const mutations =
      typeof MutationObserver === 'undefined' ? undefined : new MutationObserver(schedule);
    // Only the open state is watched as an attribute: this function writes `style` itself.
    mutations?.observe(node, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['data-expanded'],
    });
    node.addEventListener('scroll', count, { passive: true });
    fit();
    return () => {
      cancelAnimationFrame(frame);
      resize?.disconnect();
      mutations?.disconnect();
      node.removeEventListener('scroll', count);
    };
  }

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
  // A long list is capped: the first tiles show, the last of them fades, and a count under the list
  // shows the rest. The list itself scrolls once it is open, so Send stays in the pane.
  let attachmentsExpanded = $state(false);
  let visibleAttachmentCap = $state(ATTACHMENT_LIST_CAP);
  $effect(() => {
    if (attachments.length <= ATTACHMENT_LIST_CAP) attachmentsExpanded = false;
  });
  const shownAttachments = $derived(
    attachmentsExpanded
      ? attachments
      : attachments
          .toSorted((left, right) => Number(needsAttention(right)) - Number(needsAttention(left)))
          .slice(0, visibleAttachmentCap),
  );
  const hiddenAttachmentCount = $derived(attachments.length - shownAttachments.length);
  $effect(() => {
    if (typeof window === 'undefined') return;
    const updateViewportCap = (): void => {
      if (window.innerWidth <= 0 || window.innerHeight <= 0) return;
      visibleAttachmentCap = attachmentViewportCap(window.innerWidth, window.innerHeight);
    };
    updateViewportCap();
    window.addEventListener('resize', updateViewportCap);
    return () => window.removeEventListener('resize', updateViewportCap);
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
    if (attentionCount > 0) return labels.attachmentBlockingReason(attentionCount);
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

  /** `attachment` as an `error` row: its upload reference is dropped, so it can never be sent. */
  function refused(attachment: ChatAttachment, message: string): ChatAttachment {
    const { reference: _reference, progress: _progress, ...others } = attachment;
    return { ...others, status: 'error', error: message };
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
          entry.id === attachment.id ? refused(entry, message) : entry,
        );
        onAttachmentFailure?.(attachment.file, message);
        announcer.announce(`${attachment.file.name} was not attached: ${message}`);
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
          },
        ];
        announcer.announce(`${file.name} was not attached: ${message}`);
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
              ? { ...a, status: 'error' as const, error: 'Failed to read file' }
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
        settle({ status: 'error', error: message, retryable: true });
        announcer.announce(`${attachment.file.name} could not be uploaded: ${message}`);
      } finally {
        uploadControllers.delete(attachment.id);
      }
    })();
  }

  /** Uploads a failed attachment again, as it was first uploaded. */
  function retryAttachment(attachmentId: string): void {
    const upload = uploadAttachment;
    const attachment = attachments.find((entry) => entry.id === attachmentId);
    if (upload === undefined || attachment === undefined || !canRetry(attachment)) return;
    const {
      error: _error,
      progress: _progress,
      retryable: _retryable,
      reference: _reference,
      ...others
    } = attachment;
    const retrying: ChatAttachment = { ...others, status: 'uploading' };
    attachments = attachments.map((entry) => (entry.id === attachmentId ? retrying : entry));
    announcer.announce(`Retrying ${attachment.file.name}`);
    startUpload(retrying, upload);
  }

  function abortUploads(ids?: readonly string[]): void {
    for (const [attachmentId, controller] of uploadControllers) {
      if (ids === undefined || ids.includes(attachmentId)) controller.abort();
    }
  }

  function removeAttachment(attachmentId: string): void {
    const attachment = attachments.find((a) => a.id === attachmentId);
    if (attachment) {
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

      <!-- Attachments: a count over a tile each. A failed file says why beside its tile, with Retry
           when its upload can be tried again, and every tile is removed with the same cross. -->
      {#if attachments.length > 0}
        <div class="chat-input-attachment-shelf">
          <p class="chat-input-attachment-summary" data-chat-attachment-summary="">
            <span class="chat-input-attachment-count"
              >{attachmentCountText(attachments.length)}</span
            >
            {#if hiddenAttachmentCount > 0}
              <Button
                type="button"
                variant="ghost-accent"
                size="xs"
                quiet
                class="chat-input-attachment-more"
                aria-controls={attachmentListId}
                aria-expanded="false"
                onclick={() => (attachmentsExpanded = true)}
              >
                {labels.moreAttachments(hiddenAttachmentCount)}
              </Button>
            {/if}
          </p>
          <ul
            id={attachmentListId}
            class="chat-input-attachments"
            {@attach wholeAttachmentRows}
            aria-label={labels.attachedFiles}
            data-expanded={attachmentsExpanded || undefined}
          >
            {#each shownAttachments as attachment (attachment.id)}
              <li
                class="chat-input-attachment-wrapper"
                data-attachment-state={attachment.status}
                data-attachment-id={attachment.id}
              >
                <ChatAttachmentPreview
                  {attachment}
                  error={attachment.error}
                  errorId={attachment.id}
                  {labels}
                >
                  {#snippet action()}
                    {#if canRetry(attachment) && uploadAttachment !== undefined}
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        quiet
                        iconOnly
                        class="chat-input-attachment-retry"
                        label={labels.retryAttachment}
                        aria-label={labels.retryAttachmentAccessible(attachment.file.name)}
                        onclick={() => retryAttachment(attachment.id)}
                      >
                        <RotateCcw class="cinder-icon-xs" aria-hidden="true" />
                      </Button>
                    {/if}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
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
          {#if attachmentsExpanded && hiddenListedAttachments > 0}
            <p class="chat-input-attachment-scroll-cue" aria-hidden="true">
              {labels.moreAttachments(hiddenListedAttachments)}
            </p>
          {/if}
          {#if attentionCount > 0}
            <p id={attachmentReasonId} class="chat-input-attachment-reason">
              {labels.attachmentBlockingReason(attentionCount)}
            </p>
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

  /* Attachments: a count, then a tile a row. A file that failed shows its reason beside its tile. */
  .chat-input-attachment-shelf {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    padding-inline: var(--cinder-space-3);
  }

  .chat-input-attachment-summary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0 var(--cinder-space-2);
    margin: 0;
    /* The header of a bordered box: the same inset and minimum height with or without a trailing
     * control, so "5 files" and "5 files + more" are one height. */
    padding-block: var(--cinder-space-2);
    min-block-size: 1.5rem;
    box-sizing: content-box;
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-muted);
    text-align: start;
  }

  /* A capped list shows exactly its first tiles, each whole with its reason, and the count under it
   * says how many more there are. Only the whole list, once opened, is bounded and scrolls, so a
   * pile of files keeps Send in the pane (C#4). */
  .chat-input-attachments {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--cinder-space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .chat-input-attachments[data-expanded] {
    max-block-size: 12rem;
    overflow-y: auto;
    scrollbar-gutter: stable;
    scrollbar-width: thin;
    scrollbar-color: var(--cinder-scrollbar-thumb) var(--cinder-scrollbar-track);
  }

  /* The count of files still below an opened list, at the start edge like the question dock's. */
  .chat-input-attachment-scroll-cue {
    margin: 0;
    font-size: var(--cinder-text-xs);
    line-height: var(--cinder-leading-tight, 1.25);
    color: var(--cinder-text-muted);
    text-align: start;
  }

  /* A row's Remove or Retry reaches 44px by a hit area that overhangs its row. A later row paints
   * over an earlier one's overhang, and the scrolling list clips the first and last, so on a
   * coarse pointer the rows stand a hit-area overhang apart and the list pads its ends. */
  @media (any-pointer: coarse) {
    .chat-input-attachments {
      gap: var(--cinder-space-2);
    }

    /* The end rows' overhang room is padding the list takes back with a negative margin, so it
     * costs no layout: the header and the hint stand where the collapsed shelf puts them. */
    .chat-input-attachments[data-expanded] {
      box-sizing: border-box;
      padding-block: var(--cinder-space-2);
      margin-block: calc(var(--cinder-space-2) * -1);
      /* A row scrolled to either edge stops one padding short of it, so its Remove or Retry hit
       * area is not clipped there either. */
      scroll-padding-block: var(--cinder-space-2);
    }
  }

  .chat-input-attachments[data-expanded]::-webkit-scrollbar {
    inline-size: var(--cinder-scrollbar-size);
  }

  .chat-input-attachments[data-expanded]::-webkit-scrollbar-track {
    background: var(--cinder-scrollbar-track);
  }

  .chat-input-attachments[data-expanded]::-webkit-scrollbar-thumb {
    background: var(--cinder-scrollbar-thumb);
    border-radius: var(--cinder-radius-full);
  }

  /* On a phone each file is a row the width of the composer. Its name stays on one line: the
   * script has already shortened it in the middle to fit that line, so the extension shows and the
   * person can tell which file failed. A name allowed to wrap would, on any overshoot (a font that
   * loads late, a fraction of a pixel), take a second line and move the row's controls. */
  @container (max-inline-size: 30rem) {
    .chat-input-attachments {
      align-items: stretch;
    }

    .chat-input-attachment-wrapper > :global(.chat-attachment-preview) {
      flex: 1 1 auto;
    }

    .chat-input-attachment-wrapper :global(.chat-attachment-preview-name) {
      display: block;
      flex: 1 1 0;
      white-space: nowrap;
    }

    .chat-input-attachment-wrapper :global(.chat-attachment-preview-stem) {
      overflow: visible;
    }

    .chat-input-attachment-wrapper :global(.chat-attachment-preview-error) {
      order: 3;
    }

    .chat-input-attachment-wrapper :global(.chat-input-attachment-retry),
    .chat-input-attachment-wrapper :global(.chat-input-attachment-remove) {
      order: 2;
    }
  }

  .chat-input-attachment-summary :global(.chat-input-attachment-more) {
    align-self: center;
  }

  /* Why Send is off while files need attention, under the composer. */
  .chat-input-attachment-reason {
    margin: 0;
    /* The shelf's own inline padding already puts this on the placeholder's edge. */
    font-size: var(--cinder-text-xs);
    color: var(--cinder-status-danger-text);
  }

  .chat-input-attachment-wrapper {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0;
    min-inline-size: 0;
    inline-size: 100%;
    max-inline-size: 100%;
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
  }

  .chat-input-blocked :global(.chat-input-blocked-glyph) {
    flex: none;
    margin-block-start: 0.1875rem;
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
    margin-block-start: 0.1875rem;
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

  /* The words break between words only: the reason takes what the actions leave, never narrower
   * than its longest word, and the actions drop to their own line before it would. */
  .chat-input-notice .chat-input-blocked-message {
    flex: 1 1 0;
    align-items: center;
  }

  .chat-input-notice .chat-input-blocked-reason {
    overflow-wrap: normal;
    word-break: normal;
    min-inline-size: min-content;
  }

  .chat-input-notice .chat-input-blocked-actions {
    flex: none;
    margin-inline-start: 0;
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
    gap: var(--cinder-space-2);
    margin-inline-start: auto;
  }

  /* On a phone the actions drop to a line of their own and fill it, from the left edge to the
   * right, as touch targets (rows 05a, 06m, 24x), instead of overlapping the reason. A tablet's
   * conversation pane is as narrow as a phone's screen, so it is the screen that decides, not the
   * pane: there the reason wraps and the action stays at the right (row 06n). */
  @media (max-width: 639.98px) {
    .chat-input-blocked-actions {
      flex: 1 0 100%;
    }

    .chat-input-blocked-actions :global(.cinder-button) {
      flex: 1 1 auto;
    }

    .chat-input-notice .chat-input-blocked-actions {
      flex: none;
    }

    .chat-input-notice .chat-input-blocked-actions :global(.cinder-button) {
      flex: 0 0 auto;
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
