// Type-level tripwire (COR-1524): `bureau.run` keeps its precise per-key type for a code-defined
// agent's literal key, and takes any string for an agent only known at run time (a file agent),
// answering with an untyped handle.

import type { AgentRun } from '@lostgradient/operative';
import { createAgent, createMockGenerate } from '@lostgradient/operative';
import { z } from 'zod';

import type { Bureau } from './types';

const agents = {
  plain: createAgent({ generate: createMockGenerate([]), name: 'plain' }),
  schema: createAgent({
    generate: createMockGenerate([]),
    name: 'schema',
    output: z.object({ a: z.string() }),
  }),
};

declare const bureau: Bureau<typeof agents>;

type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function expectEquals<A, B>(..._args: Equals<A, B> extends true ? [] : [never]): void {}

// A literal key of the code-defined map keeps its precise type.
const precise = bureau.run('schema', 'hello');
expectEquals<Awaited<ReturnType<typeof precise.unwrap>>, { a: string }>();

// A name only known at run time takes the string overload and an untyped handle.
declare const runtimeName: string;
const untyped = bureau.run(runtimeName, 'hello');
expectEquals<typeof untyped, AgentRun<unknown, boolean>>();
