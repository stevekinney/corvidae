/**
 * The registry of advisories the root `audit` gate tolerates.
 *
 * An entry is a standing decision, not a convenience: it needs an owner decision, a tracking
 * issue, a review-by date, and the exact dependency chains through which the vulnerable package
 * may be reached. `scripts/check-audit-exceptions.ts` enforces every field, and fails when the
 * advisory stops reporting, when the package becomes reachable any other way (including a new
 * route beneath an allowed importer), when an installed instance of it is reachable from no
 * workspace, or when the review-by date passes.
 */
export type AuditException = {
  /** GitHub advisory identifier, for example `GHSA-xxxx-xxxx-xxxx`. */
  readonly advisory: string;
  /** The vulnerable package name as it appears in `bun.lock`. */
  readonly package: string;
  /**
   * The only dependency paths through which `package` may be reached. Each chain is consecutive
   * packages from an importer through to `package` itself, so it names every package between
   * them, and every dependency path from a workspace to `package` must end with one of them. A
   * chain that stops short of `package` is rejected, because it would also accept whatever its
   * last package gains later. When the importer is a workspace, its edge to the next package must
   * be a development dependency, so a runtime path can never match. `corvidae` is the root
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
      ['@lostgradient/cinder', 'stylelint', 'micromatch', 'braces'],
      ['@lostgradient/cinder', 'stylelint', 'fast-glob', 'micromatch', 'braces'],
      ['@lostgradient/cinder', 'stylelint', 'globby', 'micromatch', 'braces'],
      ['@lostgradient/cinder', 'stylelint', 'globby', 'fast-glob', 'micromatch', 'braces'],
      ['corvidae', 'stylelint', 'micromatch', 'braces'],
      ['corvidae', 'stylelint', 'fast-glob', 'micromatch', 'braces'],
      ['corvidae', 'stylelint', 'globby', 'micromatch', 'braces'],
      ['corvidae', 'stylelint', 'globby', 'fast-glob', 'micromatch', 'braces'],
      ['corvidae', 'stylelint-use-logical', 'stylelint', 'micromatch', 'braces'],
      ['corvidae', 'stylelint-use-logical', 'stylelint', 'fast-glob', 'micromatch', 'braces'],
      ['corvidae', 'stylelint-use-logical', 'stylelint', 'globby', 'micromatch', 'braces'],
      [
        'corvidae',
        'stylelint-use-logical',
        'stylelint',
        'globby',
        'fast-glob',
        'micromatch',
        'braces',
      ],
    ],
    reason:
      'braces <= 3.0.3 has a stack-exhaustion denial of service on deeply nested patterns and no patched release exists (upstream fix: micromatch/braces#72). It is reached only through the Stylelint development toolchain, which expands the repository’s own glob patterns and never untrusted input.',
    trackingIssue: 'COR-1423',
    reviewBy: '2026-10-31',
  },
];
