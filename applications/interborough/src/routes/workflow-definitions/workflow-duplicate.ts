/**
 * Duplicate, on a workflow's "⋯" menu: a new workflow file with the same document under a new
 * identifier, written with `bureau.workflows.create`, which the Bureau writes and registers before
 * it answers. The copy is written paused, so a copy of a scheduled or signalled workflow does not
 * start a second run of everything its original runs the moment it exists; it is resumed from its
 * own page. Its identifier is the original's with `-copy` after it, then `-copy-2` and on while
 * the Bureau answers that one is taken, cut to the Bureau's 64 characters.
 */
import { WORKFLOW_COPY } from '../../app/copy.ts';
import {
  createWorkflowFile,
  isIdentifierTaken,
  updateDefinitionFromText,
  type WorkflowWriteResult,
} from '../../lib/workflow-files.ts';

/** The longest identifier the Bureau takes. */
const IDENTIFIER_MAXIMUM_LENGTH = 64;
/** How many identifiers a duplicate tries before it says every one is taken. */
export const DUPLICATE_ATTEMPTS = 9;

/**
 * The identifier the `attempt`th try at a copy of `id` takes, counted from one: `id-copy`, then
 * `id-copy-2` and on. The original is cut, never the suffix, and never so it ends in a hyphen.
 */
export function duplicateIdentifier(id: string, attempt: number): string {
  const suffix = attempt <= 1 ? '-copy' : `-copy-${String(attempt)}`;
  const base = id.slice(0, IDENTIFIER_MAXIMUM_LENGTH - suffix.length).replace(/-+$/, '');
  return `${base}${suffix}`;
}

/**
 * The definition a copy is written with: the original's document, without its `name` (the Bureau
 * sets it from the identifier), paused, and titled as a copy when the original has a title.
 * `undefined` when the text is not a document an update could send.
 */
export function duplicateDefinition(
  text: string,
  title: string | null,
): Record<string, unknown> | undefined {
  const parsed = updateDefinitionFromText(text);
  if (!parsed.ok) return undefined;
  const named =
    title === null || title.trim() === ''
      ? {}
      : { title: WORKFLOW_COPY.page.menu.copyTitle(title) };
  return { ...parsed.definition, ...named, paused: true };
}

/** A duplicate that could not be written for a reason of its own, in the page's words. */
export class DuplicateRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DuplicateRefused';
  }
}

/**
 * Writes a copy of the workflow file `id` from its `text`, trying each identifier in turn while the
 * Bureau answers that it is taken. Any other refusal is the Bureau's, and is thrown as it came.
 */
export async function duplicateWorkflowFile(
  id: string,
  text: string,
  title: string | null,
  write: typeof createWorkflowFile = createWorkflowFile,
): Promise<WorkflowWriteResult> {
  const definition = duplicateDefinition(text, title);
  if (definition === undefined) throw new DuplicateRefused(WORKFLOW_COPY.page.menu.duplicateFailed);
  for (let attempt = 1; attempt <= DUPLICATE_ATTEMPTS; attempt += 1) {
    try {
      return await write(duplicateIdentifier(id, attempt), definition);
    } catch (error) {
      if (!isIdentifierTaken(error)) throw error;
    }
  }
  throw new DuplicateRefused(WORKFLOW_COPY.page.menu.duplicateTaken(id));
}
