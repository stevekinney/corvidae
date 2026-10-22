# Command receipts, version 1

Extension URI: `https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/command-receipts-v1.md`

This extension makes an A2A 1.0.1 message command idempotent, fenceable, and bounded in time, and reports how far the server got with it. It adds a receipt state, an `expectedRevision` fence, and a `deadline` to `SendMessage` and `SendStreamingMessage`, the two A2A commands whose request carries a message, and a typed conflict when a message identifier is reused. It also specifies the idempotency that `CancelTask` and the push-notification configuration methods rely on, because those have fixed shapes with nowhere to carry a receipt. A client needs nothing but this document and [the A2A specification](https://a2a-protocol.org/v1.0.1/specification/) to use it.

The URI is a stable identifier that clients compare as an opaque string. A client never needs to fetch it.

## Conventions in this document

Key words (MUST, SHOULD, MAY) have their RFC 2119 meaning. Examples are JSON-RPC 2.0 over HTTP, with A2A's JSON field names.

The `json` fences below that follow an HTML comment marker are machine-checked by `scripts/check-a2a-extension-schemas.ts` (`bun run --filter=@lostgradient/weft lint`):

- `<!-- schema: <name> -->` makes the next `json` fence a JSON Schema (draft 2020-12) named `<name>`.
- `<!-- example: <name> at <pointer> -->` makes the next `json` fence an example document. The value at the RFC 6901 JSON Pointer `<pointer>` must validate against schema `<name>`. `{uri}` in a pointer stands for this extension's URI, escaped as one pointer segment; an empty pointer is the whole document.

## Declaration

A server advertises the extension in its Agent Card under `capabilities.extensions` only when it has the durable stores the guarantees need: a persistent request ledger for run creation and a durable mailbox for commands to an existing task. A server without them omits the entry and makes no guarantee in this document.

<!-- example: params at /params -->

```json
{
  "uri": "https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/command-receipts-v1.md",
  "description": "Idempotent message commands with receipt states, expectedRevision fencing, deadlines, and typed conflicts.",
  "required": false,
  "params": {}
}
```

`required` is always `false`: a client that does not know the extension gets plain A2A behavior.

### `AgentExtension.params`

Version 1 defines no parameters. A server sends `params` as an empty object or omits it. A client ignores keys it does not recognize.

<!-- schema: params -->

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Command receipts AgentExtension.params",
  "type": "object",
  "additionalProperties": false
}
```

## Activation

A client activates the extension per request by listing its URI in the `A2A-Extensions` request header (a comma-separated list of URIs). The server echoes the extensions it applied in the `A2A-Extensions` response header. A field that belongs to this extension is ignored unless the request activates it, so a client that does not activate it gets plain A2A behavior: no receipt in responses, and a plain `-32602` on `messageId` reuse.

## Versioning

The major version is part of the URI. A breaking change publishes a new URI (`command-receipts-v2.md`) and the server never falls back to an older version on its own. A server MAY advertise several majors at once.

## Metadata namespace

Extension data lives in `metadata` under the key that is this extension's URI. It never repurposes a core A2A field. Two schemas describe the object under that key, one for requests and one for responses.

### On a request

The client puts the object in `params.message.metadata`, because `SendMessage` and `SendStreamingMessage` carry the message.

| Field | Type | Meaning |
| --- | --- | --- |
| `expectedRevision` | string | The task revision the command is meant to apply to, copied from a response's `revision`. Opaque; the server compares it for equality only. Applies to a continuation (a message with a `taskId`); on a message that creates a task it is ignored. |
| `deadline` | string | An absolute RFC 3339 timestamp with a `Z` or numeric offset. The command expires if it has not applied by then. |

<!-- schema: request-metadata -->

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Command receipts request metadata namespace",
  "type": "object",
  "properties": {
    "expectedRevision": { "type": "string", "minLength": 1 },
    "deadline": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?(Z|[+-]\\d{2}:\\d{2})$"
    }
  },
  "additionalProperties": false
}
```

### The correlation identifier is not part of this namespace

A caller-chosen correlation identifier travels as `params.message.metadata.correlationId`, a top-level key of the message's `metadata`, outside every extension's namespace. It belongs to the server's command envelope, not to this extension, so it is honored whether or not the request activated this extension: it never affects idempotency or the payload digest, and an error produced after the request was parsed echoes it in `ErrorInfo.metadata.correlationId`.

