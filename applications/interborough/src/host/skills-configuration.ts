/**
 * The `skills` key of `configuration.json` (COR-1818): where the host looks for executable Agent
 * Skills, and which of those places it trusts.
 *
 * ```json
 * {
 *   "skills": {
 *     "sources": [{ "id": "home", "kind": "user", "path": "/Users/me/.agents/skills" }],
 *     "trusted": ["home"]
 *   }
 * }
 * ```
 *
 * A source is a directory whose subdirectories are skills. Its `kind` is `user` or `project`; the
 * other kinds Bureau knows (`built-in`, `remote`, `storage`) are not configured from a file. A
 * source is trusted only when `trusted` lists its `id`: configuring a directory is not trusting it,
 * for either kind, so a person decides once per directory and the choice is written here. The key
 * is optional and an absent key means no skills, so a file written before the key existed loads
 * unchanged. Every other key of the file is left alone.
 *
 * @module skills-configuration
 */

import { isAbsolute } from 'node:path';

import {
  admitSources,
  DEFAULT_SOURCE_PRECEDENCE,
  type SkillSource,
  type SkillTrustPolicy,
} from '@lostgradient/bureau/skills';

import { ProviderConfigurationError } from './provider-configuration-error.ts';

/** The kinds of skill source a configuration file names. */
export type ConfiguredSkillSourceKind = 'user' | 'project';

/** One configured skill source. */
export type ConfiguredSkillSource = {
  /** The source's identifier: letters, digits, `.`, `_` and `-`, starting with a letter or digit. Unique in the file. */
  readonly id: string;
  /** `user` for a directory the person installed skills in, `project` for a workspace's own. */
  readonly kind: ConfiguredSkillSourceKind;
  /** The directory whose subdirectories are skills. An absolute path. */
  readonly path: string;
};

/** The parsed `skills` key. */
export type SkillsConfiguration = {
  /** The configured sources, in the order the file lists them. */
  readonly sources: readonly ConfiguredSkillSource[];
  /** The identifiers of the sources the file trusts, each naming a configured source, without repeats. */
  readonly trusted: readonly string[];
};

/** What an absent `skills` key means: no source, so no skill. */
export const NO_SKILLS: SkillsConfiguration = Object.freeze({ sources: [], trusted: [] });

const SOURCE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KINDS: readonly ConfiguredSkillSourceKind[] = ['user', 'project'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  location: string,
  field: string,
): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      throw new ProviderConfigurationError(location, `${field}.${key}`, 'not a known field.');
    }
  }
}

function parseSource(entry: unknown, location: string, field: string): ConfiguredSkillSource {
  if (!isPlainObject(entry)) {
    throw new ProviderConfigurationError(location, field, 'expected an object.');
  }
  rejectUnknownKeys(entry, ['id', 'kind', 'path'], location, field);
  const { id, kind, path } = entry;
  if (typeof id !== 'string' || !SOURCE_IDENTIFIER.test(id)) {
    throw new ProviderConfigurationError(
      location,
      `${field}.id`,
      'expected 1 to 64 letters, digits, dots, underscores or hyphens, starting with a letter or digit.',
    );
  }
  const configuredKind = KINDS.find((candidate) => candidate === kind);
  if (configuredKind === undefined) {
    throw new ProviderConfigurationError(
      location,
      `${field}.kind`,
      `expected ${KINDS.join(' or ')}.`,
    );
  }
  if (typeof path !== 'string' || path === '' || path.includes('\0') || !isAbsolute(path)) {
    throw new ProviderConfigurationError(location, `${field}.path`, 'expected an absolute path.');
  }
  return { id, kind: configuredKind, path };
}

/**
 * Check the `skills` key of the parsed configuration, `value` being what the file holds under it
 * (`undefined` when it holds none). `location` names the file in an error. The message names the
 * field and never repeats a value.
 */
export function parseSkillsConfiguration(value: unknown, location: string): SkillsConfiguration {
  if (value === undefined) return NO_SKILLS;
  if (!isPlainObject(value)) {
    throw new ProviderConfigurationError(location, 'skills', 'expected an object.');
  }
  rejectUnknownKeys(value, ['sources', 'trusted'], location, 'skills');
  const declared = value['sources'] ?? [];
  if (!Array.isArray(declared)) {
    throw new ProviderConfigurationError(location, 'skills.sources', 'expected a list.');
  }
  const sources = declared.map((entry: unknown, index) =>
    parseSource(entry, location, `skills.sources[${index}]`),
  );
  const seen = new Set<string>();
  for (const [index, source] of sources.entries()) {
    if (seen.has(source.id)) {
      throw new ProviderConfigurationError(
        location,
        `skills.sources[${index}].id`,
        'another source has this identifier.',
      );
    }
    seen.add(source.id);
  }
  const listed = value['trusted'] ?? [];
  if (!Array.isArray(listed)) {
    throw new ProviderConfigurationError(location, 'skills.trusted', 'expected a list.');
  }
  const trusted: string[] = [];
  for (const [index, entry] of listed.entries()) {
    if (typeof entry !== 'string' || !seen.has(entry)) {
      throw new ProviderConfigurationError(
        location,
        `skills.trusted[${index}]`,
        'expected the identifier of a configured source.',
      );
    }
    if (!trusted.includes(entry)) trusted.push(entry);
  }
  return { sources, trusted };
}

/**
 * The `skills` key of a configuration file's text: `NO_SKILLS` for a file that is not there
 * (`undefined`) or has no such key. A file that is not a JSON object is refused.
 */
export function readSkillsConfiguration(
  text: string | undefined,
  location: string,
): SkillsConfiguration {
  if (text === undefined) return NO_SKILLS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ProviderConfigurationError(location, 'the file', 'it is not valid JSON.');
  }
  if (!isPlainObject(parsed)) {
    throw new ProviderConfigurationError(location, 'the file', 'expected a JSON object.');
  }
  return parseSkillsConfiguration(parsed['skills'], location);
}

/** Bureau's skill sources for the configured ones, each at the default precedence of its kind. */
export function toSkillSources(configuration: SkillsConfiguration): SkillSource[] {
  return configuration.sources.map((source) => ({
    id: source.id,
    kind: source.kind,
    location: source.path,
    precedence: DEFAULT_SOURCE_PRECEDENCE[source.kind],
  }));
}

/**
 * The trust policy for a configuration: `admitSources` over `trusted`, and an explicit
 * `untrusted` for every other configured source. Bureau's default would trust a `user` source
 * nobody listed, which would leave a person no way to withhold trust from one.
 */
export function trustPolicyOf(configuration: SkillsConfiguration): SkillTrustPolicy {
  const admitted = admitSources(configuration.trusted);
  return {
    decide: (source) =>
      admitted.decide(source) ?? {
        state: 'untrusted',
        reason: `Source '${source.id}' is not listed in skills.trusted.`,
      },
  };
}
