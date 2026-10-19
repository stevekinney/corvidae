/**
 * Declarative workflow documents: agent-authored JSON that Weft registers as
 * its own workflow type and runs through one interpreter, with no
 * agent-written code involved.
 *
 * @module document-workflow
 */

export { normalizeScheduleSpec } from '../core/engine/validation/schedule.ts';
export type { NormalizedScheduleSpec } from '../core/engine/validation/schedule.ts';
export {
  WorkflowDocumentValidationError,
  canonicalWorkflowDocumentJson,
  validateWorkflowDocument,
  workflowDocumentSchema,
  workflowDocumentVersion,
} from './document.ts';
export type {
  DocumentActivityArgument,
  DocumentActivityHandler,
  DocumentTriggerValidator,
  DocumentWorkflowHost,
  WorkflowDocument,
  WorkflowDocumentIssue,
  WorkflowDocumentStep,
} from './document.ts';
export { registerWorkflowDocuments } from './register.ts';
export type { RegisteredWorkflowDocument, WorkflowDocumentSet } from './register.ts';
