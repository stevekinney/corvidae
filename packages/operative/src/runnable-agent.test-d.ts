// Type-level contract for AB-234. This file is checked by `tsc --noEmit`; it
// is not a runtime Bun test.

import type { AgentRun } from './agent-run';
import type { AgentInput, AgentRunContext, RunnableAgent } from './runnable-agent';

declare const dummyRun: AgentRun;

// `run` declared as a property-typed function (not method shorthand) is
// checked CONTRAVARIANTLY: an implementation whose `run` only accepts a
// narrower input type than `AgentInput` (`string | { conversation }`) does
// not satisfy the contract. Before AB-234 (method shorthand, checked
// bivariantly), this compiled unsoundly.
const narrowRunAgent: RunnableAgent = {
  name: 'narrow',
  hasOutput: false,
  // @ts-expect-error — a `run` accepting only `string` rejects the `{ conversation }` half of `AgentInput`.
  run: (_input: string): AgentRun => dummyRun,
};
void narrowRunAgent;

// The full `AgentInput` union, and the optional `AgentRunContext`, are
// accepted — this is the shape every real `RunnableAgent` implementation
// (`createAgent`, `createLazyAgent`) actually has.
const wideRunAgent: RunnableAgent = {
  name: 'wide',
  hasOutput: false,
  run: (_input: AgentInput, _context?: AgentRunContext): AgentRun => dummyRun,
};
void wideRunAgent;

// `hasOutput` is a required runtime witness — omitting it is a type error,
// not silently defaulted.
// @ts-expect-error — `hasOutput` is required.
const missingHasOutput: RunnableAgent = {
  name: 'missing-has-output',
  run: (): AgentRun => dummyRun,
};
void missingHasOutput;

// COR-1301 — `description` and `skillDescriptors` are optional and readonly.
// Presence: both accepted with their declared types.
const describedAgent: RunnableAgent = {
  name: 'described',
  hasOutput: false,
  description: 'Does things.',
  skillDescriptors: [
    {
      id: 'do-things',
      name: 'Do things',
      description: 'Does things.',
      tags: ['things'],
      examples: ['do a thing'],
      inputModes: ['text/plain'],
      outputModes: ['application/json'],
    },
  ],
  run: (): AgentRun => dummyRun,
};
void describedAgent;

// Absence: `wideRunAgent` above omits both and still satisfies the contract.

// A skill descriptor requires id, name, description, and tags.
const incompleteSkill: RunnableAgent = {
  name: 'incomplete',
  hasOutput: false,
  skillDescriptors: [
    // @ts-expect-error — `tags` is required on a skill descriptor.
    { id: 'x', name: 'X', description: 'X.' },
  ],
  run: (): AgentRun => dummyRun,
};
void incompleteSkill;

// The metadata is readonly on a read agent.
// @ts-expect-error — `description` is readonly.
describedAgent.description = 'changed';
// @ts-expect-error — `skillDescriptors` is readonly.
describedAgent.skillDescriptors = [];
