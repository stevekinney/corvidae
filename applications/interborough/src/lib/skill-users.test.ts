import { afterEach, describe, expect, test } from 'bun:test';

import { listSkills } from './bureau-skills.ts';
import { installBureauStub, type BureauStub } from './bureau-stub.test-support.ts';
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

function detail(id: string, skills: string[] | null) {
  return {
    id,
    source: skills === null ? 'file' : 'code',
    state: 'ready',
    name: id,
    description: null,
    a2a: false,
    hash: null,
    problem: null,
    definition: null,
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
  test('are the code-defined agents that name it, each once, and never a file agent', async () => {
    stub = installBureauStub({
      'bureau.agents.list': () => ({
        agents: [agent('assistant', 'code'), agent('helper', 'code'), agent('notes', 'file')],
      }),
      'bureau.agents.definitions.get': (params) => {
        const id = String(params['id']);
        if (id === 'assistant') return detail(id, ['summarize', 'summarize', 'deploy']);
        if (id === 'helper') return detail(id, ['summarize']);
        throw new Error(`a file agent is not read: ${id}`);
      },
    });
    const users = await listSkillUsers();
    expect(users.get('summarize')).toEqual(['assistant', 'helper']);
    expect(users.get('deploy')).toEqual(['assistant']);
    expect(users.has('absent')).toBe(false);
    expect(stub.callsTo('bureau.agents.definitions.get').map((call) => call.params['id'])).toEqual([
      'assistant',
      'helper',
    ]);
  });
});
