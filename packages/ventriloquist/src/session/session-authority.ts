import type { Capabilities } from '../protocol/messages.ts';
import type { AttachmentAuthority, AttachRequest, ProcessBackend } from './session-types.ts';

/**
 * Derive one attachment's authority on the server side. The client's requested mode and the
 * host's grant can only narrow what the session offers: a read-only request or grant, or a session
 * with no backend process, yields a read-only attachment with no input, resize or kill. There is no
 * path by which a client widens it, and no read-only exception for automatic terminal replies.
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
    input: !readOnly,
    resize: !readOnly && backend.mode === 'pty' && backend.resize !== undefined,
    kill: !readOnly,
    readOnly,
  };
  return { generation, capabilities, canWrite: capabilities.input || capabilities.resize };
}
