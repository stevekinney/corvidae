import {
  TerminalConnectError,
  TerminalWebSocketClient,
  type TerminalGeometry,
  type TerminalState,
} from '@lostgradient/terminal';

import { PROFILE_DESCRIPTIONS, type ProfileIdentifier } from '../shared/profile-catalog.ts';
import { terminalStateFor } from './channel-view.ts';
import { describeRefusal, requestSession, waitForFreeSlot } from './session-request.ts';

/**
 * The page's one terminal session, as state the components read. It owns the order of events the
 * contract requires and nothing else: ask the server for a session, connect, show what the
 * transport reports, and on any end wait for the server to finish cleaning up before a
 * replacement is offered. It never reconnects, never replays input and never reuses a client; a
 * restart is a new client for a new session.
 */
export class SessionModel {
  profile = $state<ProfileIdentifier>('shell');
  readOnly = $state(false);
  state = $state<TerminalState>('empty');
  message = $state<string | undefined>(undefined);
  client = $state.raw<TerminalWebSocketClient | undefined>(undefined);
  /** The server has not finished cleaning up the previous session, so a replacement is not offered. */
  cleanupPending = $state(false);
  /** Bumped for every session, so a late answer for an earlier one is ignored. */
  generation = $state(0);

  #geometry: TerminalGeometry | undefined;
  #attempt = 0;

  get description() {
    return PROFILE_DESCRIPTIONS[this.profile];
  }

  /** Start a new session with the chosen profile. Whatever session there was has been ended first. */
  async begin(): Promise<void> {
    const attempt = ++this.#attempt;
    // End what is running first, so the server's cleanup is already under way when it is asked for a new session.
    const previous = this.client;
    this.client = undefined;
    this.generation += 1;
    this.state = 'loading';
    if (previous !== undefined) await previous.stop();
    if (attempt !== this.#attempt) return;
    this.message = undefined;
    this.cleanupPending = false;
    const outcome = await requestSession(this.profile, this.readOnly).catch(() => undefined);
    if (attempt !== this.#attempt) return;
    if (outcome === undefined) {
      this.#fail('failed', 'The server could not be reached.');
      return;
    }
    if (!outcome.ok) {
      const refusal = outcome.refusal;
      this.#fail(
        refusal.kind === 'quarantined' ? 'cleanup-incomplete' : 'failed',
        describeRefusal(refusal),
      );
      return;
    }
    const client = new TerminalWebSocketClient({
      url: `ws://${window.location.host}/terminal?profile=${encodeURIComponent(this.profile)}`,
      sessionId: outcome.grant.sessionId,
      ticket: outcome.grant.ticket,
      requestedMode: this.readOnly ? 'read-only' : 'interactive',
      // The page is served from loopback over plain HTTP, which is the one place a plain socket is allowed.
      allowInsecureLoopback: true,
    });
    this.client = client;
    this.state = 'connecting';
    client.subscribeState((transport) => {
      if (this.client !== client) return;
      this.state = terminalStateFor(transport, client.capabilities);
      if (transport !== 'empty' && transport !== 'connecting' && transport !== 'writable') {
        void this.#settleCleanup(attempt);
      }
    });
    try {
      const capabilities = await client.connect();
      if (attempt !== this.#attempt) return;
      this.state = terminalStateFor(client.state, capabilities);
      this.#sendGeometry();
    } catch (error) {
      if (attempt !== this.#attempt) return;
      this.state = terminalStateFor(client.state, undefined);
      if (error instanceof TerminalConnectError && error.reason === 'denied') {
        this.message = 'The server refused this connection.';
      }
    }
  }

  /** Cancel a session that is still loading or connecting. Nothing is replayed or kept. */
  cancel(): void {
    this.#attempt += 1;
    this.#discardClient();
    this.cleanupPending = false;
    this.message = undefined;
    this.state = 'empty';
  }

  /** Ask the host to end the session. The result is the host's own cleanup report. */
  async end(): Promise<void> {
    const client = this.client;
    if (client === undefined) return;
    this.cleanupPending = true;
    const result = await client.stop();
    if (this.client !== client) return;
    this.cleanupPending = false;
    if (result.outcome !== 'complete') {
      this.message = 'The host could not prove the process is gone.';
      this.state = 'cleanup-incomplete';
    }
  }

  /** Drop the connection without telling the host, as a lost network would. */
  drop(): void {
    this.client?.close();
  }

  /** Ask whether the server's cleanup of the previous session has finished. */
  async checkCleanup(): Promise<void> {
    this.cleanupPending = true;
    await this.#settleCleanup(this.#attempt);
  }

  setGeometry(geometry: TerminalGeometry): void {
    this.#geometry = geometry;
    this.#sendGeometry();
  }

  #sendGeometry(): void {
    const client = this.client;
    const geometry = this.#geometry;
    if (client === undefined || geometry === undefined) return;
    if (client.state !== 'writable' || client.capabilities?.resize !== true) return;
    void client.sendResize(geometry.columns, geometry.rows);
  }

  /** Hold replacement until the server says the slot is free; a quarantined slot is the end of the road. */
  async #settleCleanup(attempt: number): Promise<void> {
    this.cleanupPending = true;
    const status = await waitForFreeSlot().catch(() => 'busy' as const);
    if (attempt !== this.#attempt) return;
    this.cleanupPending = false;
    if (status === 'quarantined') {
      this.message =
        'The server could not prove the process is gone, so it will not start another.';
      this.state = 'cleanup-incomplete';
    }
  }

  #discardClient(): void {
    const client = this.client;
    this.client = undefined;
    client?.close();
  }

  #fail(state: TerminalState, message: string): void {
    this.message = message;
    this.state = state;
  }
}
