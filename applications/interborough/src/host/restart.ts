/**
 * What the host and its supervisor agree on for a restart. A person (or a page) asks the host to
 * restart with `POST /host/restart`; the host answers, stops, and exits with
 * {@link RESTART_EXIT_CODE}, and the supervisor (`supervisor.ts`) answers that code, and no other,
 * by starting the host again.
 *
 * @module restart
 */

/**
 * The exit code that means "start me again". It is `EX_TEMPFAIL` from `sysexits.h`: a failure the
 * next attempt is expected to clear. Any other code, zero included, ends the supervisor.
 */
export const RESTART_EXIT_CODE = 75;

/** The route that restarts the host: a `POST`, answered `202` before the host stops. */
export const HOST_RESTART_ROUTE = '/host/restart';
