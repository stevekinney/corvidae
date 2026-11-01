import { afterEach, describe, expect, test } from 'bun:test';

import { listSkills } from './bureau-skills.ts';
import { installBureauStub, readyAgent, type BureauStub } from './bureau-stub.test-support.ts';
import { listSkillUsers } from './skill-users.ts';

let stub: BureauStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

const SKILL = {
  name: 'summarize',
  description: 'Summarizes.',
  source: { id: 'home', kind: 'user', location: '/skills', plugin: null },
  trust: 'untrusted',
  trustReason: 'Not listed as trusted.',
  available: false,
  unavailableReason: 'source-untrusted',
  allowedTools: ['read-file'],
};

function agent(name: string, kind: 'code' | 'file') {
  return { name, displayName: name, description: null, definitionRevision: 1, kind, a2a: false };
}

function detail(id: string, skills: string[] | null, allowedSkills: string[] | null = null) {
  return {
    id,
    source: skills === null ? 'file' : 'code',
    state: 'ready',
    name: id,
    description: null,
    a2a: false,
    hash: null,
    problem: null,
    definition: allowedSkills === null ? null : { ...readyAgent().definition, allowedSkills },
    codeDefinition:
      skills === null
        ? null
        : {
            name: id,
            description: null,
            model: null,
            models: [],
            tools: [],
            skills,
            skillDescriptors: [],
            instructions: null,
          },
  };
}

describe('the executable skills', () => {
  test('are listed with their source, their trust and the tools they ask to keep', async () => {
    stub = installBureauStub({
      'bureau.skills.list': () => ({
        revision: 1,
        skills: [SKILL],
        sources: [],
        trustLocked: null,
      }),
    });
    expect(await listSkills()).toEqual([SKILL as never]);
  });
});

describe('the agents that use a skill', () => {
  test('are the agents that name it, each once, in code or in a file’s allowedSkills', async () => {
    stub = installBureauStub({
      'bureau.agents.list': () => ({
        agents: [
          agent('assistant', 'code'),
          agent('helper', 'code'),
          agent('notes', 'file'),
          agent('plain', 'file'),
        ],
      }),
      'bureau.agents.definitions.get': (params) => {
        const id = String(params['id']);
        if (id === 'assistant') return detail(id, ['summarize', 'summarize', 'deploy']);
        if (id === 'helper') return detail(id, ['summarize']);
        if (id === 'notes') return detail(id, null, ['summarize']);
        return detail(id, null);
      },
    });
    const users = await listSkillUsers();
    expect(users.get('summarize')).toEqual(['assistant', 'helper', 'notes']);
    expect(users.get('deploy')).toEqual(['assistant']);
    expect(users.has('absent')).toBe(false);
  });
});
