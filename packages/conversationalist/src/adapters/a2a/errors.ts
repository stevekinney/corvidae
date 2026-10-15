import { ConversationalistError, type ConversationalistErrorCode } from '../../errors';

/**
 * Thrown when content cannot cross the A2A boundary without loss: an
 * unsupported content part, message role, or content source kind, a malformed
 * A2A part, or an `a2a-reference` that does not resolve. `kind` names the
 * offending part kind, role, or source kind so callers can branch on it.
 */
export class A2AMappingError extends ConversationalistError {
  /** The content part kind, message role, or source kind that failed to map. */
  readonly kind: string;

  constructor(
    code: Extract<ConversationalistErrorCode, 'error:validation' | 'error:not-found'>,
    kind: string,
    message: string,
    context?: Record<string, unknown>,
  ) {
    super(code, message, { context: { kind, ...context } });
    this.name = 'A2AMappingError';
    this.kind = kind;
  }
}

export function unsupportedA2AContent(kind: string, reason: string): A2AMappingError {
  return new A2AMappingError('error:validation', kind, `Cannot map ${kind} to A2A: ${reason}`);
}
