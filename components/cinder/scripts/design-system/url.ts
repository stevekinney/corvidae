/**
 * Each person publishes Cinder's design system to their own artifact, so its URL is per-user
 * configuration, never part of the repository: `CORVIDAE_DESIGN_SYSTEM_URL`, or else `url` in
 * `~/.config/corvidae/design-system.json`. Keeping it outside the checkout makes it work across
 * clones and worktrees.
 *
 * Usage: bun scripts/design-system/url.ts [--set <url>]
 *
 * Prints the configured URL and where it came from, or says none is set. `--set` saves a URL to
 * the configuration file.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

/** The environment variable that overrides the configuration file. */
export const URL_ENVIRONMENT_VARIABLE = 'CORVIDAE_DESIGN_SYSTEM_URL';

/** The per-user configuration file that holds `{ "url": "…" }`. */
export function configurationPath(home = homedir()): string {
  return join(home, '.config/corvidae/design-system.json');
}

const ARTIFACT_URL = /^https:\/\/claude\.ai\/(?:code\/)?artifact\/[A-Za-z0-9-]+$/;

/** Whether a value is a claude.ai artifact link. */
export function isArtifactUrl(value: string): boolean {
  return ARTIFACT_URL.test(value);
}

/** A configured URL and where it came from. */
export type ConfiguredUrl = { url: string; source: string };

/**
 * Reads the configured artifact URL: the environment variable first, then the configuration file.
 * Returns nothing when neither is set, and fails on a value that is not an artifact link or a
 * configuration file that is not `{ "url": "…" }`.
 */
export function readConfiguredUrl(
  environment: Record<string, string | undefined>,
  path: string,
): ConfiguredUrl | undefined {
  const fromEnvironment = environment[URL_ENVIRONMENT_VARIABLE]?.trim();
  if (fromEnvironment) {
    if (!isArtifactUrl(fromEnvironment)) {
      throw new Error(
        `${URL_ENVIRONMENT_VARIABLE} is not a claude.ai artifact link: ${fromEnvironment}`,
      );
    }
    return { url: fromEnvironment, source: URL_ENVIRONMENT_VARIABLE };
  }
  if (!existsSync(path)) return undefined;
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const url =
    typeof parsed === 'object' && parsed !== null && 'url' in parsed ? parsed.url : undefined;
  if (typeof url !== 'string' || !isArtifactUrl(url)) {
    throw new Error(`${path} must hold { "url": "https://claude.ai/artifact/…" }`);
  }
  return { url, source: path };
}

/** Saves an artifact URL to the configuration file, creating its directory. */
export function saveConfiguredUrl(url: string, path: string): void {
  if (!isArtifactUrl(url)) throw new Error(`not a claude.ai artifact link: ${url}`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ url }, null, 2)}\n`);
}

if (import.meta.main) {
  const { values } = parseArgs({ args: Bun.argv.slice(2), options: { set: { type: 'string' } } });
  const path = configurationPath();
  if (values.set !== undefined) {
    saveConfiguredUrl(values.set, path);
    console.log(`Saved ${values.set} to ${path}.`);
  } else {
    const configured = readConfiguredUrl(process.env, path);
    console.log(
      configured
        ? `${configured.url} (from ${configured.source})`
        : `No design-system artifact is configured. Set ${URL_ENVIRONMENT_VARIABLE}, or save one with: bun run --filter=@lostgradient/cinder design-system:url --set <url>`,
    );
  }
}
