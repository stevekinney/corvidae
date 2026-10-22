# Tool Composition

## Overview

Compose tools with pipelines and branching utilities.

Chain and specialize tools with `pipe()`, `bind()`, `tap()`, `when()`, `parallel()`, and `retry()`. The output of each tool flows as input to the next, with full TypeScript type inference preserved across the chain. Composition helpers are exported from the `armorer` entry point.

Pipelines are first-class tools. The result of `pipe()` is an `Tool`, so you can register it, query it via registry helpers, serialize it, and export it to provider adapters just like any other tool.

### pipe()

Chains tools left-to-right (data flows forward):

```typescript file=pipeline.ts
import { createTool } from 'armorer';
import { pipe } from 'armorer';
import { z } from 'zod';

export const parseNumber = createTool({
  name: 'parse-number',
  description: 'Parse string to number',
  input: z.object({ str: z.string() }),
  execute: async ({ str }) => ({ value: parseInt(str, 10) }),
});

export const double = createTool({
  name: 'double',
  description: 'Double a number',
  input: z.object({ value: z.number() }),
  execute: async ({ value }) => ({ value: value * 2 }),
});

export const stringify = createTool({
  name: 'stringify',
  description: 'Format as result string',
  input: z.object({ value: z.number() }),
  execute: async ({ value }) => `Result: ${value}`,
});

// Chain tools together - types flow through automatically
export const pipeline = pipe(parseNumber, double, stringify);

// Input type is inferred from first tool: { str: string }
// Output type is inferred from last tool: string
const result = await pipeline({ str: '21' });
console.log(result); // "Result: 42"
```

### bind()

Bind some or all parameters of a tool and get back a new tool that only needs the remaining inputs. Bound keys are removed from the new tool's schema; any provided values for those keys are ignored in favor of the bound values.

Optional third argument: `{ name?: string; description?: string }`.

```typescript file=send-alert.ts
import { createTool } from 'armorer';
import { bind } from 'armorer';
import { z } from 'zod';

const sendEmail = createTool({
  name: 'send-email',
  description: 'Send an email',
  input: z.object({
    to: z.string().email(),
    subject: z.string(),
    body: z.string(),
  }),
  async execute({ to, subject, body }) {
    // ...
    return { to, subject, body };
  },
});

export const sendAlert = bind(sendEmail, { to: 'alerts@example.com' }, { name: 'send-alert' });
await sendAlert({ subject: 'Outage', body: 'Investigating' });
```

`bind()` operates on object schemas and removes the bound keys from the input shape.

### tap()

Run a side effect after a tool and pass through its output unchanged.

```typescript file=fetch-user.ts
import { createTool, tap } from 'armorer';
import { z } from 'zod';

export const fetchUser = createTool({
  name: 'fetch-user',
  description: 'Fetch a user by id',
  input: z.object({ id: z.string() }),
  execute: async ({ id }) => ({ id, name: 'Ada' }),
});

const loggedFetch = tap(fetchUser, (user) => {
  console.log('Fetched user', user);
});

const user = await loggedFetch({ id: 'user-123' });
```

### when()

Branch between tools based on a predicate. If no else tool is provided, the input is returned unchanged.

```typescript
import { when, type ToolWithInput } from 'armorer';

declare const sendAlert: ToolWithInput<{ severity: string }>;
declare const logTicket: ToolWithInput<{ severity: string }>;

const route = when(({ severity }) => severity === 'high', sendAlert, logTicket);

await route({ severity: 'high' });
```

### parallel()

Run multiple tools with the same input concurrently and return their outputs in order.

```typescript
import { parallel, type ToolWithInput } from 'armorer';
import { fetchUser } from './fetch-user.ts';

declare const fetchOrders: ToolWithInput<{ id: string }>;
declare const fetchUsage: ToolWithInput<{ id: string }>;

const fanout = parallel(fetchUser, fetchOrders, fetchUsage);
const outputs = await fanout({ id: 'user-123' });
if (Array.isArray(outputs)) {
  const [user, orders, usage] = outputs;
}
```