### On a response

The server puts the object in the `metadata` of the `Task` or `Message` a command returns (and, on a streamed command, of the first `Task` event).

| Field | Type | Meaning |
| --- | --- | --- |
| `receipt.state` | string | The receipt state; see below. |
| `receipt.commandId` | string | The command's `messageId`. |
| `receipt.reason` | string | A short machine-readable reason for `rejected`, `failed`, `superseded`, and `expired`. Optional. |
| `revision` | string | The task's current revision. Opaque; a client sends it back as `expectedRevision`. Optional on a `Message` result. |

<!-- schema: response-metadata -->

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Command receipts response metadata namespace",
  "type": "object",
  "required": ["receipt"],
  "properties": {
    "receipt": {
      "type": "object",
      "required": ["state", "commandId"],
      "properties": {
        "state": {
          "enum": [
            "accepted",
            "rejected",
            "pending",
            "applied",
            "observed",
            "superseded",
            "failed",
            "expired"
          ]
        },
        "commandId": { "type": "string", "minLength": 1 },
        "reason": { "type": "string", "minLength": 1 }
      },
      "additionalProperties": false
    },
    "revision": { "type": "string", "minLength": 1 }
  },
  "additionalProperties": false
}
```

## Request identity

A command's identity is the pair of the published agent's name (the agent the interface URL addresses) and the message's `messageId`, under the authenticated caller and the A2A operation version (`A2A-Version` reduced to Major.Minor, so `1.0` and `1.0.1` share a binding). For a continuation the target task is part of the identity as well, because the server's mailbox binds identifiers per task. One `messageId` sent to two agents is two commands and creates two tasks. The same `messageId` sent as continuations to two different tasks is two commands.

The server also computes a payload digest of the command over the canonical message, the work-affecting part of `configuration` (`taskPushNotificationConfig` and `acceptedOutputModes`, with `acceptedOutputModes` sorted and de-duplicated and authentication scheme names lowercased), and the extensions the request activated. It excludes fields of extensions the request did not activate and the correlation identifier in `metadata`; the response controls `historyLength` and `returnImmediately` are not part of it. The digest is a server-side value and is never sent on the wire.

## Receipt states

A receipt reports how far a command has progressed in the server's durable stores. The states `SendMessage` and `SendStreamingMessage` can produce:

| State | Meaning | When it is produced |
| --- | --- | --- |
| `accepted` | Durably admitted; nothing applied yet. | The request ledger holds a pending entry, or the task's mailbox holds the command as `accepted` or `available`. |
| `rejected` | Refused at admission; nothing will be applied. | Validation, authorization, or a full mailbox backlog. On the A2A surface a refusal is a JSON-RPC error (see Errors) and carries no `Task`; the state exists so the vocabulary matches the management plane. |
| `pending` | Claimed and in progress. | The ledger entry is in flight, or the mailbox has claimed the command. |
| `applied` | The mutation took effect. | The ledger entry is complete, or the mailbox marked the command `applied`. |
| `observed` | Applied, and the effect is visible in durable history. | The durable history for the task has appended the event. |
| `superseded` | Replaced by a later command before it applied. | Continuations only. |
| `failed` | Accepted but could not apply. | Continuations only: the mailbox dead-lettered the command or recorded a failure reason. |
| `expired` | The deadline passed before the command applied. | See Deadlines. |

A message that creates a task can produce `accepted`, `rejected`, `pending`, `applied`, `observed`, and `expired`. A message that continues a task (it names an existing `taskId`) can additionally produce `superseded` and `failed`. A client never receives a state its operation cannot produce.

The states are monotonic along `accepted` to `pending` to `applied` to `observed`; the other states are terminal for the command. A response reports the state at the time it was produced; the client learns a later state by retrying the identical command (next section), which returns the then-current receipt.

The remaining receipt states (`cancel-requested`, `canceled`, and the cleanup states) belong to cancellation and cleanup and are specified in `cleanup-v1`.

## Retry, conflict, and ordering

- **Exact retry.** The same identity and payload digest returns the original receipt and task, with the receipt's current state. Exactly one run exists. A request delivered twice by a retrying proxy is an exact retry.
- **Conflicting reuse.** The same identity with a different payload digest is a conflict. A client that activated this extension receives the typed conflict below, carrying the original command's receipt. A client that did not activate it receives a plain JSON-RPC `-32602` stating that the `messageId` was reused with a different payload, without receipt metadata. Either way the original command is untouched.
- **Ordering.** Messages to one task are applied in admission order. Different tasks are independent.
- **Concurrency.** Two concurrent commands to one task produce one winner; the other observes the new revision.
- **Stale target.** A command whose `expectedRevision` no longer matches the task's revision changes nothing and returns the stale-revision error below.
- **Expiry of the binding.** The server holds a run-creation binding for as long as the task is non-terminal, and for a retention window (24 hours by default) after the task settles. After that a query for the old receipt finds nothing and the same `messageId` admits a new command. A client that retries later than the window mints a new identifier.
- **Disconnect.** Closing a stream or connection changes nothing about the command or the task.
- **No exactly-once side effects.** The server guarantees one model run per command identity. It does not guarantee that a tool's or webhook receiver's external side effect happened exactly once.

## Deadlines

`deadline` bounds how long the server will wait to apply a command.

- A message that creates a task and expires before applying projects the new task as `TASK_STATE_FAILED` with a deadline reason, and its receipt is `expired`.
- A continuation that expires before applying leaves the existing task in its current state, still interrupted if it was, and its receipt is `expired`.
- A request that cannot be answered by the deadline is a JSON-RPC `-32603` whose `ErrorInfo` reason is `TIMEOUT`.

## Idempotency of commands with no carrier

`CancelTask` and push-notification configuration `Delete` have fixed shapes and cannot carry a receipt. They are idempotent by their own specification:

- **`CancelTask`.** A cancel of a task that is `COMPLETED`, `FAILED`, or `REJECTED` is `TaskNotCancelableError` (`-32002`). A repeated cancel of a task already `CANCELED` has the same effect and the same error (A2A 1.0.1 section 3.1.5). Once the task is purged it is `TaskNotFoundError` (`-32001`). The cancel's cleanup progress is reported by the `cleanup-v1` extension on the task.
- **`DeleteTaskPushNotificationConfig`.** Deleting a configuration that is already deleted or never existed answers as a missing configuration does, and changes nothing.

### Idempotent push-notification configuration `Create`

A2A does not make `CreateTaskPushNotificationConfig` idempotent; a server implementing this extension does:

1. A `Create` that names an existing configuration `id` for the same task and caller, with the same webhook URL, `token`, and authentication, returns that configuration rather than registering a second one.
2. A `Create` that omits `id` but has the same task, caller, webhook URL, `token`, and authentication as an existing configuration returns that configuration.
3. A deleted configuration never matches either rule.
4. A `Create` that names the `id` of a deleted configuration is rejected with `-32602`.
5. A `Create` that names an existing `id` with any one of webhook URL, `token`, or authentication changed is rejected with `-32602`.

Authentication scheme names are case-insensitive and compare lowercased. A newly created configuration starts receiving updates after the cursor read when it was registered: every update after that cursor reaches it, and none before. The delivery projection keeps at most one unsettled delivery per configuration, so a webhook receives a configuration's updates in generation order.

## Errors

Every error is a JSON-RPC error envelope with HTTP 200, `error.data` an array of `google.rpc.ErrorInfo` entries (A2A 1.0.1 section 9.5), reason strings in UPPER_SNAKE_CASE. Authentication (401) and rate limiting (429) are rejected before the JSON-RPC handler and use HTTP statuses.

| Code | Reason | When |
| --- | --- | --- |
| `-32602` | `CONFLICT` | The `messageId` was reused with a different payload and the request activated this extension. `ErrorInfo.metadata` carries the original receipt. |
| `-32602` | `STALE_REVISION` | `expectedRevision` does not match the task's current revision. `ErrorInfo.metadata` carries both revisions. |
| `-32602` | (A2A invalid-params reason) | Reuse of a `messageId` without the extension active; a malformed `deadline` or `expectedRevision`; the push `Create` conflicts above; a `tenant` that differs from the mounted interface's. |
| `-32603` | `TIMEOUT` | The request could not be answered by its deadline. |
| `-32001` | (A2A reason) | The task does not exist or the caller may not see it. Denial is indistinguishable from absence. |
| `-32002` | (A2A reason) | `CancelTask` on a task that finished without being canceled, or already canceled. |

This specification fixes both reasons at `-32602`, the code of the plain-client form of the same refusal, so a client that does not recognize the reason still treats the error as a rejected request.

Every error produced after the request was parsed carries the command's `messageId` in `ErrorInfo.metadata.commandId` and, when the message carried one, its correlation identifier in `ErrorInfo.metadata.correlationId`.

<!-- schema: error-info -->

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Command receipts typed error ErrorInfo entry",
  "type": "object",
  "required": ["@type", "reason", "domain", "metadata"],
  "properties": {
    "@type": { "const": "type.googleapis.com/google.rpc.ErrorInfo" },
    "reason": { "enum": ["CONFLICT", "STALE_REVISION"] },
    "domain": { "const": "bureau" },
    "metadata": {
      "type": "object",
      "required": ["commandId"],
      "properties": {
        "commandId": { "type": "string" },
        "taskId": { "type": "string" },
        "receiptState": {
          "enum": [
            "accepted",
            "rejected",
            "pending",
            "applied",
            "observed",
            "superseded",
            "failed",
            "expired"
          ]
        },
        "expectedRevision": { "type": "string" },
        "currentRevision": { "type": "string" },
        "correlationId": { "type": "string" }
      },
      "additionalProperties": { "type": "string" }
    }
  },
  "additionalProperties": false
}
```

