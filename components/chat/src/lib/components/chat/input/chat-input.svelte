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
  import type { ChatComposerFormat, ChatComposerToolbarContext } from './composer-markdown.ts';
  import type { ChatComposerStatus } from './composer-status.ts';

  export type { ChatAttachment } from './chat-attachment.ts';

  export type ChatInputProps = Omit<HTMLFormAttributes, 'onsubmit' | 'class'> & {
    /** Unique ID for accessibility (required) */
    id: string;
    /** Current markdown content (two-way bindable) */
    value?: string;
    /** Placeholder text */
    placeholder?: string;
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
    /** Whether a submission is in progress */
    sending?: boolean;
    /**
     * Keep the composer usable while `sending` is `true`, so a follow-up can be
     * submitted during a run. Send stays available and, when `onstop` is
     * provided, Stop is shown beside it instead of replacing it. Default `false`.
     */
    allowFollowUp?: boolean;
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
    /** Show Bold, Italic, Code, Link, and List buttons in the footer. Default `false`. */
    formattingToolbar?: boolean;
    /** The status line under the composer: an approval waiting, a reconnect, or queued follow-ups. */
    status?: ChatComposerStatus | undefined;

    // Snippets for extensibility
    /** Custom actions area (e.g., additional buttons) */
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
   * - Keyboard shortcuts: Enter to send, Shift+Enter for newline; Cmd/Ctrl+B, I, E, K format Markdown
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

  import { flushSync, untrack } from 'svelte';
  import { classNames } from '../../../utilities/class-names.ts';
  import { useAnnouncer } from '../../../utilities/use-announcer.svelte.ts';
  import { createIdFactory, useStableId } from '../../../utilities/id-factory.ts';
  import {
    Bold,
    Button,
    Code,
    Italic,
    LinkIcon,
    List,
    Paperclip,
    SendHorizontal,
    Square,
    Tooltip,
    X,
  } from '@lostgradient/cinder';
  import {
    applyComposerFormat,
    composerShortcutFormat,
    highlightComposerMarkdown,
  } from './composer-markdown.ts';
  import { composerStatusText } from './composer-status.ts';
  import { deriveAttachmentKind } from './attachment-kind.ts';
  import ChatAttachmentPreview from './chat-attachment-preview.svelte';

  // Per-instance fallback factory for attachments whose file metadata is unavailable
  // AND as a collision-disambiguation counter when two files share identical metadata.
  const attachmentIdFactory = createIdFactory('attachment');
  // Tracks hash-derived IDs used in this instance so collisions (same name/size/mtime)
  // get a unique suffix rather than a duplicate DOM ID.
  const usedAttachmentIds = new Set<string>();

  const FORMATTING_BUTTONS = [
    { format: 'bold', label: 'Bold', keyshortcuts: 'Meta+B Control+B', icon: Bold },
    { format: 'italic', label: 'Italic', keyshortcuts: 'Meta+I Control+I', icon: Italic },
    { format: 'code', label: 'Code', keyshortcuts: 'Meta+E Control+E', icon: Code },
    { format: 'link', label: 'Link', keyshortcuts: 'Meta+K Control+K', icon: LinkIcon },
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
    placeholder = 'Type a message...',
    composerLabel = 'Message',
    composerRole,
    composerAriaExpanded,
    composerAriaControls,
    composerAriaActiveDescendant,
    composerAriaAutocomplete,
    disabled = false,
    paused = false,
    sending = false,
    allowFollowUp = false,
    error,
    class: className,
    action,
    name = 'content',
    clearOnSubmit = true,
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
    actions,
    toolbar,
    ...rest
  }: ChatInputProps = $props();

  const resolvedComposerLabel = $derived(composerLabel.trim() || 'Message');

  const markdownSegments = $derived(markdownStyling ? highlightComposerMarkdown(value) : []);
  const statusText = $derived(status ? composerStatusText(status) : undefined);
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

  // Derived: show stop button when sending and onstop is provided. In follow-up
  // mode Stop sits beside Send rather than taking its place.
  const showStopButton = $derived(sending && onstop !== undefined && !allowFollowUp);
  const showSideStopButton = $derived(sending && onstop !== undefined && allowFollowUp);
  const showSendingSpinner = $derived(sending && !allowFollowUp);
  const sendBlocked = $derived(sending && !allowFollowUp);
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
  let formElement = $state<HTMLFormElement | null>(null);
  let editorElement = $state<HTMLTextAreaElement | null>(null);
  let fileInputRef = $state<HTMLInputElement | null>(null);
  let sendButtonRef = $state<HTMLButtonElement | null>(null);
  let stopButtonRef = $state<HTMLButtonElement | null>(null);

  // When the run ends the side Stop button unmounts. If it held focus, hand focus
  // to Send (or the textarea while Send is disabled) before it goes, so focus is
  // not dropped to the document body.
  $effect.pre(() => {
    if (showSideStopButton) return;
    const stopButton = untrack(() => stopButtonRef);
    if (stopButton === null || document.activeElement !== stopButton) return;
    (canSubmit ? sendButtonRef : editorElement)?.focus();
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
  const isWhitespaceOnly = $derived(value.trim().length === 0);
  const hasPendingAttachments = $derived(
    attachments.some((a) => a.status === 'pending' || a.status === 'uploading'),
  );
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
  // Allow submit when text is present, even if some attachments errored.
  // Only block on pending/uploading attachments (they're not yet ready to send).
  const canSubmit = $derived(
    (!isWhitespaceOnly || hasReadyAttachments || hasReadyPromotedPaste) &&
      !disabled &&
      !paused &&
      !sendBlocked &&
      !hasPendingAttachments,
  );
  const sendTooltipText = $derived.by(() => {
    if (hasPendingAttachments) return 'Wait for attachments';
    if (isWhitespaceOnly && !hasReadyAttachments && !hasReadyPromotedPaste) {
      return 'Add a message or attachment';
    }
    if (showStopButton) return 'Stop generating';
    if (submitOn === 'modifier-enter') return 'Send (Command or Control + Enter)';
    if (submitOn === 'enter-if-single-line' && value.includes('\n')) return 'Send message';
    return 'Send (Enter)';
  });

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

  const KIND_LABELS: Record<AttachmentKind, string> = {
    image: 'Image',
    code: 'Code file',
    document: 'Document',
  };

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
      return `Invalid file type: ${failure.file.type}. Accepted types: ${failure.acceptedTypes.join(', ')}.`;
    }
    if (failure.kind === 'too-large') {
      return `File exceeds ${Math.round(failure.maxFileSize / (1024 * 1024))}MB limit`;
    }
    return 'Upload failed';
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
    const { reference: _reference, ...others } = attachment;
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
    announcer.announce(`${KIND_LABELS[kind]} attached: ${file.name}`);

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
        const reference = await upload(attachment.file, { signal: controller.signal });
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
        settle({ status: 'error', error: message });
        announcer.announce(`${attachment.file.name} could not be uploaded: ${message}`);
      } finally {
        uploadControllers.delete(attachment.id);
      }
    })();
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
      announcer.announce(`${KIND_LABELS[attachment.kind]} removed`);
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

    // Call onsubmit callback
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

  function revokeAttachmentPreviewsOnDestroy(_form: HTMLFormElement): { destroy(): void } {
    return {
      destroy() {
        abortUploads();
        attachments.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
      },
    };
  }
