import { describe, expect, it } from 'bun:test';

import { createMockSkillProvider } from '../../src/skills/index';
import type { SkillContent } from '../../src/skills/types';
import { resourceBytes } from './support/resource-bytes';

function makeSkill(name: string, description = `Description for ${name}`): SkillContent {
  return {
    metadata: { name, description },
    body: `Instructions for ${name}`,
  };
}

describe('createMockSkillProvider', () => {
  it('records what was written, and forgets a deleted skill', async () => {
    const provider = createMockSkillProvider([makeSkill('keep-me')]);

    await provider.saveSkill('delete-me', makeSkill('delete-me'));
    await provider.saveResource('delete-me', 'guide.md', resourceBytes('guide'));
    await provider.setEnabled('delete-me', false);

    expect(provider.written.get('delete-me')).toEqual(makeSkill('delete-me'));

    await provider.deleteSkill('delete-me');

    // The survivor is asserted too: a delete that swept a neighbour would be silent data loss.
    expect(provider.written.has('delete-me')).toBe(false);
    expect(provider.written.has('keep-me')).toBe(true);
  });

  it('tracks every call so a test can assert what a caller actually did', async () => {
    const provider = createMockSkillProvider();

    await provider.saveSkill('written', makeSkill('written'));
    await provider.setEnabled('written', false);

    expect(provider.calls.map((call) => call.method)).toEqual(['saveSkill', 'setEnabled']);
  });
});
