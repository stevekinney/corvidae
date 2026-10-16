/** The persistent save-state area: what the draft's persistence looks like to the user. */

import type { StorageAction, StorageFailure } from './theme-draft-storage.ts';
import { isDirty, type ThemeDraft } from './theme-draft-types.ts';

export type SaveIndicator = {
  /** The status-area label. Every failure reads as unsaved: the edits live only in memory. */
  label: 'Saved locally' | 'Unsaved locally';
  /** Actionable, non-silent copy for a failure; `null` when nothing is wrong. */
  notice: string | null;
  actions: readonly StorageAction[];
};

export function saveIndicator(draft: ThemeDraft, failure: StorageFailure | null): SaveIndicator {
  if (failure !== null) {
    return { label: 'Unsaved locally', notice: failure.message, actions: failure.actions };
  }
  return { label: isDirty(draft) ? 'Unsaved locally' : 'Saved locally', notice: null, actions: [] };
}
