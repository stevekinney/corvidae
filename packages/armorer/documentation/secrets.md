# Secrets: References In, Plaintext Only Where Declared

A model, a transcript, an approval screen, and an event log should never hold a secret. Armorer lets the host keep a secret elsewhere, put a **reference** to it in a tool call, and hand the plaintext to exactly the tools that declare they need it, at the last moment.

Armorer does not store, encrypt, or decrypt anything. The host supplies a `secretResolver`; Armorer decides which tool may use it and when.

## The reference

A secret reference is a plain object whose **only** key is `secretRef`, holding a string:

```json
{ "secretRef": "review-42/apiKey" }
```

The string is the host's identifier for the secret. It is not secret; it is what the recorded call shows.

Recognition is structural and strict. An object counts only if it is a plain object (prototype `Object.prototype` or `null`) with exactly one own key, `secretRef`, whose value is a string. `{ secretRef: 'x', label: 'y' }`, `{ secretRef: 7 }`, a class instance, and an array are ordinary data and are never touched. The one collision is a tool whose own parameter is literally `{ secretRef: string }` and nothing else; such a tool should not declare `acceptsSecrets`, and a call that passes it a reference-shaped object will fail with `secret-not-accepted` before the tool runs.

References are found anywhere in a call's arguments, including inside arrays and nested objects.

## Declaring a tool

```typescript
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

const sendRequest = createTool({
  name: 'send-request',
  description: 'Calls an HTTP API with a bearer token.',
  input: z.object({
    url: z.string(),
    headers: z.object({ authorization: z.string().min(8) }),
  }),
  metadata: { acceptsSecrets: true },
  async execute({ url, headers }) {
    // `headers.authorization` is the plaintext here.
    return { status: 200, url, sent: headers.authorization.length };
  },
});

const toolbox = createToolbox([sendRequest], {
  secretResolver: async (reference, context) => {
    // Look the reference up in your secret store. `context.executionContext` and
    // `context.requestContext` say which run and principal asked; refuse the rest.
    if (reference !== 'review-42/apiKey') throw new Error('unknown secret');
    return 'Bearer sk-example';
  },
});

await toolbox.execute({
  id: 'call-1',
  name: 'send-request',
  arguments: {
    url: 'https://api.example.test',
    headers: { authorization: { secretRef: 'review-42/apiKey' } },
  },
});
```

`acceptsSecrets` is off unless the metadata says exactly `true`. Declare it only on a tool you trust with the plaintext.

## What happens to a call

For a declaring tool, in order:

1. The call is recorded and emitted exactly as received (`execute-start`, `tool.started`): the reference shows.
2. The arguments are validated in their reference form (see below), then policy and approval run on that form. A pending approval, its `arguments`, and its signature carry the reference.
3. **Immediately before `execute`**, after any approval is consumed, the toolbox calls the resolver once per distinct reference and builds a **fresh copy** of the arguments with each reference replaced by its plaintext. The recorded arguments, the caller's object, and `context.toolCall.arguments` are never edited; they keep showing the references.
4. The substituted copy is validated against the tool's input schema, and the tool receives the parsed result.

Events, policy hooks, approvals, and the result Armorer builds see the reference. A tool that returns or logs the plaintext it was given is the tool's own responsibility.

Each call has its own resolutions and its own copy, so two calls running in parallel never see each other's secrets. Within one call a reference is resolved once, however many times it appears.

### Validation and the schema

A schema that expects `z.string()` rejects the reference object, and the plaintext is not available until step 3. Armorer therefore validates in two passes:

- **Admission (reference form).** The arguments are parsed as received. A failure whose issues all sit at, or below, a reference is set aside, because those positions are judged on the plaintext later. Any other issue (a wrong type elsewhere, a missing field) fails the call as usual, before the resolver is ever called. Resuming a paused approval applies the same rule.
- **Execution (plaintext form).** The substituted copy is parsed again, and the tool receives that parse. If it fails, the error keeps each issue's path but replaces its message with a fixed sentence, because a message can quote the rejected value and the value is a secret.

Two consequences: a schema transform runs again on the substituted copy, and a refinement that inspects a secret's value should sit on the field, not on the enclosing object, because the object-level check runs on the reference form at admission.

## A tool that does not declare it

A `{ secretRef }` anywhere in the arguments of a tool without `acceptsSecrets: true` fails the call with `secret-not-accepted`. It fails before validation, policy, and approval, so no approval is requested for a call that cannot run; the resolver is never called and the tool receives nothing.

## `context.resolveSecret(reference)`

A tool can also resolve a reference itself, for a secret that arrives some other way than as an argument:

```typescript
import { createTool } from 'armorer';
import { z } from 'zod';

const signIn = createTool({
  name: 'sign-in',
  description: 'Signs in with a stored credential.',
  input: z.object({ credential: z.string() }),
  metadata: { acceptsSecrets: true },
  async execute({ credential }, context) {
    const password = await context.resolveSecret(credential);
    return { signedIn: password.length > 0 };
  },
});
```

It is gated by the same flag: for a tool without `acceptsSecrets: true` it rejects with `secret-not-accepted`. It shares the call's resolution cache, so a reference resolved for the arguments is not asked for twice.

## Errors

Both are `ToolSecretError` (an `Error` that is also a `ToolError`), exported with the codes `secretNotAcceptedCode` and `secretUnavailableCode`. In a tool result they appear as `error.code`.

| Code | Category | When |
| --- | --- | --- |
| `secret-not-accepted` | `permission` | A reference reached a tool without `acceptsSecrets: true`, or that tool called `resolveSecret`. |
| `secret-unavailable` | `unavailable` | The toolbox has no `secretResolver`, or the resolver threw, rejected, or returned something other than a string. The message names the reference; the resolver's own message is discarded so a store detail never leaks. |

Neither is retryable.

## The resolver

```typescript
import type { ToolSecretResolver } from 'armorer';

const resolver: ToolSecretResolver = (reference, context) => {
  // context.toolName, context.callId, context.signal,
  // context.requestContext, context.executionContext
  return lookup(reference, context.executionContext);
};

declare function lookup(reference: string, executionContext: unknown): string;
```

The resolver is a toolbox option and is never part of a tool's serialized configuration, so a tool registered in a toolbox always uses that toolbox's resolver. `extend()` and `combineToolboxes()` carry it forward (the first toolbox's, for `combineToolboxes`). Only a tool built with `createTool` and run directly, outside any toolbox, takes its own, from `createTool({ secretResolver })`.

The context lets the host enforce its own scoping, for example refusing a reference that belongs to another run by comparing it with `context.executionContext`. Refusing is throwing: the call fails with `secret-unavailable`.