### retry()

Retry a tool on failure with configurable attempts and backoff.

```typescript
import { retry } from 'armorer';
import { fetchUser } from './fetch-user.ts';

const reliableFetch = retry(fetchUser, {
  attempts: 3,
  delayMs: 200,
  backoff: 'exponential',
});

const user = await reliableFetch({ id: 'user-123' });
```

### preprocess()

Transform inputs before they're passed to a tool. Useful for normalizing, validating, or enriching input data.

```typescript
import { createTool, preprocess } from 'armorer';
import { z } from 'zod';

const addNumbers = createTool({
  name: 'add-numbers',
  description: 'Add two numbers',
  input: z.object({ a: z.number(), b: z.number() }),
  execute: async ({ a, b }) => a + b,
});

// Preprocess to convert string numbers to actual numbers
const addNumbersWithPreprocessing = preprocess(
  addNumbers,
  z.object({ a: z.string(), b: z.string() }),
  async (input: { a: string; b: string }) => ({
    a: Number(input.a),
    b: Number(input.b),
  }),
);

// Now accepts string inputs
const result = await addNumbersWithPreprocessing({ a: '5', b: '3' });
console.log(result); // 8
```

### postprocess()

Transform outputs after a tool executes. Useful for formatting, enriching, or normalizing output data.

```typescript
import { createTool, postprocess } from 'armorer';
import { z } from 'zod';

const fetchUser = createTool({
  name: 'fetch-user',
  description: 'Fetch a user by id',
  input: z.object({ id: z.string() }),
  execute: async ({ id }) => ({ userId: id, name: 'John' }),
});

// Postprocess to format the output
// The mapper receives the tool's call return, which is typed to allow stream output too
const fetchUserFormatted = postprocess(fetchUser, async (output) => {
  const user = output as { userId: string; name: string };
  return { ...user, displayName: `${user.name} (${user.userId})` };
});

// Returns enriched output
const result = await fetchUserFormatted({ id: '123' });
// { userId: '123', name: 'John', displayName: 'John (123)' }
```

### Composed Tools are Tools

Pipelines created with `pipe()`, as well as tools created with `bind()`, `tap()`, `when()`, `parallel()`, `retry()`, `preprocess()`, and `postprocess()`, are valid tools in their own right. They implement the full `Tool` interface (and pass `isTool()`), so you can register, query via registry helpers, serialize, and adapt them just like any other tool.

```typescript
import { createToolbox, isTool } from 'armorer';
import { pipe } from 'armorer';
import { double, parseNumber, stringify } from './pipeline.ts';

const pipeline = pipe(parseNumber, double);
console.log(isTool(pipeline)); // true

// Register in a toolbox
const toolbox = createToolbox([pipeline]);

// Serialize or export
const json = pipeline.toJSON();

// Listen to events
// Step events carry their fields on the event itself
type StepEvent = Event & { stepIndex: number; stepName: string; output?: unknown };

pipeline.addEventListener('step-start', (e) => {
  const { stepIndex, stepName } = e as StepEvent;
  console.log(`Step ${stepIndex}: ${stepName}`);
});

pipeline.addEventListener('step-complete', (e) => {
  const { stepIndex, output } = e as StepEvent;
  console.log(`Step ${stepIndex} output:`, output);
});

// Compose further
const extendedPipeline = pipe(pipeline, stringify);
```

### Error Handling

Errors are wrapped with step context for debugging:

```typescript
import { pipeline } from './pipeline.ts';

try {
  await pipeline({ str: 'invalid' });
} catch (e) {
  if (e instanceof Error && e.message.includes('Pipeline failed at step')) {
    // Error message includes: "Pipeline failed at step 1 (double)"
    console.error(e.message);
  }
}

// Or use executeWith for detailed results
const result = await pipeline.executeWith({ params: { str: '21' } });
if (result.error) {
  console.error('Pipeline error:', result.error);
}
```
