import { ConversationalistError } from '../../errors';

/**
 * Thrown when a message cannot cross the AG-UI boundary without loss, or when an
 * AG-UI message fails the pinned `@ag-ui/core` schema. `kind` names the offending
 * content part type, message role, or `'message'` for a schema failure, so
 * callers can branch on it.
 */
export class AGUIMappingError extends ConversationalistError {
  /** The content part type, message role, or `'message'` that failed to map. */
  readonly kind: string;

  constructor(kind: string, message: string, context?: Record<string, unknown>) {
    super('error:validation', message, { context: { kind, ...context } });
    this.name = 'AGUIMappingError';
    this.kind = kind;
  }
}

export function unsupportedAGUIContent(kind: string, reason: string): AGUIMappingError {
  return new AGUIMappingError(kind, `Cannot map ${kind} to AG-UI: ${reason}`);
}
