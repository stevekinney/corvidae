/**
 * The registry of advisories the root `audit` gate tolerates.
 *
 * An entry is a standing decision, not a convenience: it needs an owner decision, a tracking
 * issue, a review-by date, and the exact dependency chains through which the vulnerable package
 * may be reached. `scripts/check-audit-exceptions.ts` enforces every field, and fails when the
 * advisory stops reporting, when the package becomes reachable any other way, or when the
 * review-by date passes.
 */
export type AuditException = {
  /** GitHub advisory identifier, for example `GHSA-xxxx-xxxx-xxxx`. */
  readonly advisory: string;
  /** The vulnerable package name as it appears in `bun.lock`. */
  readonly package: string;
  /**
   * The only importer chains through which `package` may be reached. Each chain is consecutive
   * packages, an importer first, and every dependency path from a workspace to `package` must
   * contain one of them. When the importer is a workspace, its edge to the next package must be
   * a development dependency, so a runtime path can never match. `corvidae` is the root
   * workspace, which declares Stylelint and its `stylelint-use-logical` plugin (a peer-dependency
   * importer of Stylelint) for the repository's own lint.
   */
  readonly allowedChains: readonly (readonly string[])[];
  readonly reason: string;
  /** Linear issue that owns removing this exception. */
  readonly trackingIssue: string;
  /** Last calendar day (UTC, `YYYY-MM-DD`) the exception is valid. */
  readonly reviewBy: string;
};

export const auditExceptions: readonly AuditException[] = [
  {
    advisory: 'GHSA-vfj7-8cjw-p6xm',
    package: 'braces',
    allowedChains: [
      ['@lostgradient/cinder', 'stylelint'],
      ['corvidae', 'stylelint'],
      ['corvidae', 'stylelint-use-logical', 'stylelint'],
    ],
    reason:
      'braces <= 3.0.3 has a stack-exhaustion denial of service on deeply nested patterns and no patched release exists (upstream fix: micromatch/braces#72). It is reached only through the Stylelint development toolchain, which expands the repository’s own glob patterns and never untrusted input.',
    trackingIssue: 'COR-1423',
    reviewBy: '2026-10-31',
  },
];