## Examples

### Request

A continuation fenced to a known revision, with a deadline:

<!-- example: request-metadata at /params/message/metadata/{uri} -->

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "method": "SendMessage",
  "params": {
    "tenant": "acme",
    "message": {
      "messageId": "msg-0001",
      "taskId": "task-7",
      "role": "ROLE_USER",
      "parts": [{ "text": "Also include the March figures." }],
      "metadata": {
        "correlationId": "corr-9",
        "https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/command-receipts-v1.md": {
          "expectedRevision": "rev_12",
          "deadline": "2026-10-22T18:30:00Z"
        }
      }
    }
  }
}
```

sent with the headers `A2A-Version: 1.0` and `A2A-Extensions: https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/command-receipts-v1.md`.

### Response

The server echoes `A2A-Extensions` with the same URI and returns the task with its receipt:

<!-- example: response-metadata at /result/task/metadata/{uri} -->

```json
{
  "jsonrpc": "2.0",
  "id": "req-1",
  "result": {
    "task": {
      "id": "task-7",
      "contextId": "ctx-3",
      "status": { "state": "TASK_STATE_WORKING" },
      "metadata": {
        "https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/command-receipts-v1.md": {
          "receipt": { "state": "applied", "commandId": "msg-0001" },
          "revision": "rev_13"
        }
      }
    }
  }
}
```

### Typed conflict

The same `messageId` resent with different text:

<!-- example: error-info at /error/data/0 -->

```json
{
  "jsonrpc": "2.0",
  "id": "req-2",
  "error": {
    "code": -32602,
    "message": "messageId msg-0001 was reused with a different payload",
    "data": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "CONFLICT",
        "domain": "bureau",
        "metadata": {
          "commandId": "msg-0001",
          "taskId": "task-7",
          "receiptState": "applied",
          "correlationId": "corr-9"
        }
      }
    ]
  }
}
```

### Stale revision

<!-- example: error-info at /error/data/0 -->

```json
{
  "jsonrpc": "2.0",
  "id": "req-3",
  "error": {
    "code": -32602,
    "message": "expectedRevision rev_12 is stale",
    "data": [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        "reason": "STALE_REVISION",
        "domain": "bureau",
        "metadata": {
          "commandId": "msg-0002",
          "taskId": "task-7",
          "expectedRevision": "rev_12",
          "currentRevision": "rev_14"
        }
      }
    ]
  }
}
```

### Idempotent push configuration `Create`

Sending this request twice returns the same configuration both times:

```json
{
  "jsonrpc": "2.0",
  "id": "push-1",
  "method": "CreateTaskPushNotificationConfig",
  "params": {
    "tenant": "acme",
    "taskId": "task-7",
    "id": "hook-1",
    "url": "https://hooks.example.com/tasks",
    "token": "opaque-token",
    "authentication": { "scheme": "Bearer", "credentials": "redacted" }
  }
}
```
