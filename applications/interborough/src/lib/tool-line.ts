/**
 * The one line a tool row shows. A tool's `description` is the prompt the model reads: it can run to
 * several paragraphs about derived identifiers and conflicts, which is not help for a person
 * choosing which tools an agent may call. A tool that declares `metadata.shortDescription` (Armorer,
 * `readToolShortDescription`) has a line written for a person; one that does not shows its
 * description cut down to {@link TOOL_LINE_LIMIT} characters. Either way the full description stays
 * one disclosure away, so nothing the model is told is hidden from the person who chose the tool.
 */

/** The most characters a tool row shows before the person expands it. */
export const TOOL_LINE_LIMIT = 120;

/**
 * The one line a tool row shows and whether the tool's description holds more than that line does.
 */
export type ToolLine = {
  /** At most {@link TOOL_LINE_LIMIT} characters, on one line. */
  readonly line: string;
  /** Whether the description holds more than the line does. */
  readonly expandable: boolean;
};

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function cutTo(text: string, limit: number): string {
  const characters = Array.from(text);
  if (characters.length <= limit) return text;
  return `${characters
    .slice(0, limit - 1)
    .join('')
    .trimEnd()}…`;
}

/** The line to show for a tool, and whether its description says more than the line does. */
export function toolLine(tool: {
  readonly description: string;
  readonly shortDescription: string | null;
}): ToolLine {
  const declared = tool.shortDescription === null ? '' : oneLine(tool.shortDescription);
  const source = declared === '' ? oneLine(tool.description) : declared;
  const line = cutTo(source, TOOL_LINE_LIMIT);
  return { line, expandable: tool.description.trim() !== line };
}
