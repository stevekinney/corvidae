import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

import type { ToolCallRailStatus } from '../tool-call-rail/tool-call-rail.types.ts';

/** Where the call stands, in the rail's words, including an approval that expired before a decision. */
export type ToolCallPanelStatus = ToolCallRailStatus;

/** How the panel's Input and Result sections show a payload: labelled fields, or the stored JSON. */
export type ToolCallPanelView = 'fields' | 'json';

/**
 * How the panel sits on the page:
 *
 * - `docked`: an inset panel beside the conversation, in the flow of the page.
 * - `overlay`: a right sheet over the content on a scrim, closed by its X or Esc.
 * - `sheet`: a bottom sheet with a grabber and a Close button, for a phone.
 * - `auto`: `sheet` below 640px, `overlay` up to `dockedFrom`, and `docked` from there.
 */
export type ToolCallPanelPlacement = 'auto' | 'docked' | 'overlay' | 'sheet';

/** Why a call failed, as the panel's Error section writes it: the message first. */
export type ToolCallPanelError = {
  /** What went wrong, in words ("No reply from mail.example.com after 10s"). Shown first. */
  message: string;
  /** The machine code for the failure ("smtp-timeout"), in small monospace. */
  code?: string | undefined;
  /** Whether trying the call again can work. Written "Yes" or "No". */
  retryable?: boolean | undefined;
};

/** The answer that is on its way for a `waiting` call: that button reads "Approving…" or "Denying…" and both turn off. */
export type ToolCallPanelResolving = 'approve' | 'deny';

/** The words the panel speaks, for a caller that is not writing English. */
export type ToolCallPanelLabels = {
  /** The status word of each status. Defaults to Done, Approved, Running, Waiting on you, Denied, Failed and Interrupted. */
  status?: Partial<Record<ToolCallPanelStatus, string>> | undefined;
  /** The Input heading. Defaults to "Input". */
  input?: string | undefined;
  /** What the Input section says when the call took no input. Defaults to "This tool call takes no input." */
  noInput?: string | undefined;
  /** The Error heading. Defaults to "Error". */
  error?: string | undefined;
  /** The Error section's Message row. Defaults to "Message". */
  message?: string | undefined;
  /** The Error section's Code row. Defaults to "Code". */
  code?: string | undefined;
  /** The Error section's Retryable row. Defaults to "Retryable". */
  retryable?: string | undefined;
  /** What a running call's Result section says. Defaults to "The result appears when the call finishes." */
  pending?: string | undefined;
  /** The note under a failed call, given the retry message. Defaults to the sentence that explains what retrying sends. */
  retryNote?: ((retryMessage: string) => string) | undefined;
  /** The retry button. Defaults to "Ask the agent to retry". */
  retry?: string | undefined;
  /** The button that copies the input. Defaults to "Copy input". */
  copyInput?: string | undefined;
  /** The button that copies the result, which writes the result heading after "Copy". Defaults to "Copy result". */
  copyResult?: string | undefined;
  /** The button that copies the error. Defaults to "Copy error". */
  copyError?: string | undefined;
  /** The Note field's label. Defaults to "Note (optional)". */
  note?: string | undefined;
  /** The Note field's description. Defaults to "Saved with your decision. If you deny, the agent reads it as the reason." */
  noteDescription?: string | undefined;
  /** The Deny button. Defaults to "Deny". */
  deny?: string | undefined;
  /** The Approve button. Defaults to "Approve". */
  approve?: string | undefined;
  /** The Deny button while the answer is on its way. Defaults to "Denying…". */
  denying?: string | undefined;
  /** The Approve button while the answer is on its way. Defaults to "Approving…". */
  approving?: string | undefined;
  /** The text of the close control on a bottom sheet. Defaults to "Close". */
  close?: string | undefined;
  /** The accessible name of the X that closes a docked or overlay panel. Defaults to "Close panel". */
  closeIcon?: string | undefined;
};

/** Props for the ToolCallPanel component. */
export type ToolCallPanelProps = Omit<
  HTMLAttributes<HTMLElement>,
  'class' | 'children' | 'role' | 'title'
