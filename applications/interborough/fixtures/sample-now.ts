/**
 * The sample world's "now" (`tmp/design-review/decisions.md`): Monday, Nov 2, 2026, 10:46 AM in
 * Central time, the viewer's zone on every board. A design-review capture pins the browser's clock
 * and time zone to it (`tests/e2e/fixtures.ts`), so relative times ("4 min ago") and day headers
 * read as the boards draw them.
 *
 * Nov 1, 2026 is when daylight saving time ends in the United States, so on Nov 2 Central time is
 * CST, six hours behind UTC; `tests/sample-now.test.ts` checks the instant against the zone instead
 * of trusting the offset written here.
 *
 * @module sample-now
 */

/** The viewer's time zone in the sample world. */
export const SAMPLE_TIME_ZONE = 'America/Chicago';

/** The sample "now" as an ISO 8601 instant: 10:46 AM CST on Monday, Nov 2, 2026. */
export const SAMPLE_NOW = '2026-11-02T10:46:00-06:00';

/** {@link SAMPLE_NOW} in milliseconds since the epoch. */
export const SAMPLE_NOW_MILLISECONDS = Date.parse(SAMPLE_NOW);
