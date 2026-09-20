import type { SkillConformanceCode } from '../../src/conformance';

/**
 * The pinned Agent Skills conformance corpus.
 *
 * One fixture per rule the reference validator enforces at
 * `AGENT_SKILLS_SPECIFICATION_REVISION`, written as real `SKILL.md` documents so the same corpus
 * drives two checks: this package's strict validation, and — when the official Python validator is
 * available — the reference implementation itself. A fixture that only exercised this package's
 * own types could not do the second job, which is the whole point of pinning.
 *
 * Upgrading the pin requires diffing this corpus against the new revision. That is the explicit
 * fixture diff the compatibility policy demands, not a formality.
 */
export interface ConformanceFixture {
  /** Stable identifier, used in test names and as the materialized directory's parent. */
  readonly id: string;
  /** The directory the skill lives in; the specification requires `name` to equal it. */
  readonly directoryName: string;
  /** Complete `SKILL.md` content. */
  readonly skillMarkdown: string;
  /** Whether the reference validator accepts this fixture. */
  readonly valid: boolean;
  /** For invalid fixtures, every code this package must report. */
  readonly expectedCodes?: readonly SkillConformanceCode[];
  /** Why the fixture exists, when that is not obvious from its name. */
  readonly rationale?: string;
  /**
   * Set when this package knowingly disagrees with the reference validator.
   *
   * A divergence recorded here is asserted as a divergence — the cross-check proves the
   * disagreement is exactly the one described, and fails if it ever closes or widens silently. The
   * alternative, leaving the case out of the corpus, is how a parity claim ends up true only of
   * the cases nobody wrote down.
   */
  readonly knownDivergence?: {
    /** What the reference validator does. */
    readonly reference: 'accepts' | 'rejects';
    /** Why this package does something else. */
    readonly reason: string;
  };
}

function skill(frontmatterLines: readonly string[], body = 'Do the thing.'): string {
  return ['---', ...frontmatterLines, '---', '', body, ''].join('\n');
}

const SIXTY_FOUR_CHARACTER_NAME = 'a'.repeat(64);
const SIXTY_FIVE_CHARACTER_NAME = 'a'.repeat(65);
const MAXIMUM_DESCRIPTION = 'd'.repeat(1024);
const OVERLONG_DESCRIPTION = 'd'.repeat(1025);
const MAXIMUM_COMPATIBILITY = 'c'.repeat(500);
const OVERLONG_COMPATIBILITY = 'c'.repeat(501);

