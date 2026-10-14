import type { Capabilities, RequestedMode } from './messages.ts';
import type { FailureReason } from './protocol-failure.ts';

/**
 * Check the invariants every capability set must hold, and, when the mode the client asked for is
 * known, that the host did not grant more than was asked. Returns the broken rule, or `undefined`.
 *
 * - An output-only source advertises no input, resize, or kill.
 * - A pipe has no terminal to resize.
 * - A read-only attachment accepts neither input nor resize.
 * - A client that asked for read-only never receives a writable attachment.
 */
export function validateCapabilities(
  capabilities: Capabilities,
  requestedMode?: RequestedMode,
): FailureReason | undefined {
  if (
    capabilities.mode === 'output-only' &&
    (capabilities.input || capabilities.resize || capabilities.kill)
  ) {
    return 'invalid-capabilities';
  }
  if (capabilities.mode === 'pipe' && capabilities.resize) return 'invalid-capabilities';
  if (capabilities.readOnly && (capabilities.input || capabilities.resize)) {
    return 'invalid-capabilities';
  }
  if (requestedMode === 'read-only' && !capabilities.readOnly) return 'invalid-capabilities';
  return undefined;
}

/** Which output channels a mode may produce: a PTY has one stream, a pipe keeps stdout and stderr apart. */
export function channelsForMode(mode: Capabilities['mode']): readonly string[] {
  if (mode === 'pty') return ['pty'];
  if (mode === 'pipe') return ['stdout', 'stderr'];
  return ['stdout'];
}
