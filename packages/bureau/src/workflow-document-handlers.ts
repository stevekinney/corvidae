/**
 * COR-1871 — where a workflow document's names cross between Bureau's form and Weft's: each
 * activity step's handler, and the document's own `name`, which a plugin's workflow file carries
 * as `plugin:name`. A file and a stored revision keep the names a document was written with
 * (`linear:sync-issue`); Weft only ever sees the mapped name (`linear__sync-issue`), because its
 * name grammar has no `:`.
 */
import {
  validateWorkflowDocument,
  WorkflowDocumentValidationError,
  type DocumentWorkflowHost,
  type WorkflowDocument,
  type WorkflowDocumentIssue,
  type WorkflowDocumentStep,
} from '@lostgradient/weft';

import { bureauNameOf, handlerNameIssue, weftNameOf } from './namespaced-identifier';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `versions` with every key (a handler name) rewritten by `rename`; the values are untouched. */
function renameVersionKeys<TValue>(
  versions: Readonly<Record<string, TValue>>,
  rename: (handler: string) => string,
): Record<string, TValue> {
  return Object.fromEntries(Object.entries(versions).map(([key, value]) => [rename(key), value]));
}

/**
 * `document` with its `name`, every activity step's handler, and the handlers its
 * `activityVersions` pins, rewritten by `rename`.
 */
function renameHandlers(
  document: WorkflowDocument,
  rename: (handler: string) => string,
): WorkflowDocument {
  return {
    ...document,
    name: rename(document.name),
    steps: document.steps.map((step): WorkflowDocumentStep =>
      step.kind === 'activity' ? { ...step, handler: rename(step.handler) } : step,
    ),
    ...(document.activityVersions === undefined
      ? {}
      : { activityVersions: renameVersionKeys(document.activityVersions, rename) }),
  };
}

/** The document Weft receives: a `plugin:name` name or handler becomes `plugin__name`. */
export function toWeftDocument(document: WorkflowDocument): WorkflowDocument {
  return renameHandlers(document, weftNameOf);
}

/** `document`, as Weft returned or validated it, in Bureau's form: `plugin__name` becomes `plugin:name`. */
export function fromWeftDocument(document: WorkflowDocument): WorkflowDocument {
  return renameHandlers(document, bureauNameOf);
}

/**
 * `input`, which claims to be a document in Bureau's form but is not yet validated, with its
 * `name` and each activity step's `handler` that are strings mapped to Weft's form. Anything else
 * is left for Weft's own schema to refuse. Read a stored or received document through this before
 * Weft's `workflowDocumentSchema` judges it, because that schema holds names to Weft's grammar.
 */
export function toWeftDocumentInput(input: unknown): unknown {
  if (!isRecord(input)) return input;
  const mapped: Record<string, unknown> = { ...input };
  if (typeof input['name'] === 'string') mapped['name'] = weftNameOf(input['name']);
  if (Array.isArray(input['steps'])) {
    mapped['steps'] = input['steps'].map((step: unknown) =>
      isRecord(step) && step['kind'] === 'activity' && typeof step['handler'] === 'string'
        ? { ...step, handler: weftNameOf(step['handler']) }
        : step,
    );
  }
  if (isRecord(input['activityVersions'])) {
    mapped['activityVersions'] = renameVersionKeys(input['activityVersions'], weftNameOf);
  }
  return mapped;
}

/**
 * Validate `input` as a workflow document in Bureau's form, against `host` (whose activities are
 * keyed by Weft's names). A bare handler containing `__` is refused. The result keeps the
 * `plugin:name` name and handler names the document was written with. Throws
 * {@link WorkflowDocumentValidationError}, listing every problem found.
 */
export function validateBureauWorkflowDocument(
  input: unknown,
  host: DocumentWorkflowHost,
): WorkflowDocument {
  const issues: WorkflowDocumentIssue[] = [];
  let prepared = input;
  if (isRecord(input) && Array.isArray(input['steps'])) {
    const steps: unknown[] = input['steps'].map((step: unknown, index) => {
      if (!isRecord(step) || step['kind'] !== 'activity' || typeof step['handler'] !== 'string') {
        return step;
      }
      const problem = handlerNameIssue(step['handler']);
      if (problem !== undefined) {
        issues.push({ path: `steps[${String(index)}].handler`, message: problem });
        return step;
      }
      return { ...step, handler: weftNameOf(step['handler']) };
    });
    prepared = { ...input, steps };
  }
  if (isRecord(prepared) && typeof prepared['name'] === 'string') {
    prepared = { ...prepared, name: weftNameOf(prepared['name']) };
  }
  if (isRecord(prepared) && isRecord(prepared['activityVersions'])) {
    prepared = {
      ...prepared,
      activityVersions: renameVersionKeys(prepared['activityVersions'], weftNameOf),
    };
  }
  let document: WorkflowDocument | undefined;
  try {
    document = validateWorkflowDocument(prepared, host);
  } catch (error) {
    if (!(error instanceof WorkflowDocumentValidationError)) throw error;
    issues.push(...error.issues);
  }
  if (issues.length > 0) throw new WorkflowDocumentValidationError(issues);
  // `document` is set whenever no issue was recorded.
  return fromWeftDocument(document!);
}
