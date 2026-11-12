/**
 * Which view the payload cards of a run's page show, Fields or JSON, as one value: choosing it on
 * any card chooses it on every card on the page (the Input and Output cards, and the raw payloads
 * under How it ran), and a later run's page opens in the same view. It is kept in `sessionStorage`,
 * so a reload of the tab keeps it and a new tab starts on Fields. Storage that refuses is not
 * fatal: the choice then lasts as long as the page.
 */
import type { PayloadInspectorView } from '@lostgradient/cinder';

import { RUN_DETAIL_COPY } from '../../../app/copy/runs.ts';

const KEY = 'interborough-run-payload-view';

function readView(storage: Storage | undefined): PayloadInspectorView {
  try {
    return storage?.getItem(KEY) === 'json' ? 'json' : 'fields';
  } catch {
    return 'fields';
  }
}

function sessionStorageOrUndefined(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage;
  } catch {
    return undefined;
  }
}

/** The shared Fields or JSON choice of a run's payload cards. */
export class PayloadViewPreference {
  /** The view every payload card shows. */
  view: PayloadInspectorView = $state('fields');

  /**
   * What a polite live region says after the choice changes, because the other cards may be off
   * screen; empty until the first change, so opening a page announces nothing.
   */
  announcement: string = $state('');

  readonly #storage: Storage | undefined;

  constructor(storage: Storage | undefined = sessionStorageOrUndefined()) {
    this.#storage = storage;
    this.view = readView(storage);
  }

  /** Chooses the view for every card, stores it, and sets the announcement. */
  choose(view: PayloadInspectorView): void {
    if (view === this.view) return;
    this.view = view;
    this.announcement = RUN_DETAIL_COPY.io.viewAnnouncement[view];
    try {
      this.#storage?.setItem(KEY, view);
    } catch {
      // Storage that is full or blocked keeps the choice for this page only.
    }
  }
}

/** The one preference the run page's cards share. */
export const payloadViewPreference = new PayloadViewPreference();
