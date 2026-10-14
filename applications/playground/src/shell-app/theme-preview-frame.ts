/**
 * The preview frame's side of the protocol: listen for the builder's messages, validate
 * each one, apply it to the frame's own document, and acknowledge it.
 *
 * A message that fails validation leaves the last-valid preview untouched and is
 * answered with a named error; a stale revision is ignored silently. The frame announces
 * `ready` on boot, so a reloaded frame (which starts with an empty variable map) asks the
 * builder to send the current state again.
 */

import { ThemePreviewApplier } from './theme-preview-applier.ts';
import {
  createAppliedMessage,
  createReadyMessage,
  createRejectedMessage,
  THEME_PREVIEW_MESSAGE_TYPES,
  validateParentMessage,
  type ThemePreviewContext,
} from './theme-preview-message.ts';

export type ThemePreviewFrameOptions = {
  window: Window;
  allowedProperties: ReadonlySet<string>;
  /** Called with the scene the builder selected, once its message validated. */
  onScene: (sceneId: string) => void;
  /** Called with a named error whenever a message was rejected and the last-valid preview kept. */
  onError?: (code: string, detail: string) => void;
};

export type ThemePreviewFrame = {
  applier: ThemePreviewApplier;
  lastRevision: () => number;
  context: () => ThemePreviewContext | null;
  dispose: () => void;
};

function revisionOf(data: unknown): number | null {
  if (typeof data !== 'object' || data === null) return null;
  const revision = (data as { revision?: unknown }).revision;
  return typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= 0
    ? revision
    : null;
}

export function startThemePreviewFrame(options: ThemePreviewFrameOptions): ThemePreviewFrame {
  const { window: frameWindow } = options;
  const applier = new ThemePreviewApplier(frameWindow.document);
  let lastRevision = -1;
  let context: ThemePreviewContext | null = null;
  const parent = frameWindow.parent === frameWindow ? null : frameWindow.parent;
  const origin = frameWindow.location.origin;

  const post = (message: unknown): void => {
    parent?.postMessage(message, origin);
  };

  const onMessage = (event: MessageEvent): void => {
    // Only the embedding builder talks to the frame; anything else is not even answered.
    if (parent === null || event.source !== parent) return;
    const result = validateParentMessage(
      { source: event.source, origin: event.origin, data: event.data },
      {
        expectedSource: parent,
        expectedOrigin: origin,
        lastRevision,
        allowedProperties: options.allowedProperties,
      },
    );
    if (result.status === 'stale') return;
    if (result.status === 'rejected') {
      options.onError?.(result.error.code, result.error.message);
      post(createRejectedMessage({ revision: revisionOf(event.data), error: result.error }));
      return;
    }
    const message = result.message;
    if (message.type === THEME_PREVIEW_MESSAGE_TYPES.apply) {
      applier.apply(message.context, message.properties);
    } else {
      applier.reset(message.context);
    }
    lastRevision = message.revision;
    context = message.context;
    options.onScene(message.sceneId);
    post(
      createAppliedMessage({
        revision: message.revision,
        context: message.context,
        sceneId: message.sceneId,
        propertyCount: applier.appliedNames().length,
      }),
    );
  };

  frameWindow.addEventListener('message', onMessage);
  post(createReadyMessage());

  return {
    applier,
    lastRevision: () => lastRevision,
    context: () => context,
    dispose: () => frameWindow.removeEventListener('message', onMessage),
  };
}
