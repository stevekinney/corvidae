import { describe, expect, it } from 'bun:test';

import {
  AGENT_SKILLS_SPECIFICATION_REPOSITORY,
  AGENT_SKILLS_SPECIFICATION_REVISION,
  isPortableSkillName,
  MAXIMUM_COMPATIBILITY_LENGTH,
  MAXIMUM_DESCRIPTION_LENGTH,
  MAXIMUM_SKILL_NAME_LENGTH,
  normalizeSkillName,
  parseAllowedTools,
  PORTABLE_FRONTMATTER_FIELDS,
  serializeAllowedTools,
  validatePortableFrontmatter,
} from '../../src/skills/conformance';
import {
  importSkillMarkdown,
  parseSkillMarkdown,
  serializeSkillMarkdown,
  SkillConformanceError,
} from '../../src/skills/parse-skill-markdown';
import { CONFORMANCE_CORPUS } from './fixtures/agent-skills-corpus';

describe('the pinned specification revision', () => {
  it('is the exact revision the corpus was diffed against', () => {
    // Asserted directly so moving the pin cannot pass silently. Changing this constant is a
    // superseding compatibility decision that requires re-running the corpus against the new
    // revision and classifying every newly non-conformant skill.
    expect(AGENT_SKILLS_SPECIFICATION_REVISION).toBe('69ef37e9424c0a7ea9dd2293b559e43ec8176379');
    expect(AGENT_SKILLS_SPECIFICATION_REPOSITORY).toBe(
      'https://github.com/agentskills/agentskills',
    );
  });

  it('carries the reference validator constants verbatim', () => {
    expect(MAXIMUM_SKILL_NAME_LENGTH).toBe(64);
    expect(MAXIMUM_DESCRIPTION_LENGTH).toBe(1024);
    expect(MAXIMUM_COMPATIBILITY_LENGTH).toBe(500);
  });

  it('defines exactly the upstream allowed-field set', () => {
    expect([...PORTABLE_FRONTMATTER_FIELDS]).toEqual([
      'allowed-tools',
      'compatibility',
      'description',
      'license',
      'metadata',
      'name',
    ]);
  });
});

describe('the pinned conformance corpus', () => {
  for (const fixture of CONFORMANCE_CORPUS) {
    it(`${fixture.valid ? 'accepts' : 'rejects'} ${fixture.id}`, () => {
      if (fixture.valid) {
        const content = parseSkillMarkdown(fixture.skillMarkdown, {
          directoryName: fixture.directoryName,
        });
        expect(content.metadata.name).toBe(normalizeSkillName(fixture.directoryName));
        return;
      }

      let thrown: unknown;
      try {
        parseSkillMarkdown(fixture.skillMarkdown, { directoryName: fixture.directoryName });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(SkillConformanceError);
      const codes = (thrown as SkillConformanceError).diagnostics.map(
        (diagnostic) => diagnostic.code,
      );
      for (const expected of fixture.expectedCodes ?? []) {
        expect(codes).toContain(expected);
      }
    });
  }
});

describe('validatePortableFrontmatter', () => {
  it('accumulates every failure rather than stopping at the first', () => {
    const diagnostics = validatePortableFrontmatter({ name: '-Bad--Name_' });
    const codes = diagnostics.map((diagnostic) => diagnostic.code);

    expect(codes).toContain('name-not-lowercase');
    expect(codes).toContain('name-hyphen-boundary');
    expect(codes).toContain('name-consecutive-hyphens');
    expect(codes).toContain('name-invalid-characters');
    expect(codes).toContain('description-missing');
  });

  it('names every unexpected field in one diagnostic, sorted', () => {
    const diagnostics = validatePortableFrontmatter({
      name: 'a-skill',
      description: 'Valid.',
      zebra: 1,
      alpha: 2,
    });

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.code).toBe('unexpected-field');
    expect(diagnostics[0]?.unexpectedFields).toEqual(['alpha', 'zebra']);
  });

  it('skips the directory-match rule when there is no directory to compare against', () => {
    // Upstream skips it the same way, so a registry payload with no directory is not failed for
    // something it cannot possibly satisfy.
    expect(validatePortableFrontmatter({ name: 'a-skill', description: 'Valid.' })).toEqual([]);
    expect(
      validatePortableFrontmatter(
        { name: 'a-skill', description: 'Valid.' },
        { directoryName: 'different' },
      ).map((diagnostic) => diagnostic.code),
    ).toEqual(['name-directory-mismatch']);
  });

  it('compares the directory name after NFKC normalization, as upstream does', () => {
    // U+FF41 FULLWIDTH LATIN SMALL LETTER A normalizes to "a", so these are the same name.
    expect(
      validatePortableFrontmatter(
        { name: 'ａ-skill', description: 'Valid.' },
        { directoryName: 'a-skill' },
      ),
    ).toEqual([]);
  });

  it('does not invent rules the reference validator lacks', () => {
    // Upstream validates neither the type of `allowed-tools` nor the shape of `metadata`. Adding
    // rejections it does not have would be a divergence in the other direction.
    expect(
      validatePortableFrontmatter({
        name: 'a-skill',
        description: 'Valid.',
        'allowed-tools': 42,
        metadata: 'not a mapping',
        license: { nested: true },
      }),
    ).toEqual([]);
  });
});

