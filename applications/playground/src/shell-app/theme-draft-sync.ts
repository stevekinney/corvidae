/**
 * Multi-tab awareness (COR-490). A BroadcastChannel only announces `{ themeId, revision }`;
 * it carries no theme content, and correctness never depends on it, because every write
 * compares revisions in storage. What a tab does with a newer revision is decided here.
 */

import type { ThemeDraft } from './theme-draft-types.ts';
import { isDirty } from './theme-draft-types.ts';

export const THEME_CHANNEL_NAME = 'cinder-playground-theme-builder';

export type RevisionAnnouncement = {
  type: 'revision';
  themeId: string;
  revision: number;
  sender: string;
};

/** The slice of `BroadcastChannel` the module uses. */
export type ChannelLike = {
  postMessage(message: unknown): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  close(): void;
};

export function announceRevision(
  channel: ChannelLike | null,
  sender: string,
  themeId: string,
  revision: number,
): void {
  try {
    const message: RevisionAnnouncement = { type: 'revision', themeId, revision, sender };
    // BroadcastChannel has no target origin; this is not Window.postMessage.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    channel?.postMessage(message);
  } catch {
    /* an announcement is a courtesy; the compare-and-set write is the guarantee */
  }
}

function parseAnnouncement(data: unknown): RevisionAnnouncement | null {
  if (typeof data !== 'object' || data === null) return null;
  const { type, themeId, revision, sender } = data as Record<string, unknown>;
  if (type !== 'revision' || typeof themeId !== 'string' || typeof sender !== 'string') return null;
  if (typeof revision !== 'number' || !Number.isInteger(revision)) return null;
  return { type, themeId, revision, sender };
}

/** Listen for other tabs' announcements; returns the unsubscribe. */
export function listenForRevisions(
  channel: ChannelLike,
  self: string,
  onAnnouncement: (announcement: RevisionAnnouncement) => void,
): () => void {
  const listener = (event: { data: unknown }): void => {
    const announcement = parseAnnouncement(event.data);
    if (announcement !== null && announcement.sender !== self) onAnnouncement(announcement);
  };
  channel.addEventListener('message', listener);
  return () => channel.removeEventListener('message', listener);
}

export type RemoteRevisionAction =
  | { kind: 'ignore' }
  /** A clean tab loads the newer revision itself and says so. */
  | { kind: 'auto-reload'; announcement: string }
  /** A dirty tab is never overwritten: it is offered these two actions. */
  | { kind: 'conflict'; offers: readonly ['reload-stored', 'save-as-copy']; message: string };

/** Decide what a tab does when storage holds a revision newer than the one it last saved. */
export function decideRemoteRevision(
  draft: ThemeDraft,
  storedRevision: number,
): RemoteRevisionAction {
  if (draft.savedRevision !== null && storedRevision <= draft.savedRevision)
    return { kind: 'ignore' };
  const name = draft.envelope.name;
  if (!isDirty(draft)) {
    return {
      kind: 'auto-reload',
      announcement: `“${name}” was updated in another tab. Showing the newer version.`,
    };
  }
  return {
    kind: 'conflict',
    offers: ['reload-stored', 'save-as-copy'],
    message: `“${name}” was changed in another tab and you have unsaved edits here. Reload the stored version (this discards your unsaved edits) or save your draft as a copy.`,
  };
}

/** The confirmation copy shown before "Reload stored version" discards unsaved edits. */
export function reloadDiscardCopy(name: string): string {
  return `Reload the stored version of “${name}”? Your unsaved edits in this tab will be discarded.`;
}
