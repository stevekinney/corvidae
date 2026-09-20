import { ports } from '../../scripts/browser-ports.ts';

export const FIXTURE_PORT = ports.CHAT_ROOM_FIXTURE_PORT;

export const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;

/**
 * `gated` — one text chunk, then wait for the test to release the second.
 * `hold` — one text chunk, then hold the response open until the client goes
 *   away, which is the only way to have partial content already buffered when
 *   a user-initiated abort lands.
 * `approval` — a `remember_note` tool call on the first turn (the toolbox's
 *   only tool with an approval policy), plain text on every turn after it.
 * `stepped` — three text chunks with a gate after each of the first two, so a
 *   test can observe three distinct rendered states of one reply.
 * `tool` — a `roll_dice` tool call on the first turn whose `input_json_delta`
 *   is split around a gate, so the tool-use block is genuinely still open
 *   (name known, arguments incomplete) while the test looks at the wire;
 *   plain text on every turn after it.
 */
export type FixtureScenario =
  | 'gated'
  | 'hold'
  | 'approval'
  | 'approval-long'
  | 'stepped'
  | 'tool'
  | 'ratelimited'
  | 'unauthorized'
  | 'fail-once401'
  | 'midstream';

export const GATED_FIRST_CHUNK = 'Streaming first half.';
export const GATED_SECOND_CHUNK = 'Streaming second half.';
export const HOLD_PARTIAL_TEXT = 'Partial answer before the stop.';
/** Written by the fixture before the mid-stream failure, and — verified — never rendered. */
export const MIDSTREAM_PARTIAL_TEXT = 'Here is the first half';
export const MIDSTREAM_ERROR_MESSAGE = 'The provider gave up mid-stream.';
export const APPROVAL_NOTE_TEXT = 'Ship the release notes';
/**
 * A note long enough to overflow an unbounded approval prompt.
 *
 * The tool's schema puts no length limit on `text`, so a model can propose one
 * of these — and the approval question renders the proposed arguments. Without
 * a bound on that display it grows without limit inside a fixed-viewport-height
 * column, which on a short viewport takes the transcript's space while a person
 * is still deciding. A short fixture note could never show that.
 */
export const APPROVAL_LONG_NOTE_TEXT = Array.from(
  { length: 40 },
  (_, index) => `Line ${index + 1} of a note the model decided to write at length.`,
).join(' ');
export const APPROVAL_FOLLOW_UP_TEXT = 'Saved that note.';
export const DEFAULT_REPLY_TEXT = 'Fixture default reply.';
export const STEPPED_CHUNKS = ['Step one.', 'Step two.', 'Step three.'] as const;
export const TOOL_CALL_NAME = 'roll_dice';
/** Split so the JSON is invalid at the gate — the arguments really are partial. */
export const TOOL_ARGUMENTS_FIRST_HALF = '{"sides": 6';
export const TOOL_ARGUMENTS_SECOND_HALF = ', "count": 1}';
export const TOOL_FOLLOW_UP_TEXT = 'You rolled the dice.';

/**
 * The scenario selector, embedded in the user's message.
 *
 * It travels to the fixture inside the conversation the app POSTs to
 * `/api/chat`, so the fixture can read it back out of the request body without
 * any side channel — and, because the app re-sends the whole transcript, it is
 * still there on the follow-up turn after an approval.
 */
export function fixtureMarker(scenario: FixtureScenario, marker: string): string {
  return `[fixture ${scenario} ${marker}]`;
}
