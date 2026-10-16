/**
 * Evidence in the memory-lifecycle suite states facts as `Slot: value`
 * sentences, such as `Shipping address: 17 Cedar Lane, Olympia.` The
 * lifecycle architecture's state projector and the reference policy both
 * read evidence through this one parser, so neither has a private oracle for
 * what a record says: a record states a slot only when its first sentence
 * does.
 */

/** One `Slot: value` statement. `slot` is normalized; `value` is verbatim. */
export interface Statement {
  readonly slot: string;
  readonly value: string;
}

const STATEMENT = /^([A-Za-z][A-Za-z' -]*?)\s*:\s*(\S.*)$/;

/** Lower case, single spaces: how two spellings of one slot compare equal. */
export function normalizeSlot(slot: string): string {
  return slot.trim().toLowerCase().replaceAll(/\s+/g, ' ');
}

/**
 * The statement `content`'s first sentence makes, or `undefined` when it
 * makes none. A sentence ends at a period followed by whitespace, so a value
 * such as `84.20 USD` keeps its decimal point, and the first sentence's own
 * closing period is not part of the value.
 */
export function parseStatement(content: string): Statement | undefined {
  const [first] = content.trim().split(/(?<=\.)\s+/);
  const match = STATEMENT.exec(first!.replace(/\.$/, ''));
  if (match === null) return undefined;
  return { slot: normalizeSlot(match[1]!), value: match[2]!.trim() };
}
