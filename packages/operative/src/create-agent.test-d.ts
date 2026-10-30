// Type spike pinning the fix for issue #271: "Toolbox is invariant in its
// tool-tuple parameter: bare Toolbox cannot accept createToolbox([...])
// output."
//
// Conventions (matching packages/armorer/src/toolbox-variance.test-d.ts and
// packages/conversationalist/src/state-snapshot.test-d.ts):
//   - All `declare const` are type-level only; nothing runs at runtime.
//   - This file is validated by `tsc`/`check-types` ONLY — never run under
//     `bun test`. Running it as a script produces spurious syntax errors;
//     the only oracle here is the TypeScript compiler.
//
// PR #263 (issue #258) shipped `CreateAgentOptions.toolbox` so a stateless
// chat host can pass a pre-built `Toolbox` and call `toolbox.resumeApproval()`
// across requests. That field (and `RunOptions.toolbox`) is typed
// `AnyToolbox`, armorer's erased supertype every `Toolbox<TTools>`
// structurally satisfies — this pins that a real `createToolbox([...])`
// result assigns to both with no cast and no `any`.

import type { HeadlessPermissionPolicyConfiguration } from 'armorer';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

import type { AgentSkillDescriptor } from './agent-skill-descriptor';
import type { CreateAgentOptions } from './create-agent';
import { createAgent } from './create-agent';
import type { RunOptions } from './types';

const weatherTool = createTool({
  name: 'get_weather',
  description: 'Look up the current weather for a location.',
  input: z.object({ location: z.string() }),
  execute: () => Promise.resolve({ temperature: 72 }),
});

// A concretely-typed toolbox, exactly as the issue's repro constructs it.
const concreteToolbox = createToolbox([weatherTool]);

// ---------------------------------------------------------------------------
// 1. `CreateAgentOptions.toolbox` accepts a concretely-typed toolbox with no
//    cast — the motivating example from #258/#263.
// ---------------------------------------------------------------------------

declare const mockGenerate: CreateAgentOptions['generate'];

const optionsWithToolbox: CreateAgentOptions = {
  generate: mockGenerate,
  toolbox: concreteToolbox,
};
void optionsWithToolbox;

// `createAgent` itself accepts it too, end-to-end.
const agent = createAgent({
  generate: mockGenerate,
  toolbox: concreteToolbox,
});
void agent;

const typedAgent = createAgent({
  generate: mockGenerate,
  output: z.object({ answer: z.string() }),
});
const typedRun = typedAgent.run('question');
const typedOutput: Promise<{ answer: string }> = typedRun.output();
const typedResultOutput: Promise<{ answer: string } | undefined> = typedRun
  .result()
  .then((result) => result.output);
void typedOutput;
void typedResultOutput;

const untypedRun = agent.run('question');
// @ts-expect-error — output() is only available when an output schema exists.
void untypedRun.output;
void untypedRun.result().then((result) => {
  // @ts-expect-error — untyped results do not expose output.
  void result.output;
});

declare const forwardedOptions: CreateAgentOptions;
const forwardedAgent = createAgent(forwardedOptions);
void forwardedAgent;

// ---------------------------------------------------------------------------
// 2. `RunOptions.toolbox` (the agent loop's own entry point) accepts the same
//    concretely-typed toolbox with no cast.
// ---------------------------------------------------------------------------

declare const runGenerate: RunOptions['generate'];
declare const runConversation: RunOptions['conversation'];

const runOptions: RunOptions = {
  generate: runGenerate,
  toolbox: concreteToolbox,
  conversation: runConversation,
};
void runOptions;

// ---------------------------------------------------------------------------
// 3. AB-16 — CreateAgentOptions tool-configuration exclusivity.
//
// Standalone `createAgent`'s `tools`, `toolbox`, and `permissions` fields are
// mutually exclusive at runtime (see `validateCreateAgentOptions` in
// `create-agent.ts`). This section pins that the SAME exclusivity is now
// enforced at the type level: every valid combination assigns with no cast,
// and every invalid combination is a type error (verified with
// `// @ts-expect-error`). One case per matrix row from AB-16's acceptance
// criteria.
// ---------------------------------------------------------------------------

declare const somePermissions: NonNullable<CreateAgentOptions['permissions']>;
declare const someTools: Record<string, typeof weatherTool>;

// --- Positive: no tool configuration at all. -------------------------------
const optionsNone: CreateAgentOptions = {
  generate: mockGenerate,
};
void optionsNone;

// --- Positive: `tools` alone. -----------------------------------------------
const optionsTools: CreateAgentOptions = {
  generate: mockGenerate,
  tools: someTools,
};
void optionsTools;

// --- Positive: `permissions` alone. -----------------------------------------
const optionsPermissions: CreateAgentOptions = {
  generate: mockGenerate,
  permissions: somePermissions,
};
void optionsPermissions;

// --- Positive: `tools` + `permissions`. -------------------------------------
const optionsToolsAndPermissions: CreateAgentOptions = {
  generate: mockGenerate,
  tools: someTools,
  permissions: somePermissions,
};
void optionsToolsAndPermissions;