export const CONFORMANCE_CORPUS: readonly ConformanceFixture[] = [
  {
    id: 'minimal',
    directoryName: 'simple-skill',
    skillMarkdown: skill(['name: simple-skill', 'description: A simple skill for testing.']),
    valid: true,
  },
  {
    id: 'all-optional-fields',
    directoryName: 'pdf-processing',
    skillMarkdown: skill([
      'name: pdf-processing',
      'description: Extract PDF text, fill forms, merge files. Use when handling PDFs.',
      'license: Apache-2.0',
      'compatibility: Requires git, docker, jq, and access to the internet',
      'allowed-tools: Bash(git:*) Bash(jq:*) Read',
      'metadata:',
      '  author: example-org',
      '  version: "1.0"',
    ]),
    valid: true,
    rationale:
      "Taken from the specification's own examples, including the parenthesized tool requests that a comma split would destroy.",
  },
  {
    id: 'digit-leading-name',
    directoryName: '2fa-setup',
    skillMarkdown: skill(['name: 2fa-setup', 'description: Configure two-factor authentication.']),
    valid: true,
    rationale:
      "This package required a leading letter. The validator's rule is per-character `isalnum()`, with no positional constraint.",
  },
  {
    id: 'unicode-name',
    directoryName: '日本語',
    skillMarkdown: skill(['name: 日本語', 'description: A skill named with Unicode letters.']),
    valid: true,
    rationale:
      "`str.isalnum()` is true for any Unicode letter, so the specification's i18n support is real and an ASCII-only pattern silently excluded it.",
  },
  {
    id: 'name-at-length-limit',
    directoryName: SIXTY_FOUR_CHARACTER_NAME,
    skillMarkdown: skill([
      `name: ${SIXTY_FOUR_CHARACTER_NAME}`,
      'description: Exactly at the 64-character name limit.',
    ]),
    valid: true,
  },
  {
    id: 'description-at-length-limit',
    directoryName: 'long-description',
    skillMarkdown: skill(['name: long-description', `description: ${MAXIMUM_DESCRIPTION}`]),
    valid: true,
  },
  {
    id: 'compatibility-at-length-limit',
    directoryName: 'long-compatibility',
    skillMarkdown: skill([
      'name: long-compatibility',
      'description: Exactly at the 500-character compatibility limit.',
      `compatibility: ${MAXIMUM_COMPATIBILITY}`,
    ]),
    valid: true,
  },

  {
    id: 'hexadecimal-looking-name',
    directoryName: '0x1f',
    skillMarkdown: skill(['name: 0x1f', 'description: A name that YAML would read as a number.']),
    valid: true,
    rationale:
      "Implicit YAML typing read this as 31 and then failed the directory match. Every scalar is a string to `strictyaml`, and now to this package's engine too.",
  },
  {
    id: 'exponent-looking-name',
    directoryName: '1e5',
    skillMarkdown: skill(['name: 1e5', 'description: Another name YAML would read as a number.']),
    valid: true,
    rationale: 'Read as 100000 before the YAML schema was pinned to string scalars.',
  },
  {
    id: 'date-looking-description',
    directoryName: 'dated',
    skillMarkdown: skill(['name: dated', 'description: 2026-09-19']),
    valid: true,
    rationale:
      'Implicit typing produced a `Date`, which read as an empty description and was rejected here while upstream accepted it.',
  },
  {
    id: 'sequence-allowed-tools',
    directoryName: 'sequence-tools',
    skillMarkdown: skill([
      'name: sequence-tools',
      'description: A YAML sequence is not the wire format, and upstream does not reject it.',
      'allowed-tools:',
      '  - Read',
      '  - Bash(git:*)',
    ]),
    valid: true,
    rationale:
      'The reference validator does not type-check this field. Returning nothing for a sequence silently erased the narrowing a skill author asked for.',
  },
  {
    id: 'flow-style-metadata',
    directoryName: 'flow-metadata',
    skillMarkdown: skill([
      'name: flow-metadata',
      'description: Flow-style mappings are valid YAML that strictyaml refuses.',
      'metadata: {author: example}',
    ]),
    valid: true,
    knownDivergence: {
      reference: 'rejects',
      reason:
        '`strictyaml` bans flow style outright; `js-yaml` accepts it under any schema. Closing this would mean writing a YAML dialect restriction by hand. The divergence is in the safe direction — this package admits a document another client refuses, rather than refusing one another client admits — so it is recorded and asserted rather than hidden.',
    },
  },

  {
    id: 'numeric-name-with-decimal-point',
    directoryName: '1.0',
    skillMarkdown: skill(['name: 1.0', 'description: A period is not alphanumeric.']),
    valid: false,
    expectedCodes: ['name-invalid-characters'],
    rationale:
      'Accepted here as the name "1" before the YAML schema was pinned, which is a skill admitted under a name upstream rejects outright.',
  },
  {
    id: 'uppercase-name',
    directoryName: 'PDF-Processing',
    skillMarkdown: skill(['name: PDF-Processing', 'description: Uppercase is not allowed.']),
    valid: false,
    expectedCodes: ['name-not-lowercase'],
  },
  {
    id: 'leading-hyphen-name',
    directoryName: '-pdf',
    skillMarkdown: skill(['name: -pdf', 'description: Cannot start with a hyphen.']),
    valid: false,
    expectedCodes: ['name-hyphen-boundary'],
  },
  {
    id: 'trailing-hyphen-name',
    directoryName: 'pdf-',
    skillMarkdown: skill(['name: pdf-', 'description: Cannot end with a hyphen.']),
    valid: false,
    expectedCodes: ['name-hyphen-boundary'],
  },
  {
    id: 'consecutive-hyphen-name',
    directoryName: 'pdf--processing',
    skillMarkdown: skill([
      'name: pdf--processing',
      'description: Consecutive hyphens are not allowed.',
    ]),
    valid: false,
    expectedCodes: ['name-consecutive-hyphens'],
  },
  {
    id: 'underscore-name',
    directoryName: 'code_review',
    skillMarkdown: skill(['name: code_review', 'description: Underscores are not alphanumeric.']),
    valid: false,
    expectedCodes: ['name-invalid-characters'],
  },
  {
    id: 'name-over-length-limit',
    directoryName: SIXTY_FIVE_CHARACTER_NAME,
    skillMarkdown: skill([
      `name: ${SIXTY_FIVE_CHARACTER_NAME}`,
      'description: One character over the 64-character limit.',
    ]),
    valid: false,
    expectedCodes: ['name-too-long'],
  },
  {
    id: 'name-directory-mismatch',
    directoryName: 'some-other-directory',
    skillMarkdown: skill([
      'name: declared-name',
      'description: The frontmatter name must equal the directory name.',
    ]),
    valid: false,
    expectedCodes: ['name-directory-mismatch'],
  },
  {
    id: 'missing-name',
    directoryName: 'missing-name',
    skillMarkdown: skill(['description: A skill without a name.']),
    valid: false,
    expectedCodes: ['name-missing'],
  },
  {
    id: 'missing-description',
    directoryName: 'missing-description',
    skillMarkdown: skill(['name: missing-description']),
    valid: false,
    expectedCodes: ['description-missing'],
  },
  {
    id: 'empty-description',
    directoryName: 'empty-description',
    skillMarkdown: skill(['name: empty-description', 'description: ""']),
    valid: false,
    expectedCodes: ['description-empty'],
  },
  {
    id: 'description-over-length-limit',
    directoryName: 'overlong-description',
    skillMarkdown: skill(['name: overlong-description', `description: ${OVERLONG_DESCRIPTION}`]),
    valid: false,
    expectedCodes: ['description-too-long'],
  },
  {
    id: 'compatibility-over-length-limit',
    directoryName: 'overlong-compatibility',
    skillMarkdown: skill([
      'name: overlong-compatibility',
      'description: One character over the 500-character compatibility limit.',
      `compatibility: ${OVERLONG_COMPATIBILITY}`,
    ]),
    valid: false,
    expectedCodes: ['compatibility-too-long'],
  },
  {
    id: 'portable-denied-tools',
    directoryName: 'deny-attempt',
    skillMarkdown: skill([
      'name: deny-attempt',
      'description: A skill author must not disable a tool for the agent that loaded it.',
      'denied-tools: Bash Edit',
    ]),
    valid: false,
    expectedCodes: ['unexpected-field'],
    rationale:
      'Refused by the allowed-field rule rather than by a rule of its own: `denied-tools` is simply not a field the specification defines.',
  },
  {
    id: 'unknown-field',
    directoryName: 'unknown-field',
    skillMarkdown: skill([
      'name: unknown-field',
      'description: Strict validation rejects fields the specification does not define.',
      'invented-field: something',
    ]),
    valid: false,
    expectedCodes: ['unexpected-field'],
  },
];
