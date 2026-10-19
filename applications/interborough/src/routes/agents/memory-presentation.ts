/** How the Memory page words a memory's facts. */

/** The words for `value` from `words`, or the value itself when the Bureau names one the page does not know. */
export function labelFor(words: Readonly<Record<string, string>>, value: string): string {
  return words[value] ?? value;
}

/** A memory's creation time in the reader's own locale, or the Bureau's text when it is not a date. */
export function formatMemoryTime(iso: string): string {
  const time = new Date(iso);
  return Number.isNaN(time.getTime()) ? iso : time.toLocaleString();
}