// --- Positive: `toolbox` alone. ---------------------------------------------
const optionsToolboxOnly: CreateAgentOptions = {
  generate: mockGenerate,
  toolbox: concreteToolbox,
};
void optionsToolboxOnly;

// --- Positive: an explicitly `undefined` excluded field is treated as
//     omitted, not as "present" for exclusivity purposes.
const optionsToolboxWithExplicitUndefined: CreateAgentOptions = {
  generate: mockGenerate,
  toolbox: concreteToolbox,
  tools: undefined,
  permissions: undefined,
};
void optionsToolboxWithExplicitUndefined;

const optionsToolsWithExplicitUndefinedToolbox: CreateAgentOptions = {
  generate: mockGenerate,
  tools: someTools,
  toolbox: undefined,
};
void optionsToolsWithExplicitUndefinedToolbox;

// --- Positive: forwarding an already-optional (`T | undefined`-typed)
//     `tools`/`permissions` value, as a caller commonly does when threading
//     an upstream optional through unchanged, is accepted — not just a
//     literal `undefined` or a concretely-present value.
declare const maybeTools: Record<string, typeof weatherTool> | undefined;
declare const maybePermissions: HeadlessPermissionPolicyConfiguration | undefined;

const optionsForwardedOptionalTools: CreateAgentOptions = {
  generate: mockGenerate,
  tools: maybeTools,
};
void optionsForwardedOptionalTools;

const optionsForwardedOptionalToolsAndPermissions: CreateAgentOptions = {
  generate: mockGenerate,
  tools: maybeTools,
  permissions: maybePermissions,
};
void optionsForwardedOptionalToolsAndPermissions;

// --- Negative: `tools` + `toolbox` is rejected. -----------------------------
// @ts-expect-error — `tools` and `toolbox` are mutually exclusive.
const optionsToolsAndToolbox: CreateAgentOptions = {
  generate: mockGenerate,
  tools: someTools,
  toolbox: concreteToolbox,
};
void optionsToolsAndToolbox;

// --- Negative: `toolbox` + `permissions` is rejected. -----------------------
// @ts-expect-error — `toolbox` and `permissions` are mutually exclusive.
const optionsToolboxAndPermissions: CreateAgentOptions = {
  generate: mockGenerate,
  toolbox: concreteToolbox,
  permissions: somePermissions,
};
void optionsToolboxAndPermissions;

// --- Negative: all three together is rejected. ------------------------------
// @ts-expect-error — `tools`/`permissions` combined with `toolbox` are mutually exclusive.
const optionsAllThree: CreateAgentOptions = {
  generate: mockGenerate,
  tools: someTools,
  toolbox: concreteToolbox,
  permissions: somePermissions,
};
void optionsAllThree;

// --- COR-1913: `toolboxOptions` beside `tools`, never beside `toolbox`. -------
const optionsToolboxOptions: CreateAgentOptions = {
  generate: mockGenerate,
  tools: someTools,
  toolboxOptions: () => ({ approvalSecret: 'secret' }),
};
void optionsToolboxOptions;

// @ts-expect-error — `toolboxOptions` configures a toolbox `createAgent` builds, not `toolbox`.
const optionsToolboxAndToolboxOptions: CreateAgentOptions = {
  generate: mockGenerate,
  toolbox: concreteToolbox,
  toolboxOptions: () => ({}),
};
void optionsToolboxAndToolboxOptions;

// `createAgent(...)` itself rejects the same invalid combinations end-to-end,
// not just the bare options object.
// @ts-expect-error — `tools` and `toolbox` are mutually exclusive.
const agentWithToolsAndToolbox = createAgent({
  generate: mockGenerate,
  tools: someTools,
  toolbox: concreteToolbox,
});
void agentWithToolsAndToolbox;

// ---------------------------------------------------------------------------
// COR-1301 — `description` and `skillDescriptors` are optional on the options
// and surface readonly on the returned agent, independent of the runtime
// `skills` seam.
// ---------------------------------------------------------------------------

const describedOptions: CreateAgentOptions = {
  generate: mockGenerate,
  description: 'Looks things up.',
  skillDescriptors: [{ id: 'lookup', name: 'Lookup', description: 'Looks up.', tags: [] }],
};
void describedOptions;

const bareOptions: CreateAgentOptions = { generate: mockGenerate };
void bareOptions;

const describedAgent = createAgent(describedOptions);
const descriptionValue: string | undefined = describedAgent.description;
void descriptionValue;
// @ts-expect-error — `description` is readonly on the returned agent.
describedAgent.description = 'changed';

const badSkillOptions: CreateAgentOptions = {
  generate: mockGenerate,
  // @ts-expect-error — a skill descriptor requires `tags`.
  skillDescriptors: [{ id: 'x', name: 'X', description: 'X.' }],
};
void badSkillOptions;

// `skillDescriptors` is present and readonly on the returned StandaloneAgent.
const descriptorsValue: readonly AgentSkillDescriptor[] | undefined =
  describedAgent.skillDescriptors;
void descriptorsValue;
// @ts-expect-error — `skillDescriptors` is readonly on the returned agent.
describedAgent.skillDescriptors = [];
