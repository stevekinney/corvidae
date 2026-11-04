/**
 * The clock a design-review capture pins every page to (`fixtures.ts`, the one fixture every
 * specification uses): the sample world's "now" in its viewer's time zone (`fixtures/sample-now.ts`),
 * so relative times and day headers read as the boards draw them. Outside a capture
 * (`INTERBOROUGH_DESIGN_REVIEW_CAPTURE` unset) the browser keeps the real clock and the host's zone,
 * because the specifications' hosts stamp what they hold with the real time.
 *
 * @module capture-clock
 */
import { SAMPLE_NOW, SAMPLE_TIME_ZONE } from '../../fixtures/sample-now.ts';
import { designReviewCaptureDirectory } from '../../scripts/environment-configuration.ts';

/** The instant and time zone a capture's pages run at. */
export interface CaptureClock {
  /** The instant `Date` is fixed at, as an ISO 8601 string. */
  readonly now: string;
  /** The IANA time zone the browser context renders in. */
  readonly timeZone: string;
}

/** The capture clock while a design-review capture runs, or `undefined` for an ordinary run. */
export function captureClock(
  captureDirectory: string | undefined = designReviewCaptureDirectory(),
): CaptureClock | undefined {
  return captureDirectory === undefined
    ? undefined
    : { now: SAMPLE_NOW, timeZone: SAMPLE_TIME_ZONE };
}
