# Lifecycle

`@lostgradient/lifecycle` contains the shared event and hook primitives used across Agent Bureau. It has no agent-domain behavior of its own; it provides the typed infrastructure that other packages use to publish state, expose observables, and compose hooks.

## Workspace usage

Declare `"@lostgradient/lifecycle": "workspace:*"` in the consuming workspace's dependencies. Install dependencies from the Corvidae root with `bun install`. Import the private package through `@lostgradient/lifecycle`; it exports TypeScript source directly and has no library build or publication step.

## What It Does

- Provides `TypedEventTarget` for strongly typed DOM-style events.
- Adds `CompletableEventTarget` for event sources that can close cleanly.
- Converts events into async iterators and observable-like subscriptions.
- Forwards events between sources while preserving type information.
- Provides `HookRegistry` and `mergeHookRegistries()` for package-level extension points.

## How It Works

The package wraps the standard [`EventTarget`](https://developer.mozilla.org/docs/Web/API/EventTarget) behavior in TypeScript types rather than inventing another event system. Runtime packages dispatch events through these primitives, and consumers can choose the most convenient consumption style: listener callbacks, async iteration, or observable subscriptions.

Hooks are stored in registries keyed by hook maps. Packages such as `operative` use that pattern to expose lifecycle customization without hard-coding every integration into the run loop.

## Project Role

`lifecycle` is the shared substrate for observability and extension. `conversationalist`, `armorer`, and `@lostgradient/operative` all rely on its event streams or hooks. Host applications use the same primitives when they compose those packages, which keeps lifecycle behavior consistent across the workspace.

## Public API

### `TypedEventTarget`

**Signature:** `class TypedEventTarget<M extends EventMap> extends EventTarget`

A type-safe wrapper around the native `EventTarget`. `M` is a record mapping event-type strings to their `Event` subclasses. `addEventListener`, `removeEventListener`, and the added `dispatch()` method all enforce that the event type exists in `M` and that the listener receives the correct event subclass.

**`dispatch(event)`** is the primary addition over the native API—it accepts only events whose `type` key is present in `M`, so typos in event names become compile errors.

```typescript
import { TypedEventTarget } from '@lostgradient/lifecycle';

class ProgressEvent extends Event {
  constructor(public readonly percent: number) {
    super('progress');
  }
}

class DoneEvent extends Event {
  constructor() {
    super('done');
  }
}

type WorkEvents = {
  progress: ProgressEvent;
  done: DoneEvent;
};

class Worker extends TypedEventTarget<WorkEvents> {
  run() {
    this.dispatch(new ProgressEvent(50));
    this.dispatch(new DoneEvent());
  }
}

const worker = new Worker();

worker.addEventListener('progress', (event) => {
  // event is typed as ProgressEvent
  console.log(event.percent);
});

worker.run();
```

### `CompletableEventTarget`

**Signature:** `class CompletableEventTarget<M extends EventMap> extends TypedEventTarget<M>`

Extends `TypedEventTarget` with lifecycle management and convenience consumption methods. Internally it holds an `AbortController`; calling `complete()` aborts it, which signals all async iterators and observable subscriptions created through this instance to stop cleanly.

**Properties and methods:**

- **`completed`**: `boolean`—`true` once `complete()` has been called.
- **`signal`**: `AbortSignal`—the underlying signal; pass it to external listeners for coordinated teardown.
- **`complete()`**: Marks the target as done and terminates all active subscriptions and iterators tied to it.
- **`on(type, options?)`**: Returns an `ObservableLike<M[K]>` for a single event type, automatically wired to the target's completion signal.
- **`once(type, listener)`**: Registers a one-shot listener with `{ once: true }` tied to the completion signal so it is removed on `complete()` if the event never fires.
- **`subscribe(type, observerOrNext?, error?, complete?)`**: Shorthand for `this.on(type).subscribe(...)`.
- **`toObservable()`**: Returns an `ObservableLike` that emits _every_ event dispatched on this target and completes when `complete()` is called. This is the integration point used by `forwardEvents()`.
- **`events(type, options?)`**: Returns an `AsyncIterableIterator<M[K]>` for the given event type, terminated by the target's signal.

```typescript
import { CompletableEventTarget } from '@lostgradient/lifecycle';

type StreamEvents = {
  data: MessageEvent;
  end: Event;
};

class DataStream extends CompletableEventTarget<StreamEvents> {
  async produce() {
    for (let i = 0; i < 3; i++) {
      this.dispatch(
        new MessageEvent('data', { data: `chunk-${i}` }) as MessageEvent & { type: 'data' },
      );
    }
    this.dispatch(new Event('end') as Event & { type: 'end' });
    this.complete();
  }
}

const stream = new DataStream();

// Async iteration
(async () => {
  for await (const event of stream.events('data')) {
    console.log(event.data); // 'chunk-0', 'chunk-1', 'chunk-2'
  }
})();

// Observable subscription
stream.on('data').subscribe({
  next(event) {
    console.log('rx', event.data);
  },
  complete() {
    console.log('done');
  },
});

stream.produce();
```

### `eventIterator()`

**Signature:**

```typescript
function eventIterator<E extends Event>(
  target: EventTarget,
  type: string,
  options?: EventIteratorOptions,
): AsyncIterableIterator<E>;
```

Adapts any `EventTarget` into an `AsyncIterableIterator`. Events are buffered in a pull-based queue (default capacity: 256 events). The iterator terminates when the provided `AbortSignal` fires or when the caller calls `iterator.return()`.

`EventIteratorOptions`:

- **`signal`**: `AbortSignal`—when aborted, the iterator yields `done: true` on the next `next()` call and removes its listener.
- **`bufferSize`**: `number`—maximum number of unconsumed events to buffer before dropping new ones (default `256`).

```typescript
import { eventIterator } from '@lostgradient/lifecycle';

const controller = new AbortController();
const target = new EventTarget();

const iterator = eventIterator<MessageEvent>(target, 'message', {
  signal: controller.signal,
});

// Consume with for-await
(async () => {
  for await (const event of iterator) {
    console.log(event.data);
    if (event.data === 'stop') break; // calls iterator.return() internally
  }
})();

target.dispatchEvent(new MessageEvent('message', { data: 'hello' }));
target.dispatchEvent(new MessageEvent('message', { data: 'stop' }));

// Or terminate from outside
controller.abort();
```

### `eventObservable()`

**Signature:**

```typescript
function eventObservable<E extends Event>(
  target: EventTarget,
  type: string,
  options?: EventObservableOptions,
): ObservableLike<E>;
```

Returns a TC39-style `ObservableLike` for a single event type on any `EventTarget`. The observable completes when the optional `AbortSignal` fires or when `subscription.unsubscribe()` is called.

`EventObservableOptions`:

- **`signal`**: `AbortSignal`—combined with the subscription's own controller via `AbortSignal.any()`.

```typescript
import { eventObservable } from '@lostgradient/lifecycle';

const target = new EventTarget();
const controller = new AbortController();

const subscription = eventObservable<MouseEvent>(target, 'click', {
  signal: controller.signal,
}).subscribe({
  next(event) {
    console.log('clicked at', event.clientX, event.clientY);
  },
  complete() {
    console.log('stream closed');
  },
});

// Stop listening
subscription.unsubscribe();

// Or let the AbortSignal close it
controller.abort();
```

### `allEventsObservable()`

**Signature:**

```typescript
function allEventsObservable<E extends Event>(
  target: EventTarget,
  eventTypes: readonly string[],
  options?: EventObservableOptions,
): ObservableLike<E>;
```

Like `eventObservable()`, but subscribes to multiple event types at once and merges them into a single stream. All event types share one subscription and one `unsubscribe()` call.

```typescript
import { allEventsObservable } from '@lostgradient/lifecycle';

const target = new EventTarget();

const subscription = allEventsObservable<Event>(target, [
  'mousedown',
  'mouseup',
  'click',
]).subscribe((event) => {
  console.log(event.type); // 'mousedown' | 'mouseup' | 'click'
});

// One call cleans up all three listeners
subscription.unsubscribe();
```

### `ForwardedEvent` and `forwardEvents()`

**`ForwardedEvent`**

**Signature:** `class ForwardedEvent<TOriginal extends Event = Event> extends Event`

A wrapper event that carries an original event under a new prefixed type string. `originalEvent` holds a reference to the unwrapped event.

```typescript
constructor(type: string, originalEvent: TOriginal)
readonly originalEvent: TOriginal
```

**`forwardEvents()`**

**Signature:**

```typescript
function forwardEvents(
  source: ForwardableSource,
  target: EventTarget,
  prefix: string,
  options?: { signal?: AbortSignal },
): { stop(): void };
```

Subscribes to every event on `source` (via `source.toObservable()`) and re-dispatches each one as a `ForwardedEvent` on `target` with the event type prefixed as `"${prefix}.${event.type}"`. Returns a handle with a `stop()` method to cancel forwarding.

`ForwardableSource`:

```typescript
interface ForwardableSource {
  toObservable(): ObservableLike<Event>;
}
```

`CompletableEventTarget` implements `ForwardableSource` via its `toObservable()` method, making it the natural source for this function.

```typescript
import { CompletableEventTarget, ForwardedEvent, forwardEvents } from '@lostgradient/lifecycle';

type ChildEvents = { data: MessageEvent; error: ErrorEvent };

const child = new CompletableEventTarget<ChildEvents>();
const hub = new EventTarget();

// hub will receive 'child.data' and 'child.error' events
const forwarding = forwardEvents(child, hub, 'child');

hub.addEventListener('child.data', (raw) => {
  const event = raw as ForwardedEvent<MessageEvent>;
  console.log('forwarded:', event.originalEvent.data);
});

child.dispatch(new MessageEvent('data', { data: 'hello' }) as MessageEvent & { type: 'data' });

// Stop forwarding
forwarding.stop();
```

### `HookRegistry`

**Signature:** `class HookRegistry<M extends HookMap>`

A priority-ordered registry for named async hooks. `M` maps hook names to their handler function signatures. Handlers registered with a higher `priority` number run first; equal priorities keep registration order, because the sort is stable.

**Pick the dispatch method that matches your hook's shape.** The three differ in what each handler receives and which result is returned, and choosing the wrong one is silent when only a single handler is registered:

| Method | Each handler receives | Returns | Use when |
| --- | --- | --- | --- |
| `run` | the previous handler's non-`undefined` return in place of the first argument | the last returned value | the handler's return type **is** its first parameter type, so the substitution is meaningful — a transform pipeline |
| `runFirst` | the caller's arguments, unchanged | the first non-`undefined` return; later handlers do not run | a handler that answers ends the question — a short-circuit or a veto |
| `runLast` | the caller's arguments, unchanged | the last non-`undefined` return; every handler runs | every handler is consulted and the lowest-priority answer wins — an override |

`run` is a genuine footgun for a hook whose return type differs from its first parameter type. `(context: StepContext) => GenerateResponse | undefined` under `run` hands the second handler a `GenerateResponse` where it expects a `StepContext`. Nothing catches this at compile time, and with exactly one registered handler the loop ends before the substituted argument is ever read — so the defect stays invisible until someone registers a second. Use `runFirst` or `runLast` for those.

**Methods:**

- **`on(hookName, handler, options?)`**: Registers a handler. Returns an unsubscribe function.
- **`run(hookName, ...args)`**: Waterfall. Executes all handlers in priority order, substituting each non-`undefined` return for the first argument, and returns the final transformed value (or `undefined` if no handler returned one). See the table above for when this is the wrong method.
- **`runFirst(hookName, ...args)`**: Executes handlers in priority order against the caller's unmodified arguments and returns the first non-`undefined` result, leaving later handlers uninvoked.
- **`runLast(hookName, ...args)`**: Executes every handler against the caller's unmodified arguments and returns the last non-`undefined` result.
- **`runHandler(hookName, entry, args)`**: Invokes one already-resolved `getHandlers()` entry under this registry's observation. For a call site whose threading none of the three dispatch methods expresses — one that interleaves work between handlers, or waterfalls a _field_ of its context rather than the context itself. Routing a hand-written loop through this keeps one invocation path, so an observer sees a hand-iterated hook exactly as it sees a dispatched one.
- **`observe(observer)`**: Attaches a read-only observer of registrations, removals and handler invocations. Returns an unsubscribe function. See [Observing a hook plan](#observing-a-hook-plan).
- **`has(hookName)`**: Returns `true` if at least one handler is registered for the hook.
- **`clear(hookName?)`**: Removes all handlers for the named hook, or all handlers across every hook when called without arguments.
- **`getHandlers(hookName)`**: Returns registered handlers sorted by priority descending—used internally by `mergeHookRegistries`, and by callers that need to iterate handlers manually (see `onError` below).
- **`getHookNames()`**: Returns all hook names that have at least one registered handler.

**Accessors:**

- **`onError`**: `HookErrorHandler | undefined`—the registry-wide error fallback passed to the constructor, if any. `run()` already applies this automatically (falling back to it when a handler has no per-registration `onError`); this accessor exists for a caller that iterates `getHandlers()` results manually instead of calling `run()`—for example to interleave other work between handlers—so it can apply the identical `entry.options.onError ?? registry.onError` fallback rather than silently bypassing it.

`HookRegistrationOptions`:

- **`priority`**: `number`—higher runs first (default `0`).
- **`onError`**: `HookErrorHandler`—called when the handler throws; return `'continue'` to skip to the next handler or `'abort'` to rethrow.
- **`replay`**: `HookReplayPolicy`—documentation-only classification (`'safe'` | `'effectful'`) for durable-recovery replay semantics; never gates execution at runtime.

`HookRegistryOptions`:

- **`onError`**: `HookErrorHandler`—registry-wide error fallback used when a handler's own `onError` is not set.
- **`now`**: `() => number`—clock backing the `durationMilliseconds` an observer receives. Defaults to `Date.now`; inject for deterministic tests.

**Registration identity.** `HookRegistrationOptions.id` names one registration, so an observer can correlate the same hook across invocations and across runs. Supply one when you have a meaningful name; otherwise the registry assigns `<hookName>#<n>` from a counter that never reuses a value, so an id is never recycled after an unregistration. Prefer an explicit id for a hook registered inside a conditional block — a generated number renumbers whenever an earlier block does not register, so the same hook would answer to different names depending on configuration.

```typescript
import { HookRegistry } from '@lostgradient/lifecycle';

type BuildHooks = {
  'before-compile': (source: string) => string | undefined;
  'after-compile': (output: string) => void;
};

const hooks = new HookRegistry<BuildHooks>({
  onError: (error, { hookName }) => {
    console.warn(`Hook ${hookName} threw, continuing`, error);
    return 'continue';
  },
});

// Register handlers
const unsubscribe = hooks.on('before-compile', (source) => source.trim(), { priority: 10 });

hooks.on('before-compile', (source) => `/* generated */\n${source}`);

// Run the pipeline
const result = await hooks.run('before-compile', '  let x = 1;  ');
// result => '/* generated */\nlet x = 1;'

// Remove a specific handler
unsubscribe();

// Check and clear
console.log(hooks.has('before-compile')); // true (one handler remains)
hooks.clear('before-compile');
console.log(hooks.has('before-compile')); // false
```

### Hierarchical hook priority bands (COR-567)

`@lostgradient/operative` and `@lostgradient/bureau` compose a Bureau/Agent/direct-run hook hierarchy on top of this registry. `mergeHookRegistries` (below) offsets each tier by `(tierCount - 1 - tierIndex) * 1000`, over the fixed tier order `[bureau, agent, direct]`—the earliest-listed tier (Bureau) receives the highest offset.

`HookRegistry` dispatches through three shapes, and which one a hook point uses decides who that offset actually protects. `runFirst` runs handlers in priority order against the same arguments and returns the first defined result, leaving the rest uninvoked—the highest band wins outright, so the default Bureau-highest offset is already enough. `runLast` and the plain `run` waterfall both run every handler; `runLast` hands every handler the same unmodified arguments and keeps the last defined result, while `run` additionally feeds each handler's defined return to the next as its first argument. Either way the lowest-priority handler runs last and answers last, so on these two shapes the lowest band—typically direct-run—has the final say by default, the opposite of `runFirst`. A Bureau invariant registered on a `runLast` or plain `run` hook point must therefore use an explicit low `priority` to remain the final word; on a `runFirst` point, the bureau band already wins without one.

That explicit value is `BUREAU_PINNED_LAST_PRIORITY` in `@lostgradient/bureau`, and it is `Number.MIN_SAFE_INTEGER + 2000` rather than a small negative number. The offset is what forces the size: Bureau is always the first participant, so it receives the largest one, and a pinned entry has to sit far enough below `MIN_SAFE_INTEGER` plus that offset to stay under anything another tier declared. `+2000` is the largest offset three tiers can produce, so adding it back cannot leave the safe-integer range. The limit is worth knowing: a tier that deliberately registers at or below `MIN_SAFE_INTEGER + 2000` sorts after Bureau anyway. No finite constant closes that, and `-Infinity` closes it only until a second entry carries it, at which point `b.priority - a.priority` returns `NaN` and the sort is no longer defined.

Tiers are named, not inferred. A tier builds its registry with `new HookRegistry({ source: 'bureau' })`, `on()` stamps that name onto each entry, and the stamp rides in `options` through any number of merges. It lives on the entry rather than only on the registry because a merged plan is one registry holding many tiers: afterwards the registry can no longer say where an entry came from, but the entry still can. `describePlan()` reports it, which is what lets an inspector answer which hook sources applied to a run.

### Observing a hook plan

`observe(observer)` reports what happens to a registry's membership and to its handlers, without being able to change any of it. Returns an unsubscribe function.

```typescript
const stop = hooks.observe((observation) => {
  switch (observation.kind) {
    case 'registered':
      console.log(`+ ${observation.hookName}/${observation.id} @${observation.priority}`);
      return;
    case 'removed':
      console.log(`- ${observation.hookName}/${observation.id}`);
      return;
    case 'invoked':
      console.log(`  ${observation.id} ok in ${observation.durationMilliseconds}ms`);
      return;
    case 'failed':
      console.log(`  ${observation.id} threw`, observation.error);
      return;
  }
});

stop();
```

`invoked` and `failed` are mutually exclusive outcomes of one invocation: exactly one fires per handler call, never both and never neither. `failed` fires for the throw itself, _before_ the error policy decides whether to continue or abort — so a handler whose `onError` returns `'continue'` is still reported rather than silently absorbed.

**Past registrations are not replayed.** An observer attached to an already-populated registry sees nothing until the next thing happens. This is deliberate: replaying would make "observer attached late" indistinguishable from "entry registered late" for every subscriber. A subscriber that wants the entries already present censuses them itself through `getHookNames()` and `getHandlers()` before attaching — which is what `@lostgradient/operative` does to emit `hook-plan.registered` for a plan composed before the run started.

**An observer must not throw.** One that does is routed to the registry's `onError` when configured, and otherwise re-thrown from a microtask so it surfaces as an unhandled error. It never fails the hook invocation it observed, and one broken observer does not blind the others.

**Unsubscribe when the observer outlives its purpose.** A registry reused across runs accumulates one observer per run otherwise, each dispatching into an emitter whose run has already settled.

### `mergeHookRegistries()`

**Signature:**

```typescript
function mergeHookRegistries<M extends HookMap>(
  ...registries: (HookRegistry<M> | undefined)[]
): HookRegistry<M>;
```

Combines multiple `HookRegistry` instances into a new registry. Registries listed earlier receive a higher priority offset (increments of 1000 per position), so handlers from the first registry run before those from later ones at equal declared priority. `undefined` entries are silently skipped, making it safe to spread optional hook sources.

```typescript
import { HookRegistry, mergeHookRegistries } from '@lostgradient/lifecycle';

type AppHooks = {
  'on-request': (url: string) => string | undefined;
};

const coreHooks = new HookRegistry<AppHooks>();
coreHooks.on('on-request', (url) => url.toLowerCase());

const pluginHooks = new HookRegistry<AppHooks>();
pluginHooks.on('on-request', (url) => `${url}?plugin=true`);

const optionalHooks: HookRegistry<AppHooks> | undefined = undefined;

const merged = mergeHookRegistries(coreHooks, pluginHooks, optionalHooks);

const result = await merged.run('on-request', 'https://Example.com/API');
// coreHooks handler runs first (higher offset): 'https://example.com/api'
// pluginHooks handler runs second: 'https://example.com/api?plugin=true'
console.log(result); // 'https://example.com/api?plugin=true'
```

### `createManualRuntimeServices()` identifier seeding

The cross-package ownership and cleanup matrix is collected in [Runtime contracts across Corvidae](../../documentation/runtime-contracts.md).

**Signature:** `function createManualRuntimeServices(options?: CreateManualRuntimeServicesOptions): ManualRuntimeServices`

`createManualRuntimeServices()` is the deterministic, injectable implementation of the `RuntimeServices` contract—a test or a durable-recovery path swaps it in for `createDefaultRuntimeServices()`'s real-globals implementation. Every identifier its `identifiers.next(kind)` mints has the shape `` `${identifierPrefix}-${kind}-${n}` ``, where `n` is a per-`kind` counter starting at 1 and `identifierPrefix` is a short, stable hash-derivation of the instance's `identifierSeed` (Coordinator ruling on AB-337).

This means two `ManualRuntimeServices` instances constructed with **different** `identifierSeed`s are, barring a hash collision, extremely unlikely to mint the same identifier—their prefixes almost certainly differ, so their identifier sets are practically disjoint—while two instances constructed with the **same** `identifierSeed` still mint byte-identical sequences (AB-92's reproduction guarantee is unchanged).

```typescript
import { createManualRuntimeServices } from '@lostgradient/lifecycle';

const a = createManualRuntimeServices({ identifierSeed: 'runtime-a' });
const b = createManualRuntimeServices({ identifierSeed: 'runtime-b' });

a.identifiers.next('conversation'); // `${a.identifierPrefix}-conversation-1`
b.identifiers.next('conversation'); // `${b.identifierPrefix}-conversation-1`—practically never collides with a's

const c = createManualRuntimeServices({ identifierSeed: 'runtime-a' });
c.identifiers.next('conversation'); // identical to a's own first `conversation` id
```

The runtime service is also the ownership seam for cleanup. `deferred.track(promise, label)` records fire-and-forget work, and `await deferred.drain()` returns both settled outcomes and labels that remain outstanding. Use the returned `outstanding` list in a test or shutdown report; do not turn a still-running promise into a successful cleanup result merely because its abort signal fired.

```typescript
import { createManualRuntimeServices } from '@lostgradient/lifecycle';

const runtime = createManualRuntimeServices({ identifierSeed: 'test' });
runtime.deferred.track(Promise.resolve(), 'audit-write');
const report = await runtime.deferred.drain();
// report.settled[0] is { label: 'audit-write', outcome: 'resolved' }
// report.outstanding is []
```

Use `createDefaultRuntimeServices()` at an application boundary and pass that value down. Use a manual runtime in deterministic tests so clocks, identifiers, timers, randomness, and deferred work share one explicit owner. The package does not provide a global clock or a second cleanup protocol.

Omitting `identifierSeed` gets a generated, process-unique value instead—this is what keeps two independently constructed runtimes with no explicit seed from colliding too, most concretely a durable run rehydrated in a freshly recovered process (AB-321): the recovered process's runtime never reuses the seed (and therefore the identifier prefix) the crashed process's runtime used. A caller that needs a reproducible sequence across processes or test runs still passes an explicit `identifierSeed`; both `identifierSeed` and the derived `identifierPrefix` are exposed on the returned `ManualRuntimeServices` so a test can derive an expected identifier instead of pinning a literal string that would drift with the seed.

## Supporting Types

These types are re-exported from the package root for use in consuming packages.

- **`EventMap`**: `Record<string, Event>`—the constraint for event-map type parameters.
- **`ObservableLike<T>`**: The `subscribe()` interface returned by `eventObservable()`, `allEventsObservable()`, `CompletableEventTarget#on()`, and `CompletableEventTarget#toObservable()`.
- **`Observer<T>`**: `{ start?, next?, error?, complete? }`—the observer object accepted by `ObservableLike#subscribe()`.
- **`Subscription`**: `{ unsubscribe(): void; readonly closed: boolean }`—the handle returned by `ObservableLike#subscribe()`.
- **`EventIteratorOptions`**: Options for `eventIterator()` (`signal`, `bufferSize`).
- **`EventObservableOptions`**: Options for `eventObservable()` and `allEventsObservable()` (`signal`).
- **`ForwardableSource`**: `{ toObservable(): ObservableLike<Event> }`—the interface required by `forwardEvents()`.
- **`HookMap`**: `Record<string, (...args: never[]) => unknown>`—the constraint for hook-map type parameters.
- **`HookErrorHandler`**: `(error: unknown, context: { hookName: string; handlerIndex: number }) => 'continue' | 'abort'`—the error handler type for hooks.
- **`HookRegistrationOptions`**: Per-handler options (`priority`, `onError`, `replay`).
- **`HookRegistryOptions`**: Registry-wide options (`onError`).
- **`HookReplayPolicy`**: `'safe' | 'effectful'`—metadata-only classification for durable-recovery replay documentation.

## Development

Run the focused checks from this package directory:

```bash
bun run lint
bun run typecheck
bun run test
```

From the Corvidae root, run `bunx turbo run lint typecheck test --filter=@lostgradient/lifecycle` for this workspace or `bun run validate` for the complete workspace. Formatting is configured at the root. This library has no build or publishing command.
