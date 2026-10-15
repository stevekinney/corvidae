import type { Capabilities } from '../protocol/messages.ts';
import type { AttachmentAuthority, AttachRequest, ProcessBackend } from './session-types.ts';

/**
 * Derive one attachment's authority on the server side. The client's requested mode and the
 * host's grant can only narrow what the session offers: a read-only request or grant, or a session
 * with no backend process, yields a read-only attachment with no input, resize or kill. A backend
 * without an input channel offers no input either. There is no path by which a client widens it,
 * and no read-only exception for automatic terminal replies. The result is deeply frozen, because
 * the session consults this same object on every operation: a holder that could edit it would be
 * editing the authority itself.
 */
export function deriveAuthority(
  generation: number,
  backend: ProcessBackend | undefined,
  request: Pick<AttachRequest, 'requestedMode' | 'grant'>,
): AttachmentAuthority {
  const readOnly =
    backend === undefined || request.requestedMode === 'read-only' || request.grant === 'read-only';
  const capabilities: Capabilities = {
    mode: backend?.mode ?? 'output-only',
    input: !readOnly && backend.acceptsInput !== false,
    resize: !readOnly && backend.mode === 'pty' && backend.resize !== undefined,
    kill: !readOnly,
    readOnly,
  };
  return Object.freeze({
    generation,
    capabilities: Object.freeze(capabilities),
    canWrite: capabilities.input || capabilities.resize,
  });
}
