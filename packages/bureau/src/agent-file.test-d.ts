// Type-level tripwire (COR-1524): `bureau.tasks.start` keeps its precise per-key type for a code-defined
// agent's literal key, and takes any string for an agent only known at run time (a file agent),
// answering with an untyped handle.

import { createAgent, createMockGenerate } from '@lostgradient/operative';
import { z } from 'zod';

import type { Bureau, TaskHandle } from './types';

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
const precise = await bureau.tasks.start('schema', 'hello');
expectEquals<typeof precise, TaskHandle<{ a: string }>>();

// A name only known at run time takes the string overload and an untyped handle.
declare const runtimeName: string;
const untyped = await bureau.tasks.start(runtimeName, 'hello');
expectEquals<typeof untyped, TaskHandle>();