describe('name normalization', () => {
  it('trims before normalizing, matching upstream ordering', () => {
    expect(normalizeSkillName('  pdf-processing  ')).toBe('pdf-processing');
  });

  it('measures length in code points rather than UTF-16 units', () => {
    // A string of 64 astral code points is 128 UTF-16 units. Upstream counts characters, so
    // measuring `.length` here would reject a conformant name.
    expect(isPortableSkillName('𝟙'.repeat(64))).toBe(true);
    expect(isPortableSkillName('𝟙'.repeat(65))).toBe(false);
  });
});

describe('YAML scalars are read the way the reference parser reads them', () => {
  // Each of these was a confirmed divergence from the pinned validator, in both directions, caused
  // by `js-yaml`'s implicit typing against `strictyaml`'s everything-is-a-string. They are asserted
  // as parse results rather than only as verdicts so the cause stays visible.
  const cases = [
    { yaml: 'name: 1.0', directory: '1.0', expected: '1.0', valid: false },
    { yaml: 'name: 0x1f', directory: '0x1f', expected: '0x1f', valid: true },
    { yaml: 'name: 1e5', directory: '1e5', expected: '1e5', valid: true },
  ] as const;

  for (const testCase of cases) {
    it(`reads \`${testCase.yaml}\` as the string it was written as`, () => {
      const markdown = ['---', testCase.yaml, 'description: A skill.', '---', '', 'B.'].join('\n');
      const imported = importSkillMarkdown(markdown, { directoryName: testCase.directory });

      expect(imported.content.metadata.name).toBe(testCase.expected);
      expect(imported.conformance.length === 0).toBe(testCase.valid);
    });
  }

  it('reads a date-looking description as a string rather than a Date', () => {
    const markdown = ['---', 'name: dated', 'description: 2026-09-19', '---', '', 'B.'].join('\n');
    const content = parseSkillMarkdown(markdown, { directoryName: 'dated' });

    // As a `Date` this read as an empty description and was rejected; upstream accepts it.
    expect(content.metadata.description).toBe('2026-09-19');
  });

  it('reads a nested metadata scalar as a string, preserving its written form', () => {
    const markdown = [
      '---',
      'name: versioned',
      'description: A skill.',
      'metadata:',
      '  version: 1.0',
      '---',
      '',
      'B.',
    ].join('\n');

    // Unquoted, this became "1" — a silently reformatted value in a field the specification says
    // is a map of strings to strings.
    expect(parseSkillMarkdown(markdown).metadata.metadata).toEqual({ version: '1.0' });
  });
});

describe('the allowed-tools wire format', () => {
  it('splits on whitespace, keeping parameterized requests intact', () => {
    expect(parseAllowedTools('Bash(git:*) Bash(jq:*) Read')).toEqual([
      'Bash(git:*)',
      'Bash(jq:*)',
      'Read',
    ]);
  });

  it('tolerates irregular whitespace', () => {
    expect(parseAllowedTools('  Read\t Write \n Edit ')).toEqual(['Read', 'Write', 'Edit']);
  });

  it('round-trips through serialization', () => {
    const tools = ['Bash(git:*)', 'Read'];
    expect(parseAllowedTools(serializeAllowedTools(tools))).toEqual(tools);
  });

  it('reads a YAML sequence rather than silently dropping it', () => {
    // The reference validator does not type-check this field and its reader carries a sequence
    // through, so returning nothing here meant a skill author who wrote the intuitive list got no
    // allow-list at all — a permissions surface failing open with no diagnostic.
    expect(parseAllowedTools(['Read', ' Write ', '', 42])).toEqual(['Read', 'Write']);
    expect(parseAllowedTools(undefined)).toEqual([]);
  });

  it('carries a sequence through strict parsing and re-emits the portable string', () => {
    const markdown = [
      '---',
      'name: sequence-tools',
      'description: A sequence must not silently erase the narrowing.',
      'allowed-tools:',
      '  - Read',
      '  - Bash(git:*)',
      '---',
      '',
      'B.',
    ].join('\n');

    const content = parseSkillMarkdown(markdown, { directoryName: 'sequence-tools' });

    expect(content.metadata.toolPolicy?.allowList).toEqual(['Read', 'Bash(git:*)']);
    expect(serializeSkillMarkdown(content)).toMatch(/^allowed-tools: '?Read Bash\(git:\*\)'?$/mu);
  });
});

