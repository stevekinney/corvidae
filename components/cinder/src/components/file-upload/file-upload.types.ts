import type { Snippet } from 'svelte';
import type { HTMLInputAttributes } from 'svelte/elements';

export type FileUploadRejectionReason = 'too-large' | 'wrong-type' | 'too-many';

export type RejectedFile = {
  /** File rejected during local validation. */
  file: File;
  /** Stable rejection classification for consumers. */
  reason: FileUploadRejectionReason;
  /** Human-readable explanation suitable for inline UI. */
  message: string;
};

/** How the surface is drawn: a large `dropzone` (default), a one-line `compact` zone under its file list, or a bare `button`. */
export type FileUploadVariant = 'dropzone' | 'compact' | 'button';

/** What a local validation failure knows, handed to `rejectionMessage` so the page can word it. */
export type FileUploadRejection = {
  /** The file that failed validation. */
  file: File;
  /** Why it failed. */
  reason: FileUploadRejectionReason;
  /** The size limit in bytes, when one was set. */
  maxSize?: number;
  /** The file-count limit, when one applies. */
  maxFiles?: number;
};

export type FileUploadStatus = 'pending' | 'uploading' | 'ready' | 'error';

export type FileUploadEntry = {
  /** Stable key used for rendering. */
  id: string;
  /** File represented by this row. */
  file: File;
  /** Visual state rendered for the file. */
  status: FileUploadStatus;
  /** Optional 0-100 progress percentage used while uploading. */
  progress?: number;
  /** Optional error message rendered and linked via aria-describedby. */
  error?: string;
  /** Local validation reason. Omitted for errors produced after an accepted upload starts. */
  rejectionReason?: FileUploadRejectionReason;
};

export type FileUploadProps = Omit<
  HTMLInputAttributes,
  'type' | 'children' | 'onchange' | 'oninput' | 'value' | 'files' | 'class'
> & {
  /** Stable id for the native file input. Required when composing with `FormField`. */
  id?: string;
  /** Native file accept filter. */
  accept?: string;
  /** Allow more than one file. Default `false`. */
  multiple?: boolean;
  /** Maximum allowed file size in bytes. */
  maxSize?: number;
  /** Maximum number of files allowed. Files beyond this limit are rejected. */
  maxFiles?: number;
  /** Disables the file picker and drag-and-drop surface. */
  disabled?: boolean;
  /** Native input name used for form submission. */
  name?: string;
  /**
   * How the surface is drawn.
   * - `'dropzone'` is the large dashed area with a title, a description and a Browse button, the
   *   file rows below it.
   * - `'compact'` is a one-line dashed zone (a secondary button and one line of text) that sits
   *   under the file rows, for a short list on a form. The rows are one bordered list (name, size,
   *   remove), an uploading file is one line (name, bar, percent, Cancel upload), and a file that
   *   fails local validation is a danger alert between the rows and the zone saying nothing was
   *   added, not a row. The alert stays until the next file is chosen.
   * - `'button'` is just the secondary button and a line of text beside it (`summary`), for one
   *   file whose details the page already shows. It draws no rows; read the files through
   *   `onFilesChange`. A rejection is still an alert.
   * @default 'dropzone'
   */
  variant?: FileUploadVariant;
  /**
   * The line of text beside the button in the `'button'` variant, usually what was uploaded, such
   * as the file name and what was read from it. Falls back to `description`.
   */
  summary?: string;
  /**
   * Words for a local validation failure. Receives the file, the reason and the limits, and
   * returns the sentence shown for it, so a page can say "documents" instead of "files" and add
   * what happened to the rest of the batch. Defaults to a generic sentence naming the file and
   * the limit.
   */
  rejectionMessage?: (rejection: FileUploadRejection) => string;
  /**
   * Visible text of the cancel action on an uploading file. Only drawn when `onFileCancel` is set.
   * @default Cancel upload
   */
  cancelLabel?: string;
  /** Additional classes merged with `.cinder-file-upload`. */
  class?: string;
  /**
   * Visible title for the dropzone.
   * @default Click to upload or drop files
   */
  title?: string;
  /** Visible description below the title. Defaults to a summary derived from `accept`. */
  description?: string;
  /**
   * Visible label shown while files are dragged over the dropzone.
   * @default Drop to add
   */
  draggingLabel?: string;
  /**
   * Visible text for the browse button.
   * @default Browse files
   */
  browseLabel?: string;
  /**
   * Adds focus and drag-active border emphasis to the dropzone.
   * @default true
   */
  borderBeamVisible?: boolean;
  /** Consumer-driven file rows, including upload progress and error states. */
  files?: FileUploadEntry[];
  /** Replaces the default resting-state dropzone body. */
  idle?: Snippet;
  /** Replaces the default drag-active dropzone body. */
  dragActive?: Snippet;
  /** Replaces the default file-list renderer. Receives the live resolved rows, including an empty array, and a removal callback when the queue is mutable. */
  fileList?: Snippet<[FileUploadEntry[], ((entry: FileUploadEntry) => void) | undefined]>;
  /** Fires with accepted files after local validation passes. */
  onFilesAccepted?: (files: File[]) => void;
  /** Fires with the full resolved entry list after local validation changes it. */
  onFilesChange?: (entries: FileUploadEntry[]) => void;
  /** Fires with rejected files and reasons after local validation runs. */
  onReject?: (files: RejectedFile[]) => void;
  /**
   * Called when Cancel upload is activated on an uploading file. The component does not remove the
   * row itself: stop the upload and drop the entry from `files`. Without it an uploading file has
   * no cancel action.
   */
  onFileCancel?: (entry: FileUploadEntry) => void;
  /** Called when the retry button is activated for a failed file. */
  onFileRetry?: (entry: FileUploadEntry) => void;
};
