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
   * workspace.
   */
  readonly allowedChains: readonly (readonly string[])[];
  /**
   * A reviewed, complete workspace-rooted reachability inventory for a tooling-only exception.
   * It binds readable allowed chains to the exact lockfile graph they reviewed, including every
   * workspace prefix, edge kind and installed package identity.
   */
  readonly reviewedReachability?: {
    readonly sha256: string;
    readonly exposure: 'build-or-development-only';
  };
  readonly reason: string;
  /** Linear issue that owns removing this exception. */
  readonly trackingIssue: string;
  /** Last calendar day (UTC, `YYYY-MM-DD`) the exception is valid. */
  readonly reviewBy: string;
};

export const auditExceptions: readonly AuditException[] = [
  {
    advisory: 'GHSA-fc5q-39xc-vjpf',
    package: 'picomatch',
    allowedChains: [
      ['@lostgradient/environmentalist', 'ts-morph', '@ts-morph/common', 'tinyglobby', 'picomatch'],
      ['@lostgradient/playground', 'ts-morph', '@ts-morph/common', 'tinyglobby', 'picomatch'],
      ['@lostgradient/cinder', 'ts-morph', '@ts-morph/common', 'tinyglobby', 'picomatch'],
    ],
    reviewedReachability: {
      sha256: '7b6b31f61063bb59be476cbd6affd28a37d670973016e1a265e0c2559f536dc9',
      exposure: 'build-or-development-only',
    },
    reason:
      'picomatch 4.0.4 is only in reviewed static-export, type-generation and developer-check tooling; no inspected caller passes request-controlled globs. The frozen workspace inventory binds all current paths, including runtime-classified manifest edges, to this decision.',
    trackingIssue: 'COR-2515',
    reviewBy: '2026-12-17',
  },
];
