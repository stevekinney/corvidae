/**
 * COR-1871 — where a workflow document's handler names cross between Bureau's form and Weft's.
 * A file and a stored revision keep the name a document was written with (`linear:sync-issue`);
 * Weft only ever sees the mapped name (`linear__sync-issue`), because its name grammar has no `:`.
 */
import {
  validateWorkflowDocument,
  WorkflowDocumentValidationError,
  type DocumentWorkflowHost,
  type WorkflowDocument,
  type WorkflowDocumentIssue,
  type WorkflowDocumentStep,
} from '@lostgradient/weft';

import { fromWeftHandlerName, handlerNameIssue, weftHandlerNameOf } from './namespaced-identifier';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `document` with every activity step's handler rewritten by `rename`. */
function renameHandlers(
  document: WorkflowDocument,
  rename: (handler: string) => string,
): WorkflowDocument {
  return {
    ...document,
    steps: document.steps.map((step): WorkflowDocumentStep =>
      step.kind === 'activity' ? { ...step, handler: rename(step.handler) } : step,
    ),
  };
}

/** The document Weft receives: each `plugin:name` handler becomes `plugin__name`. */
export function toWeftDocument(document: WorkflowDocument): WorkflowDocument {
  return renameHandlers(document, weftHandlerNameOf);
}

/**
 * Validate `input` as a workflow document in Bureau's form, against `host` (whose activities are
 * keyed by Weft's names). A bare handler containing `__` is refused. The result keeps the
 * `plugin:name` handler names the document was written with. Throws
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
      return { ...step, handler: weftHandlerNameOf(step['handler']) };
    });
    prepared = { ...input, steps };
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
  return renameHandlers(document!, (handler) => fromWeftHandlerName(handler) ?? handler);
}
