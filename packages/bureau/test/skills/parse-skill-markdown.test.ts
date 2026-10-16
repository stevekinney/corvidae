import { describe, expect, it } from 'bun:test';

import {
  importSkillMarkdown,
  parseSkillMarkdown,
  serializeSkillMarkdown,
  SkillConformanceError,
  SkillParseError,
} from '../../src/skills/parse-skill-markdown';

describe('parseSkillMarkdown', () => {
  it('parses a valid SKILL.md with all fields', () => {
    const markdown = [
      '---',
      'name: code-review',
      'description: Use this skill when reviewing code for best practices.',
      'license: MIT',
      'compatibility: Requires filesystem access',
      'allowed-tools: Read Grep Glob',
      'metadata:',
      '  author: test-author',
      '  version: "1.0"',
      '---',
      '',
      '## Instructions',
      '',
      'Review the code carefully.',
    ].join('\n');

    const result = parseSkillMarkdown(markdown);

    expect(result.metadata.name).toBe('code-review');
    expect(result.metadata.description).toBe(
      'Use this skill when reviewing code for best practices.',
    );
    expect(result.metadata.license).toBe('MIT');
    expect(result.metadata.compatibility).toBe('Requires filesystem access');
    expect(result.metadata.toolPolicy?.allowList).toEqual(['Read', 'Grep', 'Glob']);
    expect(result.metadata.metadata).toEqual({ author: 'test-author', version: '1.0' });
    expect(result.body).toBe('## Instructions\n\nReview the code carefully.');
  });

  it('parses a minimal SKILL.md with name and description only', () => {
    const markdown = [
      '---',
      'name: simple-skill',
      'description: A simple skill for testing.',
      '---',
      '',
      'Do the thing.',
    ].join('\n');

    const result = parseSkillMarkdown(markdown);

    expect(result.metadata.name).toBe('simple-skill');
    expect(result.metadata.description).toBe('A simple skill for testing.');
    expect(result.metadata.license).toBeUndefined();
    expect(result.metadata.compatibility).toBeUndefined();
    expect(result.metadata.toolPolicy).toBeUndefined();
    expect(result.metadata.metadata).toBeUndefined();
    expect(result.body).toBe('Do the thing.');
  });

  it('throws SkillParseError when name is missing', () => {
    const markdown = [
      '---',
      'description: A skill without a name.',
      '---',
      '',
      'Body content.',
    ].join('\n');

    expect(() => parseSkillMarkdown(markdown)).toThrow(SkillParseError);
  });

  it('throws SkillParseError when description is missing', () => {
    const markdown = ['---', 'name: no-description', '---', '', 'Body content.'].join('\n');

    expect(() => parseSkillMarkdown(markdown)).toThrow(SkillParseError);
  });

  it('throws SkillParseError when name is empty', () => {
    const markdown = [
      '---',
      'name: ""',
      'description: Has a description.',
      '---',
      '',
      'Body content.',
    ].join('\n');

    expect(() => parseSkillMarkdown(markdown)).toThrow(SkillParseError);
  });

  it('throws SkillParseError when description is empty', () => {
    const markdown = ['---', 'name: has-name', 'description: ""', '---', '', 'Body content.'].join(
      '\n',
    );

    expect(() => parseSkillMarkdown(markdown)).toThrow(SkillParseError);
  });

  it('refuses to silently repair unquoted colons, which diagnostic import handles instead', () => {
    const markdown = [
      '---',
      'name: colon-skill',
      'description: Use this skill when: reviewing code for problems.',
      '---',
      '',
      'Body content.',
    ].join('\n');

    // This document used to parse here, repaired and unreported. Strict parsing is a claim about
    // the bytes a publisher shipped, so a document that does not parse as written fails
    // (COR-752, Decision 6) and the repair moves to the mode that reports it.
    expect(() => parseSkillMarkdown(markdown)).toThrow(SkillParseError);

    const imported = importSkillMarkdown(markdown);

    expect(imported.content.metadata.name).toBe('colon-skill');
    expect(imported.content.metadata.description).toContain('reviewing code for problems');
    expect(imported.repairs.map((repair) => repair.code)).toContain('yaml-value-quoted');
    expect(imported.conformant).toBe(false);
  });

  it('throws SkillParseError for completely invalid YAML', () => {
    const markdown = [
      '---',
      '{{{{not yaml at all!!!!',
      '  [ broken: {{ nope',
      '---',
      '',
      'Body content.',
    ].join('\n');

    expect(() => parseSkillMarkdown(markdown)).toThrow(SkillParseError);
  });

  it('extracts and trims the body correctly', () => {
    const markdown = [
      '---',
      'name: body-test',
      'description: Test body extraction.',
      '---',
      '',
      '  ',
      '## Section One',
      '',
      'Content here.',
      '  ',
    ].join('\n');

    const result = parseSkillMarkdown(markdown);

    expect(result.body).toBe('## Section One\n\nContent here.');
  });

  it('parses the space-separated allowed-tools wire format into toolPolicy.allowList', () => {
    const markdown = [
      '---',
      'name: tool-policy-test',
      'description: Test tool policy parsing.',
      'allowed-tools: Read Write Bash Edit',
      '---',
      '',
      'Instructions.',
    ].join('\n');

    const result = parseSkillMarkdown(markdown);

    expect(result.metadata.toolPolicy).toBeDefined();
    expect(result.metadata.toolPolicy?.allowList).toEqual(['Read', 'Write', 'Bash', 'Edit']);
  });

  it('keeps a parameterized tool request intact', () => {
    const markdown = [
      '---',
      'name: parameterized-tools',
      "description: The specification's own example uses parenthesized arguments.",
      'allowed-tools: Bash(git:*) Bash(jq:*) Read',
      '---',
      '',
      'Instructions.',
    ].join('\n');

    const result = parseSkillMarkdown(markdown);

    // The commas that used to separate this field appear *inside* real tool requests, which is
    // why splitting on them shredded `Bash(git:*)` into two meaningless halves.
    expect(result.metadata.toolPolicy?.allowList).toEqual(['Bash(git:*)', 'Bash(jq:*)', 'Read']);
  });

  it('repairs comma-separated allowed-tools on import without calling it conformant', () => {
    const markdown = [
      '---',
      'name: legacy-tool-policy',
      'description: Written against this package before it was pinned to the specification.',
      'allowed-tools: Read, Write, Bash',
      '---',
      '',
      'Instructions.',
    ].join('\n');

    const imported = importSkillMarkdown(markdown);

    expect(imported.content.metadata.toolPolicy?.allowList).toEqual(['Read', 'Write', 'Bash']);
    expect(imported.repairs.map((repair) => repair.code)).toContain(
      'allowed-tools-comma-separated',
    );
    expect(imported.conformant).toBe(false);
  });

  it('rejects a portable denied-tools key as an unexpected field', () => {
    const markdown = [
      '---',
      'name: deny-attempt',
      'description: A skill author must not be able to disable a tool for the agent loading it.',
      'denied-tools: Bash Edit',
      '---',
      '',
      'Instructions.',
    ].join('\n');

    // `denied-tools` needs no rule of its own: it is simply not a field the specification defines,
    // so the allowed-field check refuses it along with every other unknown key.
    expect(() => parseSkillMarkdown(markdown)).toThrow(SkillConformanceError);
  });

  it('repairs a YAML sequence of allowed-tools on import without calling it conformant', () => {
    const markdown = [
      '---',
      'name: array-tool-policy',
      'description: A sequence is the intuitive way to write a list, and is not the wire format.',
      'allowed-tools:',
      '  - Read',
      '  - Write',
      '---',
      '',
      'Instructions.',
    ].join('\n');

    const imported = importSkillMarkdown(markdown);

    expect(imported.content.metadata.toolPolicy?.allowList).toEqual(['Read', 'Write']);
    expect(imported.repairs.map((repair) => repair.code)).toContain(
      'allowed-tools-sequence-joined',
    );
    expect(imported.conformant).toBe(false);
  });

  it('produces empty string for empty body', () => {
    const markdown = [
      '---',
      'name: empty-body',
      'description: Skill with no body content.',
      '---',
    ].join('\n');

    const result = parseSkillMarkdown(markdown);

    expect(result.body).toBe('');
  });

  it('produces empty string for frontmatter-only file with trailing newlines', () => {
    const markdown = [
      '---',
      'name: frontmatter-only',
      'description: Just frontmatter, nothing else.',
      '---',
      '',
      '',
    ].join('\n');

    const result = parseSkillMarkdown(markdown);

    expect(result.body).toBe('');
  });

  it('preserves metadata as Record<string, string>', () => {
    const markdown = [
      '---',
      'name: metadata-test',
      'description: Test metadata preservation.',
      'metadata:',
      '  author: Jane Doe',
      '  version: "2.0"',
      '  category: testing',
      '---',
      '',
      'Body.',
    ].join('\n');

    const result = parseSkillMarkdown(markdown);

    expect(result.metadata.metadata).toEqual({
      author: 'Jane Doe',
      version: '2.0',
      category: 'testing',
    });
  });
});

