/**
 * The environment Vercel gives the playground's Ignored Build Step (`ignore-build.ts`).
 *
 * Unlike the repository's other environment-configuration modules, this one reads `process.env`
 * directly instead of through `@lostgradient/environmentalist`: Vercel runs the ignore step before
 * `bun install`, so nothing outside Bun and Node built-ins can be imported here.
 */
export type IgnoreStepEnvironment = {
  /** `production`, `preview`, or `development`. */
  readonly vercelEnvironment: string | undefined;
  readonly commitMessage: string | undefined;
  /** The commit of the branch's last successful deployment; empty on its first deployment. */
  readonly previousSha: string | undefined;
  readonly commitSha: string | undefined;
};

export function ignoreStepEnvironment(): IgnoreStepEnvironment {
  return {
    vercelEnvironment: process.env['VERCEL_ENV'],
    commitMessage: process.env['VERCEL_GIT_COMMIT_MESSAGE'],
    previousSha: process.env['VERCEL_GIT_PREVIOUS_SHA'],
    commitSha: process.env['VERCEL_GIT_COMMIT_SHA'],
  };
}
