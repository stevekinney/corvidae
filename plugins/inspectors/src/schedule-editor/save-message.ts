/**
 * What the page says when a save stops (COR-2545), in the words of what a person asked for and
 * never in a tool's name or a fault's own wording on its own: which part landed, which did not, and
 * what to do next. A refused save that has a field to blame says so once, on the field, and the page
 * says only to fix the fields. Plain code with its own tests; `app.ts` puts it in the status line.
 */
import type { SaveOutcome } from './save.ts';

/** What a call of a save did once it was written. */
const LANDED = new Map<string, string>([
  ['bureau.schedules.create', 'Created the schedule.'],
  ['bureau.schedules.update', 'Saved the changes.'],
  ['bureau.schedules.pause', 'Paused it.'],
  ['bureau.schedules.resume', 'Resumed it.'],
]);

/** What a call of a save is doing, as a sentence begins. */
const DOING = new Map<string, string>([
  ['bureau.schedules.create', 'Creating the schedule'],
  ['bureau.schedules.update', 'Saving the changes'],
  ['bureau.schedules.pause', 'Pausing it'],
  ['bureau.schedules.resume', 'Resuming it'],
]);

/** The page's one answer to a refused save that has fields to blame: the fields say the rest. */
export const FIX_THE_FIELDS = 'Fix the fields that show a problem.';

/** What a refused save says when the schedule changed since the form read it. */
const CHANGED_SINCE_OPENED =
  'The schedule changed since it was opened. Read it again, then make the change again.';

/** What the page says of a create the host never answered: it may or may not have been made. */
const CREATE_NOT_ANSWERED =
  'The host did not answer, so the schedule may or may not have been made. Look at the list before trying again.';

/** `text` with its first letter capital and a full stop at its end, whatever it came with. */
function asSentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const capital = `${trimmed.charAt(0).toUpperCase()}${trimmed.slice(1)}`;
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

function lowerFirst(text: string): string {
  return `${text.charAt(0).toLowerCase()}${text.slice(1)}`;
}

/** The words of a fault that say a step failed without saying why. */
const BARE_FAILURE_WORDS = new Set(['failed', 'failure', 'error', 'unsuccessful']);

/**
 * Whether a fault's message says nothing beyond that the step failed: it is empty, a bare "Failed",
 * or only repeats the verb the sentence already holds ("Pausing it failed"). `doing` is that
 * sentence's verb phrase, such as "Pausing it".
 */
function isEmptyReason(message: string, doing: string): boolean {
  const words = (text: string) => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
  const repeated = new Set(words(doing));
  return words(message).every((word) => BARE_FAILURE_WORDS.has(word) || repeated.has(word));
}

/** The sentences that say which calls of a save were written before it stopped, or none. */
function landed(done: readonly string[]): string {
  return done.map((tool) => LANDED.get(tool) ?? '').join(' ');
}

/** `parts` joined by one space, with nothing between where a part is empty. */
function joined(...parts: readonly string[]): string {
  return parts.filter((part) => part !== '').join(' ');
}

/**
 * What the status line says of a save that did not finish. `outcome` is how it stopped, and `stale`
 * says the Bureau refused it because the schedule changed since the form read it.
 */
export function saveMessage(
  outcome: Exclude<SaveOutcome, { kind: 'saved' }>,
  stale: boolean,
): string {
  const before = landed(outcome.done);
  if (outcome.kind === 'refused') {
    const doing = DOING.get(outcome.tool) ?? 'The last step';
    const hasFields = Object.keys(outcome.fault.fields).length > 0;
    if (stale) {
      return before === ''
        ? `Not saved. ${CHANGED_SINCE_OPENED}`
        : `${before} ${doing} failed. ${CHANGED_SINCE_OPENED}`;
    }
    if (hasFields) {
      return before === ''
        ? `Not saved. ${FIX_THE_FIELDS}`
        : `${before} ${doing} failed. ${FIX_THE_FIELDS}`;
    }
    // A fault that says nothing the sentence has not said ("Failed") adds no reason clause.
    const reason = isEmptyReason(outcome.fault.message, doing)
      ? ''
      : asSentence(outcome.fault.message);
    if (reason === '') return before === '' ? 'Not saved.' : `${before} ${doing} failed.`;
    return before === '' ? `Not saved: ${reason}` : `${before} ${doing} failed: ${reason}`;
  }
  const doing = DOING.get(outcome.tool) ?? 'The last step';
  if (outcome.kind === 'unreadable') {
    return joined(before, `${doing} did not finish: the answer could not be read.`);
  }
  if (outcome.id === undefined) return CREATE_NOT_ANSWERED;
  return joined(
    before,
    `The host did not answer while ${lowerFirst(doing)}. The form was read again to show what the schedule holds. Check it before saving again.`,
  );
}
