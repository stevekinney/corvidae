/**
 * What the host and its supervisor agree on for a restart. A person (or a page) asks the host to
 * restart with `POST /host/restart`; the host answers, stops, and exits with
 * {@link RESTART_EXIT_CODE}, and the supervisor (`supervisor.ts`) answers that code, and no other,
 * by starting the host again.
 *
 * `GET /host/restart` reports {@link HostRestartStanding}: whether the host can restart at all,
 * and the terminal command it was launched with (COR-2009). A page reads it while the host
 * answers, because a restart that never comes back leaves the page nothing to ask.
 *
 * @module restart
 */

import type { LaunchCommand } from './launch-command.ts';

/**
 * The exit code that means "start me again". It is `EX_TEMPFAIL` from `sysexits.h`: a failure the
 * next attempt is expected to clear. Any other code, zero included, ends the supervisor.
 */
export const RESTART_EXIT_CODE = 75;

/** The route that restarts the host: a `POST`, answered `202` before the host stops. */
export const HOST_RESTART_ROUTE = '/host/restart';

/** What `GET /host/restart` answers. */
export type HostRestartStanding = {
  /** Whether `POST /host/restart` restarts this host: only a host its supervisor started can. */
  readonly available: boolean;
  /**
   * The terminal command this host was launched with and its directory, recorded by the supervisor
   * when it started, or `null` for a host no supervisor started.
   */
  readonly launch: LaunchCommand | null;
};