</script>

<form
  use:revokeAttachmentPreviewsOnDestroy
  bind:this={formElement}
  class={classNames('chat-input', isDragOver && 'chat-input-dragover', className)}
  method="POST"
  {action}
  onsubmit={handleSubmit}
  onpaste={handlePaste}
  ondrop={handleDrop}
  ondragenter={handleDragEnter}
  ondragover={handleDragOver}
  ondragleave={handleDragLeave}
  oncompositionstart={handleCompositionStart}
  oncompositionend={handleCompositionEnd}
  aria-label="Chat message composer"
  aria-busy={sending || undefined}
  {...rest}
>
  {#if isDragOver}
    <div class="chat-input-drop-overlay" aria-hidden="true">
      <Paperclip class="cinder-icon-md" />
      <span>Drop files to attach</span>
    </div>
  {/if}
  <!-- Hidden input for form action mode -->
  {#if isFormActionMode}
    <input type="hidden" {name} {value} />
  {/if}

  <!-- Attachment previews -->
  {#if attachments.length > 0}
    <div class="chat-input-attachments" role="list" aria-label="Attached files">
      {#each attachments as attachment (attachment.id)}
        <div class="chat-input-attachment-wrapper" role="listitem">
          <ChatAttachmentPreview {attachment} />
          <button
            type="button"
            class="chat-input-attachment-remove"
            onclick={() => removeAttachment(attachment.id)}
            aria-label={`Remove ${attachment.file.name}`}
          >
            <X class="cinder-icon-xs" />
          </button>
        </div>
      {/each}
    </div>
    {#each attachments.filter((a) => a.status === 'error' && a.error) as failed (failed.id)}
      <p class="chat-input-attachment-error" data-attachment-error={failed.id}>
        {failed.file.name}: {failed.error}
      </p>
    {/each}
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
      {placeholder}
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
    <div class="chat-input-footer-left">
      {#if allowAttachments}
        <input
          bind:this={fileInputRef}
          id={`${id}-file-picker`}
          type="file"
          accept={acceptedTypes.join(',')}
          multiple
          class="cinder-sr-only"
          onchange={handleFileSelect}
          aria-label="Attach files"
          aria-hidden="true"
          tabindex={-1}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onclick={() => fileInputRef?.click()}
          disabled={disabled || paused || sendBlocked}
          aria-label="Attach file"
        >
          <Paperclip class="cinder-icon-sm" />
        </Button>
      {/if}

      {#if formattingToolbar}
        <div class="chat-input-toolbar" role="toolbar" aria-label="Formatting">
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
      {/if}
      {#if toolbar}
        {@render toolbar(toolbarContext)}
      {/if}

      <!-- Visually hidden shortcut description: always in the accessibility tree even when hint is container-queried away -->
      <span id={shortcutDescriptionId} class="cinder-sr-only">
        {#if showStopButton}
          Response is streaming. Use the stop button to stop generation.
        {:else if showSideStopButton}
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
        <button
          bind:this={stopButtonRef}
          type="button"
          class="chat-input-send"
          data-stop=""
          onclick={() => onstop?.()}
          aria-label="Stop generating"
          aria-describedby={shortcutDescriptionId}
        >
          <Square class="cinder-icon-sm" />
        </button>
        <Tooltip
          text="Stop generating"
          class="chat-input-tooltip"
          placement="top"
          triggerRef={stopButtonRef}
        />
      {/if}

      <!-- Send/Stop trigger stays mounted so Tooltip does not tear down while focus leaves it. -->
      <button
        bind:this={sendButtonRef}
        type={showStopButton ? 'button' : 'submit'}
        class="chat-input-send"
        data-stop={showStopButton ? '' : undefined}
        disabled={showStopButton ? false : !canSubmit}
        onclick={handleSendButtonClick}
        aria-label={showStopButton
          ? 'Stop generating'
          : showSendingSpinner
            ? 'Sending message'
            : 'Send message'}
        aria-describedby={shortcutDescriptionId}
      >
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
        {:else}
          <SendHorizontal class="cinder-icon-sm" />
        {/if}
      </button>
      <Tooltip
        text={sendTooltipText}
        class="chat-input-tooltip"
        placement="top"
        triggerRef={sendButtonRef}
      />
    </div>
  </div>

  {#if statusText}
    <p class="chat-input-status" data-chat-composer-status={status?.kind}>{statusText}</p>
  {/if}

  <!-- Error display -->
  {#if error}
    <p id={errorId} class="chat-input-error" role="alert">
      {error}
    </p>
  {/if}

  <!-- Screen reader announcements -->
  <div aria-live="polite" aria-atomic="true" class="cinder-sr-only">
    {announcer.message}
  </div>
</form>

<style>
  .chat-input {
    position: relative;
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    background: var(--cinder-control-background);
    border: 1px solid var(--cinder-control-border);
    border-radius: var(--cinder-radius-lg);
    padding: var(--cinder-space-3);
    transition: border-color var(--cinder-duration-fast) var(--cinder-ease-standard);
  }

  .chat-input:focus-within {
    border-color: var(--cinder-accent-solid);
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

  /* Attachment previews */
  .chat-input-attachments {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
  }

  /* Keep the remove control inside the preview while preserving its hit target. */
  .chat-input-attachment-wrapper {
    position: relative;
    overflow: hidden;
  }

  .chat-input-attachment-remove {
    position: absolute;
    inset-block-start: 0;
    inset-inline-end: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    /* WCAG 2.2 AA compliant touch target with visual icon inside */
    width: var(--cinder-touch-target-min);
    height: var(--cinder-touch-target-min);
    padding: 0;
    background: oklch(0% 0 0 / 70%);
    border: none;
    border-radius: var(--cinder-radius-full);
    cursor: pointer;
    color: white;
    opacity: 1;
    transition:
      opacity var(--cinder-duration-fast) var(--cinder-ease-standard),
      background var(--cinder-duration-fast) var(--cinder-ease-standard);
  }

  @media (hover: hover) {
    .chat-input-attachment-remove:hover {
      background: var(--cinder-status-danger-solid);
    }
  }

  .chat-input-attachment-remove:focus-visible {
    opacity: 1;
  }

  .chat-input-attachment-remove:focus-visible::before {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 var(--cinder-ring-width)
      var(--_cinder-chat-input-attachment-remove-ring, var(--cinder-ring-color));
    pointer-events: none;
  }

  @media (forced-colors: active) {
    .chat-input-attachment-remove:focus-visible {
      outline: var(--cinder-ring-width) solid ButtonText;
      outline-offset: var(--cinder-ring-offset);
    }
    .chat-input-attachment-remove:focus-visible::before {
      box-shadow: none;
      outline: var(--cinder-ring-width) solid ButtonText;
      outline-offset: var(--cinder-ring-offset);
    }
  }

  /* Editor container */
  .chat-input-editor-container {
    min-height: 2.5rem;
  }

  .chat-input-editor {
    display: block;
    width: 100%;
    min-height: 2.5rem;
    max-height: min(12rem, 35dvh);
    padding: var(--cinder-space-1) var(--cinder-space-3);
    resize: none;
    field-sizing: content;
    overflow-y: auto;
    font: inherit;
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
    padding: var(--cinder-space-1) var(--cinder-space-3);
    font: inherit;
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

  .chat-input-toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
  }

  .chat-input-status {
    margin: 0;
    padding-inline: var(--cinder-space-1);
    font-size: var(--cinder-text-xs);
    color: var(--cinder-text-muted);
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
  }

  .chat-input-footer-left,
  .chat-input-footer-right {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-2);
  }

  @media (pointer: coarse) {
    :global(.chat-input-tooltip.cinder-tooltip) {
      display: none !important;
    }
  }

  /* Send button: a 32px icon button. A coarse pointer keeps the 44px WCAG 2.2 AA touch target
   * (--cinder-touch-target-min) as its hit area, not its drawn size: the ::after below extends the
   * element's own hit-testable box, so a tap within 6px of the button still lands on it. */
  .chat-input-send {
    /* An absolutely positioned ::after is measured from the PADDING box, so the stop state's 1px
     * border has to come back out of the extension for the hit area to be the full 44px. */
    --_cinder-chat-send-edge: 0px;

    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 2rem;
    height: 2rem;
    padding: 0;
    border: none;
    border-radius: var(--cinder-radius-md);
    background: var(--cinder-accent-solid);
    color: var(--cinder-accent-contrast);
    cursor: pointer;
    transition:
      background var(--cinder-duration-fast) var(--cinder-ease-standard),
      transform var(--cinder-duration-fast) var(--cinder-ease-standard);
  }

  @media (hover: hover) {
    .chat-input-send:hover:not(:disabled) {
      background: color-mix(in oklch, var(--cinder-accent-solid), black 15%);
    }
  }

  .chat-input-send:active:not(:disabled) {
    transform: scale(0.95);
  }

  .chat-input-send:disabled {
    background: transparent;
    box-shadow: none;
    color: var(--cinder-text-disabled);
    cursor: not-allowed;
  }

  @media (any-pointer: coarse) {
    .chat-input-send::after {
      content: '';
      position: absolute;
      inset: calc((var(--cinder-touch-target-min) - 2rem) / -2 - var(--_cinder-chat-send-edge));
    }

    /* Send and Stop sit side by side while a follow-up is allowed, so their extended hit areas must
     * not overlap: the gap has to be at least the two 6px extensions. */
    .chat-input-footer-right {
      gap: var(--cinder-space-3);
    }
  }

  .chat-input-send:focus-visible {
    outline: var(--cinder-ring-width) solid transparent;
    outline-offset: 3px;
    box-shadow: var(--_cinder-focus-ring-shadow);
  }

  /* The send button is a solid accent fill: gap, then ring (COR-1498). The
     tinted stop state keeps the tight ring. */
  .chat-input-send:not([data-stop]):focus-visible {
    box-shadow: var(--_cinder-focus-ring-filled-shadow);
  }

  @media (forced-colors: active) {
    .chat-input-send:not([data-stop]):focus-visible {
      outline: var(--cinder-ring-width) solid Highlight;
      outline-offset: 3px;
    }
  }

  /* Stop button variant - danger-tinted to signal urgency during streaming */
  .chat-input-send[data-stop] {
    --_cinder-chat-send-edge: 1px;

    background: var(--cinder-status-danger-background);
    color: var(--cinder-status-danger-text);
    border: 1px solid var(--cinder-status-danger-border);
  }

  @media (hover: hover) {
    .chat-input-send[data-stop]:hover {
      background: var(--cinder-status-danger-border);
      border-color: var(--cinder-status-danger-border);
    }
  }

  @media (forced-colors: active) {
    .chat-input-send:focus-visible {
      outline: var(--cinder-ring-width) solid Highlight;
      outline-offset: 3px;
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

  /* Error */
  .chat-input-attachment-error {
    margin: 0;
    font-size: var(--_cinder-chat-text-xs, var(--cinder-text-xs));
    color: var(--cinder-status-danger-text);
    overflow-wrap: anywhere;
  }

  .chat-input-error {
    margin: 0;
    font-size: var(--_cinder-chat-text-xs, var(--cinder-text-xs));
    color: var(--cinder-status-danger-text);
  }
</style>
