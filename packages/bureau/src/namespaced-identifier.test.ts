/**
 * COR-1871 — the `plugin:name` identifier grammar and its mapping to Weft handler names.
 */
import { activity } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { AUDIT_SYNTHETIC_OWNER_PREFIXES } from './audit-trail';
import {
  AGENT_FILE_STEM_PATTERN,
  AGENT_IDENTIFIER_PATTERN,
  checkAgentIdentifier,
} from './agent-file';
import { A2A_AGENT_NAME_PATTERN } from './http/create-bureau-handler';
import { EVENT_OWNER_WORKFLOW_ID_PREFIXES } from './reserved-identifiers';
import { TRY_AGENT_NAME_START } from './agent-try';
import {
  fromWeftHandlerName,
  handlerNameIssue,
  isNamespacedIdentifier,
  NAMESPACED_IDENTIFIER_PATTERN,
  RESERVED_NAMESPACES,
  toWeftHandlerName,
  weftHandlerNameOf,
} from './namespaced-identifier';
import { checkWorkflowIdentifier, WORKFLOW_IDENTIFIER_PATTERN } from './workflow-file';

const ACCEPTED = ['linear:triager', 'a:b', 'github:pull-request-2', 'x1:y-2'];
const REJECTED = [
  'linear:',
  ':triager',
  'a:b:c',
  'linear/triager',
  'Linear:triager',
  '1password:sync',
  'linear:-triager',
  'linear:triager-',
  'linear_x:triager',
  'linear:tri_ager',
  'linear :triager',
  '',
];

describe('the exported identifier patterns', () => {
  it('accept a namespaced id and reject the malformed ones', () => {
    for (const pattern of [
      NAMESPACED_IDENTIFIER_PATTERN,
      AGENT_IDENTIFIER_PATTERN,
      WORKFLOW_IDENTIFIER_PATTERN,
      A2A_AGENT_NAME_PATTERN,
    ]) {
      for (const id of ACCEPTED) expect(pattern.test(id)).toBe(true);
      for (const id of REJECTED) expect(pattern.test(id)).toBe(false);
    }
  });

  it('keep accepting the bare identifiers they always did', () => {
    expect(AGENT_IDENTIFIER_PATTERN.test('triager')).toBe(true);
    expect(AGENT_IDENTIFIER_PATTERN.test('1password')).toBe(true);
    expect(WORKFLOW_IDENTIFIER_PATTERN.test('digest')).toBe(true);
    expect(WORKFLOW_IDENTIFIER_PATTERN.test('1digest')).toBe(false);
  });

  it('leave an owner file stem bare', () => {
    expect(AGENT_FILE_STEM_PATTERN.test('linear:triager')).toBe(false);
    expect(checkAgentIdentifier('linear:triager')?.code).toBe('invalid-identifier');
    expect(checkWorkflowIdentifier('linear:triager')?.code).toBe('invalid-identifier');
    expect(checkAgentIdentifier('triager')).toBeUndefined();
  });

  it('refuse a namespace that an id is already recorded under', () => {
    const owned = [
      TRY_AGENT_NAME_START,
      ...EVENT_OWNER_WORKFLOW_ID_PREFIXES,
      ...AUDIT_SYNTHETIC_OWNER_PREFIXES,
    ];
    for (const prefix of owned) {
      expect(RESERVED_NAMESPACES).toContain(prefix.slice(0, -1));
      expect(isNamespacedIdentifier(`${prefix}name`)).toBe(false);
      expect(AGENT_IDENTIFIER_PATTERN.test(`${prefix}name`)).toBe(false);
    }
    expect(isNamespacedIdentifier('running:name')).toBe(true);
  });
});

/** A small deterministic generator, so the property tests are the same on every run. */
function generator(seed: number): () => number {
  let state = seed;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function segment(random: () => number): string {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  const inner = `${letters}0123456789-`;
  const length = 1 + Math.floor(random() * 20);
  let text = letters[Math.floor(random() * letters.length)]!;
  for (let index = 1; index < length; index += 1) {
    text += inner[Math.floor(random() * inner.length)]!;
  }
  return text.replace(/-+$/, 'z');
}

function generatedIds(count: number): string[] {
  const random = generator(1871);
  const ids: string[] = [];
  while (ids.length < count) {
    const id = `${segment(random)}:${segment(random)}`;
    if (isNamespacedIdentifier(id)) ids.push(id);
  }
  return ids;
}

/** Weft's `validateWorkflowOrActivityName` is internal; `activity` runs it on the name it is given. */
function validateWorkflowOrActivityName(name: string, _kind: 'activity'): void {
  activity({ name, execute: async () => undefined });
}

describe('the Weft handler mapping', () => {
  it('maps 1,000 generated ids to names Weft’s grammar accepts, and back', () => {
    const ids = generatedIds(1000);
    for (const id of ids) {
      const mapped = toWeftHandlerName(id);
      expect(() => validateWorkflowOrActivityName(mapped, 'activity')).not.toThrow();
      expect(fromWeftHandlerName(mapped)).toBe(id);
      expect(weftHandlerNameOf(id)).toBe(mapped);
    }
  });

  it('is injective, and its image is never a bare handler name Bureau accepts', () => {
    const ids = [...new Set(generatedIds(1000))];
    const images = new Set(ids.map(toWeftHandlerName));
    expect(images.size).toBe(ids.length);
    for (const image of images) {
      expect(handlerNameIssue(image)).toContain('__');
      expect(isNamespacedIdentifier(image)).toBe(false);
    }
  });

  it('refuses a bare handler containing __ and accepts the others', () => {
    expect(handlerNameIssue('linear__sync-issue')).toContain('plugin:name');
    expect(handlerNameIssue('a__b__c')).toBeDefined();
    expect(handlerNameIssue('agent')).toBeUndefined();
    expect(handlerNameIssue('linear:sync-issue')).toBeUndefined();
    expect(handlerNameIssue('snake_case')).toBeUndefined();
  });

  it('does not map a name that is not an image', () => {
    expect(fromWeftHandlerName('plain')).toBeUndefined();
    expect(fromWeftHandlerName('a__b__c')).toBeUndefined();
    expect(fromWeftHandlerName('1password__sync')).toBeUndefined();
    expect(() => toWeftHandlerName('bare')).toThrow(TypeError);
  });
});
