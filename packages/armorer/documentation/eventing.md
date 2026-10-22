# Eventing

## Overview

Toolbox provides typed event streams at two levels:

- **Tool events**: emitted by individual tools during validation, execution, and output handling.
- **Toolbox events**: emitted by the registry for discovery, execution lifecycle, and bubbled tool events.

Both tools and toolboxes support the same event APIs:

- `addEventListener(type, listener)`
- `on(type)`
- `once(type, listener)`
- `subscribe(type, observerOrNext)`
- `toObservable()`
- `events(type)` (async iterator)

## Tool Events

Default tool events include:

- `execute-start`
- `validate-success`
- `validate-error`
- `execute-success`
- `execute-error`
- `settled`
- `policy-denied`
- `policy-action-required`
- `progress`
- `status-update`
- `stream-start`
- `stream-chunk`
- `stream-end`
- `stream-error`
- `output-chunk`
- `log`
- `cancelled`
- `tool.started` and `tool.finished` (only when telemetry is enabled)

Example:

```typescript
import { createTool } from 'armorer';
import { z } from 'zod';

const summarize = createTool({
  name: 'summarize',
  description: 'Summarize text',
  input: z.object({ text: z.string() }),
  async execute({ text }, { progress }) {
    progress({ percent: 50, message: 'Summarizing...' });
    return text.slice(0, 50);
  },
});

summarize.addEventListener('execute-start', (event) => {
  console.log('start', event.params);
});

summarize.addEventListener('execute-success', (event) => {
  console.log('success', event.result);
});

summarize.addEventListener('progress', (event) => {
  console.log('progress', event.percent, event.message);
});
```

## Dispatching Events from Tools

Inside a tool's `execute` function, use `context.dispatch` to emit events. It takes an `Event`; the tool event classes exported from `armorer` build the standard ones. `context.progress(...)` is a shorthand for dispatching a `ToolProgressEvent`.

```typescript
import { ToolLogEvent, ToolOutputChunkEvent, ToolStatusUpdateEvent, createTool } from 'armorer';
import { z } from 'zod';

const worker = createTool({
  name: 'worker',
  description: 'Do some work',
  input: z.object({}),
  async execute(params, { dispatch }) {
    dispatch(new ToolStatusUpdateEvent({ status: 'queued' }));
    dispatch(new ToolLogEvent({ level: 'info', message: 'Starting work' }));
    dispatch(new ToolOutputChunkEvent({ chunk: { partial: true } }));
    return { done: true };
  },
});
```

## Toolbox Events

Toolbox emits registry-level events:

- `call`
- `complete`
- `error`
- `not-found`
- `query`
- `search`
- `budget-exceeded`
- `status:update`

During `toolbox.execute(...)`, toolbox also bubbles many tool events with added `tool` and `call` context:

- `tool.started`, `tool.finished`
- `execute-start`, `validate-success`, `validate-error`
- `execute-success`, `execute-error`, `settled`, `policy-denied`
- `progress`, `stream-start`, `stream-chunk`, `stream-end`, `stream-error`
- `output-chunk`, `log`, `cancelled`, `status-update`

## Streaming Events

When a tool returns an `AsyncIterable`, Armorer emits stream lifecycle events.

- `stream-start`: `{ mode: 'collect' | 'stream' }`
- `stream-chunk`: `{ chunk, index }`
- `stream-end`: `{ chunks, completed }`
- `stream-error`: `{ error, index }`

Default execution mode is collect (`stream: false`), which materializes chunks into an array result. With `stream: true`, Armorer returns a live stream on `ToolResult.stream` and `ToolResult.result`.

Example:

```typescript
import { createToolbox } from 'armorer';

const toolbox = createToolbox([]);

toolbox.addEventListener('call', (event) => {
  console.log('call', event.call.name);
});

toolbox.addEventListener('status:update', (event) => {
  console.log(`${event.name}: ${event.status}`);
});

toolbox.addEventListener('progress', (event) => {
  console.log(event.tool.name, event.percent, event.message);
});
```

## Observables and Async Iteration

You can consume event streams reactively:

```typescript
import type { AnyToolbox } from 'armorer';

declare const toolbox: AnyToolbox;

toolbox.once('complete', (event) => {
  console.log('first completion', event.tool.name);
});

const subscription = toolbox.subscribe('call', (event) => {
  console.log('called', event.call.name);
});

for await (const event of toolbox.events('error')) {
  console.error('execution error', event.result.error);
}

subscription.unsubscribe();
```

## Notes

- `query` events are emitted when `queryTools` receives a toolbox as input.
- Listen on the tool instance when you need per-tool event handling outside `toolbox.execute(...)`.
- Listen on the toolbox when you want a centralized stream across all tools.
