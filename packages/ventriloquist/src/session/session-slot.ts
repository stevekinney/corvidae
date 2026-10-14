import type { AttachRequest, AttachResult, SessionOptions } from './session-types.ts';
import { Session } from './session.ts';
import { SourceAcquisitionError } from './source-acquisition-error.ts';

export type SlotRefusal = 'occupied' | 'quarantined' | 'identity-reused';

export type SlotAdmission =
  | { readonly accepted: true; readonly session: Session }
  | { readonly accepted: false; readonly reason: SlotRefusal };

/**
 * The host-side ownership slot: at most one live session, replaced only by a session with a new
 * identity once the previous one has closed with a complete cleanup. An incomplete or unknown
 * cleanup leaves the slot quarantined, and nothing in this package can clear it: that takes a
 * host-authorized attestation the package cannot manufacture. Generations are issued from one
 * counter, so no session ever receives a generation an earlier session held. A session that cannot
 * acquire its sources holds the slot while the sources it did acquire are released, and quarantines
 * it when that release is incomplete or unknown.
 */
export class SessionSlot {
  #current: Session | undefined;
  #generation: number;
  #quarantined = false;
  #pendingAcquisitionCleanups = 0;
  readonly #usedIdentities: Set<string>;

  constructor() {
    this.#generation = 0;
    this.#usedIdentities = new Set();
  }

  get current(): Session | undefined {
    return this.#current;
  }

  /** Reserve the slot for a new session. Refused immediately, never queued, while it is not free. */
  create(options: Omit<SessionOptions, 'issueGeneration'>): SlotAdmission {
    const current = this.#current;
    if (this.#quarantined || current?.snapshot.quarantined) {
      return { accepted: false, reason: 'quarantined' };
    }
    if (
      this.#pendingAcquisitionCleanups > 0 ||
      (current !== undefined && !current.snapshot.closed)
    ) {
      return { accepted: false, reason: 'occupied' };
    }
    if (this.#usedIdentities.has(options.sessionId)) {
      return { accepted: false, reason: 'identity-reused' };
    }
    let session: Session;
    try {
      session = new Session({ ...options, issueGeneration: () => ++this.#generation });
    } catch (error) {
      if (error instanceof SourceAcquisitionError) this.#holdForAcquisitionCleanup(error.cleanup);
      throw error;
    }
    this.#usedIdentities.add(options.sessionId);
    this.#current = session;
    return { accepted: true, session };
  }

  /**
   * Keep the slot unavailable until the sources a failed construction had acquired are released,
   * then quarantine it unless that release was complete.
   */
  #holdForAcquisitionCleanup(cleanup: SourceAcquisitionError['cleanup']): void {
    this.#pendingAcquisitionCleanups += 1;
    void cleanup.then((outcome) => {
      this.#pendingAcquisitionCleanups -= 1;
      this.#quarantined ||= outcome !== 'complete';
      return outcome;
    });
  }

  /** Attach to the session named by `sessionId`. Any other identity, including a retired one, is stale. */
  attach(sessionId: string, request: AttachRequest): AttachResult {
    const current = this.#current;
    if (current === undefined || current.sessionId !== sessionId) {
      return { accepted: false, reason: 'stale-session' };
    }
    return current.attach(request);
  }
}
