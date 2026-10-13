/**
 * The builder's side of the preview channel: it sends the current state to the iframe
 * and validates everything the iframe says back. It owns the "latest request" memory
 * (revision and context) the frame-message validator compares against, so a stale
 * acknowledgement from before a context switch or a frame reload is ignored.
 */

import {
  createApplyMessage,
  validateFrameMessage,
  type ThemePreviewAppliedMessage,
  type ThemePreviewContext,
  type ThemePreviewError,
  type ThemePreviewProperty,
  type ThemePreviewRejectedMessage,
} from './theme-preview-message.ts';

export type ThemePreviewHostOptions = {
  /** The iframe's current content window, or `null` before it exists. */
  frameWindow: () => Window | null;
  origin: string;
  onReady: () => void;
  onApplied: (message: ThemePreviewAppliedMessage) => void;
  onRejected: (message: ThemePreviewRejectedMessage) => void;
  /** A message that failed validation outright (wrong sender, origin, shape, or context). */
  onInvalid?: (error: ThemePreviewError) => void;
};

export class ThemePreviewHost {
  readonly #options: ThemePreviewHostOptions;
  #revision: number | null = null;
  #context: ThemePreviewContext | null = null;

  constructor(options: ThemePreviewHostOptions) {
    this.#options = options;
  }

  /** The `message` event handler to register on the builder window. */
  readonly handleEvent = (event: MessageEvent): void => {
    const frame = this.#options.frameWindow();
    // Messages from any other window are not the frame's and are dropped without comment.
    if (frame === null || event.source !== frame) return;
    const result = validateFrameMessage(
      { source: event.source, origin: event.origin, data: event.data },
      {
        expectedSource: frame,
        expectedOrigin: this.#options.origin,
        expectedRevision: this.#revision,
        expectedContext: this.#context,
      },
    );
    if (result.status === 'stale') return;
    if (result.status === 'rejected') {
      this.#options.onInvalid?.(result.error);
      return;
    }
    const message = result.message;
    if (message.type === 'theme-preview:ready') this.#options.onReady();
    else if (message.type === 'theme-preview:applied') this.#options.onApplied(message);
    else this.#options.onRejected(message);
  };

  /** Send the full current state to the frame; returns false when there is no frame yet. */
  send(input: {
    revision: number;
    context: ThemePreviewContext;
    sceneId: string;
    properties: readonly ThemePreviewProperty[];
  }): boolean {
    this.#revision = input.revision;
    this.#context = { colorMode: input.context.colorMode, motion: input.context.motion };
    const frame = this.#options.frameWindow();
    if (frame === null) return false;
    // The workbench state is reactive; `postMessage` clones plain data only, so copy it out.
    const message = createApplyMessage({
      revision: input.revision,
      sceneId: input.sceneId,
      context: { colorMode: input.context.colorMode, motion: input.context.motion },
      properties: input.properties.map(({ name, value }) => ({ name, value })),
    });
    try {
      frame.postMessage(message, this.#options.origin);
    } catch {
      // A frame that is between documents can refuse the target origin. Its `ready` message
      // asks for the state again once the preview document is up, so nothing is lost.
      return false;
    }
    return true;
  }
}