describe('gray-matter cache isolation', () => {
  it('parses the same document twice after the first attempt throws', () => {
    // `gray-matter` memoizes by input string and stores its cache entry *before* parsing, so a
    // document that throws leaves an empty entry behind. Without an explicit options object, the
    // second parse of these exact bytes returned that empty entry instead of throwing, and
    // diagnostic import produced a skill with no name at all.
    const markdown = [
      '---',
      'name: cache-check',
      'description: Use this skill when: the cache is primed by a failure.',
      '---',
      '',
      'Body.',
    ].join('\n');

    expect(() => parseSkillMarkdown(markdown)).toThrow();

    const imported = importSkillMarkdown(markdown);
    expect(imported.content.metadata.name).toBe('cache-check');
    expect(imported.content.metadata.description).toContain('the cache is primed by a failure');
  });
});

describe('diagnostic import', () => {
  it('preserves an unsupported field losslessly and reports it', () => {
    const markdown = [
      '---',
      'name: preserved',
      'description: Unknown keys are kept for inspection rather than discarded.',
      'client-specific:',
      '  nested: value',
      '---',
      '',
      'Body.',
    ].join('\n');

    const imported = importSkillMarkdown(markdown);

    expect(imported.preservedFields).toEqual({ 'client-specific': { nested: 'value' } });
    expect(imported.repairs.map((repair) => repair.code)).toContain('unsupported-field-dropped');
    expect(imported.conformance.map((diagnostic) => diagnostic.code)).toContain('unexpected-field');
    expect(imported.conformant).toBe(false);
  });

  it('does not let a replacement pattern in a repaired value corrupt it', () => {
    // `$&`, `` $` `` and `$'` are replacement patterns to `String#replace`. Because the repair's
    // match spans the whole fence from offset 0, `` $` `` silently truncated the value to nothing
    // and `$&` duplicated the fence until the document no longer parsed at all.
    for (const suffix of ['$`', "$'", '$&']) {
      const markdown = [
        '---',
        'name: dollar',
        `description: Use this: it costs ${suffix} today`,
        '---',
        '',
        'B.',
      ].join('\n');

      const imported = importSkillMarkdown(markdown);
      expect(imported.content.metadata.name).toBe('dollar');
      expect(imported.content.metadata.description).toBe(`Use this: it costs ${suffix} today`);
    }
  });

  it('never reports a repaired document as conformant', () => {
    const markdown = [
      '---',
      'name: repaired',
      'description: Strictly valid once the sequence is joined, but not as written.',
      'allowed-tools:',
      '  - Read',
      '---',
      '',
      'Body.',
    ].join('\n');

    const imported = importSkillMarkdown(markdown);

    // Strict validation passes on the repaired document, and the import is still not conformant:
    // what the publisher shipped is the original bytes, and those are what another client checks.
    expect(imported.conformance).toEqual([]);
    expect(imported.repairs).not.toHaveLength(0);
    expect(imported.conformant).toBe(false);
  });

  it('reports a clean document as conformant', () => {
    const imported = importSkillMarkdown(
      ['---', 'name: clean', 'description: Nothing to repair.', '---', '', 'Body.'].join('\n'),
    );

    expect(imported.conformant).toBe(true);
    expect(imported.repairs).toEqual([]);
    expect(imported.conformance).toEqual([]);
  });

  it('needs no repair for a numeric-looking name, because scalars are read as strings', () => {
    // Nothing is coerced: the YAML engine resolves every scalar as a string, exactly as the
    // reference parser's `strictyaml` does. A repair here would have been a silent divergence.
    const imported = importSkillMarkdown(
      ['---', 'name: 123', 'description: A numeric name.', '---', '', 'Body.'].join('\n'),
    );

    expect(imported.content.metadata.name).toBe('123');
    expect(imported.conformance).toEqual([]);
    expect(imported.repairs).toEqual([]);
    expect(imported.conformant).toBe(true);
  });
});

describe('portable serialization', () => {
  it('round-trips every standard field without changing its wire representation', () => {
    const original = CONFORMANCE_CORPUS.find((fixture) => fixture.id === 'all-optional-fields');
    if (!original) throw new Error('fixture missing');

    const parsed = parseSkillMarkdown(original.skillMarkdown, {
      directoryName: original.directoryName,
    });
    const serialized = serializeSkillMarkdown(parsed);

    // One line, one space-separated string. YAML may quote the scalar because it contains a
    // colon; that is the same value, so the assertion is about the representation of the list and
    // not about whether js-yaml chose quotes.
    expect(serialized).toMatch(/^allowed-tools: '?Bash\(git:\*\) Bash\(jq:\*\) Read'?$/mu);
    expect(serialized).not.toContain('denied-tools');

    const reparsed = parseSkillMarkdown(serialized, { directoryName: original.directoryName });
    expect(reparsed.metadata).toEqual(parsed.metadata);
  });

  it('omits a field a diagnostic import preserved', () => {
    const imported = importSkillMarkdown(
      [
        '---',
        'name: preserved',
        'description: An unsupported key must not be republished.',
        'invented-field: value',
        '---',
        '',
        'Body.',
      ].join('\n'),
    );

    expect(serializeSkillMarkdown(imported.content)).not.toContain('invented-field');
  });
});