describe('serializeSkillMarkdown', () => {
  it('round-trips with parseSkillMarkdown', () => {
    const original = [
      '---',
      'name: round-trip',
      'description: Test round-trip serialization.',
      'license: MIT',
      'compatibility: Requires filesystem access',
      'allowed-tools: Read, Grep',
      'metadata:',
      '  author: tester',
      '---',
      '',
      '## Instructions',
      '',
      'Do the thing.',
    ].join('\n');

    const parsed = parseSkillMarkdown(original);
    const serialized = serializeSkillMarkdown(parsed);
    const reparsed = parseSkillMarkdown(serialized);

    expect(reparsed.metadata.name).toBe(parsed.metadata.name);
    expect(reparsed.metadata.description).toBe(parsed.metadata.description);
    expect(reparsed.metadata.license).toBe(parsed.metadata.license);
    expect(reparsed.metadata.compatibility).toBe(parsed.metadata.compatibility);
    expect(reparsed.metadata.toolPolicy?.allowList).toEqual(parsed.metadata.toolPolicy?.allowList);
    expect(reparsed.metadata.metadata).toEqual(parsed.metadata.metadata);
    expect(reparsed.body).toBe(parsed.body);
  });

  it('serializes minimal content correctly', () => {
    const content = {
      metadata: {
        name: 'minimal',
        description: 'A minimal skill.',
      },
      body: 'Just a body.',
    };

    const serialized = serializeSkillMarkdown(content);
    const reparsed = parseSkillMarkdown(serialized);

    expect(reparsed.metadata.name).toBe('minimal');
    expect(reparsed.metadata.description).toBe('A minimal skill.');
    expect(reparsed.body).toBe('Just a body.');
  });

  it('maps toolPolicy.allowList back to allowed-tools', () => {
    const content = {
      metadata: {
        name: 'tool-serialize',
        description: 'Test tool serialization.',
        toolPolicy: { allowList: ['Read', 'Write'] },
      },
      body: '',
    };

    const serialized = serializeSkillMarkdown(content);

    expect(serialized).toContain('allowed-tools');
    expect(serialized).toContain('Read');
    expect(serialized).toContain('Write');

    const reparsed = parseSkillMarkdown(serialized);
    expect(reparsed.metadata.toolPolicy?.allowList).toEqual(['Read', 'Write']);
  });
});
