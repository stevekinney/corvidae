/**
 * Keeps the parts of a phrase that read as one thing from breaking across lines.
 *
 * A line may break at any ordinary space, so a time written into a sentence ("from 4:12 PM.") can
 * leave "PM." alone on the next line. A non-breaking space between the parts holds them together.
 */

const NON_BREAKING_SPACE = ' ';

/**
 * Puts a non-breaking space between a time and its AM or PM, so the pair never splits. The marker
 * may be written AM, PM, am, pm, a.m. or p.m.; a time written with the narrow no-break space of
 * `Intl` is left as it is.
 *
 * @param text - A sentence or phrase that may hold a time
 * @returns The same text with each time's marker joined to it
 */
export function keepTimeTogether(text: string): string {
  return text.replace(
    /(\d) +(?=(?:[AaPp]\.?[Mm]\.?)(?![\p{L}\p{N}]))/gu,
    `$1${NON_BREAKING_SPACE}`,
  );
}

/**
 * Joins every word of a short phrase (a date such as `Nov 3`) with non-breaking spaces, so the
 * phrase wraps as one unit or not at all.
 *
 * @param text - The phrase to hold together
 * @returns The phrase with each ordinary space made non-breaking
 */
export function keepPhraseTogether(text: string): string {
  return text.replaceAll(' ', NON_BREAKING_SPACE);
}
