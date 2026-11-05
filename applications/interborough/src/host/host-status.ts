import type { HostDiagnostics } from './host-diagnostics.ts';

/** The guarded route that reports stable deployment and per-process host identity. */
export const HOST_STATUS_ROUTE = '/host/status';

/** Identity and credential-free diagnostics for one running host process. */
export type HostStatus = {
  /** Stable Bungalow deployment identity. */
  readonly deploymentId: string;
  /** Opaque identity for this host process incarnation. */
  readonly incarnationId: string;
  /** Credential-free point-in-time host diagnostics. */
  readonly diagnostics: HostDiagnostics;
};