> & {
  /**
   * Whether the panel is open. Bindable: the X, Close and Esc set it to `false`, and the page then
   * hands focus back to the call's row. @default true
   */
  open?: boolean | undefined;
  /** The tool's name as a person reads it ("Send email"). It names the panel. */
  name: string;
  /** The tool's identifier ("send-email"), small and monospaced after the name. */
  identifier?: string | undefined;
  /** Where the call stands. It picks the status dot, the status word and which sections show. */
  status: ToolCallPanelStatus;
  /** How long the call took, or has run so far ("10.0s"), formatted by the caller. */
  duration?: string | undefined;
  /** Where the call falls in its turn ("call 28 of 30"), written after the duration. */
  position?: string | undefined;
  /**
   * The line under the name, in the caller's words ("Reads, ran in 0.4s"). When set it replaces
   * the status word, duration and position.
   */
  summary?: string | undefined;
  /**
   * What the call was given. An object shows as labelled fields, a list or a single value as one
   * row, and `undefined` reads "This tool call takes no input."
   */
  input?: unknown;
  /**
   * What the call returned, for a call that finished. Hidden for a failed or waiting call, and a
   * running call says the result is coming.
   */
  result?: unknown;
  /** The Result heading. A call that returns "Output" in the caller's vocabulary says so here. @default "Result" */
  resultLabel?: string | undefined;
  /** Why a `failed` call failed. It shows as a tinted danger block under the Input, message first. */
  error?: ToolCallPanelError | undefined;
  /**
   * How Input and Result show. `fields` lists each property with a sentence-case label; `json`
   * shows the stored value in a code block. Bindable. @default "fields"
   */
  view?: ToolCallPanelView | undefined;
  /**
   * Secret paths to hide in both views and in the copy buttons, as `PayloadInspector`'s `redact`:
   * dot-separated property names, `*` for any one name or position. Without it, a property whose
   * name reads as a secret (token, key, password, authorization) is hidden; pass `[]` to hide nothing.
   */
  redact?: readonly string[] | undefined;
  /**
   * The message the retry button sends as the person's own ("Please retry Send email to
   * maya@example.com"). It is quoted in the note under a failed call; the button shows only when
   * `onRetry` is set.
   */
  retryMessage?: string | undefined;
  /** Fired when the person asks the agent to retry a `failed` call. The button is secondary, full width, and shows only when this is set. */
  onRetry?: (() => void) | undefined;
  /** Fired with the note when Approve is pressed on a `waiting` call. The decision bar shows only when this or `onDeny` is set. */
  onApprove?: ((note: string) => void) | undefined;
  /** Fired with the note when Deny is pressed on a `waiting` call. If the person denies, the agent reads the note as the reason. */
  onDeny?: ((note: string) => void) | undefined;
  /** The answer that is on its way for a `waiting` call. */
  resolving?: ToolCallPanelResolving | undefined;
  /**
   * Fired once each time the panel closes, whether by its X, Close, Esc or the caller setting
   * `open` to `false`. A page hands focus back to the call's row here, with `focusCall(id)` on the
   * rail.
   */
  onClose?: (() => void) | undefined;
  /** How the panel sits on the page. @default "auto" */
  placement?: ToolCallPanelPlacement | undefined;
  /**
   * The viewport width the panel docks from, as a CSS length. Narrower than this it opens as an
   * overlay on a scrim: a docked panel beside a 190px sidebar, a 250px list, a conversation and
   * the panel needs about 1,260px. A separate threshold from the shared 1024px desktop breakpoint.
   * @default "1280px"
   */
  dockedFrom?: string | undefined;
  /** The element that opened the panel, for focus to return to when an overlay or sheet closes. */
  triggerRef?: HTMLElement | null | undefined;
  /** The panel's words. */
  labels?: ToolCallPanelLabels | undefined;
  /** Extra sections after the Input and Result, such as a link to the run. */
  children?: Snippet | undefined;
  /** Additional class names merged with `.cinder-tool-call-panel`. */
  class?: string | undefined;
};

/** Schema generator surface for ToolCallPanel: excludes snippet and function props. */
export interface ToolCallPanelSchemaProps {
  /** Whether the panel is open. @default true */
  open?: boolean | undefined;
  /** The tool's name as a person reads it ("Send email"). It names the panel. */
  name: string;
  /** The tool's identifier ("send-email"), small and monospaced after the name. */
  identifier?: string | undefined;
  /** Where the call stands. */
  status: ToolCallPanelStatus;
  /** How long the call took, formatted by the caller ("10.0s"). */
  duration?: string | undefined;
  /** Where the call falls in its turn ("call 28 of 30"). */
  position?: string | undefined;
  /** The line under the name, replacing the status word, duration and position. */
  summary?: string | undefined;
  /**
   * What the call was given.
   * @schemaPermissive
   */
  input?: unknown;
  /**
   * What the call returned.
   * @schemaPermissive
   */
  result?: unknown;
  /** The Result heading. @default "Result" */
  resultLabel?: string | undefined;
  /**
   * Why a failed call failed.
   * @schemaObject
   */
  error?: ToolCallPanelError | undefined;
  /** How Input and Result show. @default "fields" */
  view?: ToolCallPanelView | undefined;
  /** Secret paths to hide. */
  redact?: readonly string[] | undefined;
  /** The message the retry button sends as the person's own. */
  retryMessage?: string | undefined;
  /** The answer that is on its way for a waiting call. */
  resolving?: ToolCallPanelResolving | undefined;
  /** How the panel sits on the page. @default "auto" */
  placement?: ToolCallPanelPlacement | undefined;
  /** The viewport width the panel docks from. @default "1280px" */
  dockedFrom?: string | undefined;
  /** Additional class names merged with `.cinder-tool-call-panel`. */
  class?: string | undefined;
}
