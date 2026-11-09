import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const workflowsDirectory = join(root, '.claude', 'workflows');
const protocolPath = join(root, '.agents', 'skills', 'chef', 'references', 'codex-protocol.md');

const workflowFiles = readdirSync(workflowsDirectory).filter((name) => name.endsWith('.js'));

/** The text of the object literal after `export const meta = `, found by brace matching. */
function metaText(source: string): string {
  const start = source.indexOf('{');
  let depth = 0;
  let inString: string | null = null;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    if (inString !== null) {
      if (character === '\\') index += 1;
      else if (character === inString) inString = null;
    } else if (character === "'" || character === '"') inString = character;
    else if (character === '{') depth += 1;
    else if (character === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error('meta object is not closed');
}

describe('workflow scripts', () => {
  test('there are workflows to check', () => {
    expect(workflowFiles).toContain('deliver-issue.js');
    expect(workflowFiles).toContain('answer-threads.js');
  });

  for (const file of workflowFiles) {
    const source = readFileSync(join(workflowsDirectory, file), 'utf8');

    describe(file, () => {
      test('starts with a pure-literal meta', () => {
        expect(source.startsWith('export const meta = {')).toBe(true);
        const text = metaText(source);
        expect(text).not.toContain('`');
        expect(text).not.toContain('${');
        expect(text).not.toMatch(/[A-Za-z_$][\w$]*\s*\(/);
      });

      test('every phase() title is declared in meta.phases', () => {
        const declared = [...metaText(source).matchAll(/phases:\s*\[([^\]]*)\]/g)]
          .flatMap((match) => [...match[1]!.matchAll(/'([^']+)'/g)])
          .map((match) => match[1]!);
        const used = [...source.matchAll(/\bphase\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]!);
        expect(used.length).toBeGreaterThan(0);
        for (const title of used) expect(declared).toContain(title);
      });

      test('uses no nondeterministic primitives', () => {
        expect(source).not.toContain('Date.now');
        expect(source).not.toContain('Math.random');
        expect(source).not.toContain('new Date(');
      });

      test('never asks an agent to merge', () => {
        expect(source).not.toContain('gh pr merge');
        for (const line of source.split('\n')) {
          if (!line.includes('deliver.ts')) continue;
          // A mention that forbids delivery, or sits in a comment, is allowed.
          expect(/\b(never|not)\b|^\s*\/\//i.test(line)).toBe(true);
        }
      });

      test('names only scripts and agent types that exist', () => {
        for (const match of source.matchAll(/scripts\/chef\/([\w-]+)\.ts/g)) {
          expect(existsSync(join(root, 'scripts', 'chef', `${match[1]}.ts`))).toBe(true);
        }
        for (const match of source.matchAll(/agentType:\s*'([^']+)'/g)) {
          expect(existsSync(join(root, '.claude', 'agents', `${match[1]}.md`))).toBe(true);
        }
      });
    });
  }
});

describe('codex-protocol.md', () => {
  const text = readFileSync(protocolPath, 'utf8');

  test('names only scripts and agents that exist', () => {
    const names = [...text.matchAll(/scripts\/chef\/([\w-]+)\.ts/g)];
    expect(names.length).toBeGreaterThan(0);
    for (const match of names) {
      expect(existsSync(join(root, 'scripts', 'chef', `${match[1]}.ts`))).toBe(true);
    }
    for (const match of text.matchAll(/\.codex\/agents\/([\w-]+\.toml)/g)) {
      expect(existsSync(join(root, '.codex', 'agents', match[1]!))).toBe(true);
    }
  });

  test('stays within 500 words', () => {
    expect(text.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(500);
  });
});
