# Durable history, version 1

Extension URI: `https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/durable-history-v1.md`

This extension lets an A2A 1.0.1 client resume a `SubscribeToTask` stream after a disconnect and recover the task's current state without its state ever moving backwards: the stream resumes with the current `Task`, which supersedes every update the client missed, and then carries each later update once. It does not replay the intermediate updates; a client that needs every transition reads the server's full history (rule 3). It is specified for any server built on `@lostgradient/weft/a2a` that keeps a durable, ordered event history for its tasks; Bureau is the first such server. A client needs nothing but this document and [the A2A specification](https://a2a-protocol.org/v1.0.1/specification/) to use it.

The URI is a stable identifier that clients compare as an opaque string. A client never needs to fetch it.

## Conventions in this document

Key words (MUST, SHOULD, MAY) have their RFC 2119 meaning. Examples are JSON-RPC 2.0 over HTTP, with A2A's JSON field names.

The `json` fences below that follow an HTML comment marker are machine-checked by `scripts/check-a2a-extension-schemas.ts` (`bun run --filter=@lostgradient/weft lint`):

- `<!-- schema: <name> -->` makes the next `json` fence a JSON Schema (draft 2020-12) named `<name>`.
- `<!-- example: <name> at <pointer> -->` makes the next `json` fence an example document. The value at the RFC 6901 JSON Pointer `<pointer>` must validate against schema `<name>`. `{uri}` in a pointer stands for this extension's URI, escaped as one pointer segment; an empty pointer is the whole document.

## Declaration

A server that composes a durable event history advertises the extension in its Agent Card under `capabilities.extensions`. It omits the entry when it has no durable history, and then makes no guarantee in this document.

<!-- example: params at /params -->

```json
{
  "uri": "https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/durable-history-v1.md",
  "description": "Resume SubscribeToTask with Last-Event-ID; each durable event carries an opaque cursor as its SSE id.",
  "required": false,
  "params": {}
}
```

`required` is always `false`: a client that does not know the extension gets plain A2A behavior.

### `AgentExtension.params`

Version 1 defines no parameters. A server sends `params` as an empty object or omits it. A client ignores keys it does not recognize, so a later minor addition cannot break it. (A breaking change would instead publish a new URI; see Versioning.)

<!-- schema: params -->

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Durable history AgentExtension.params",
  "type": "object"
}
```

## Activation

A client activates the extension per request by listing its URI in the `A2A-Extensions` request header (a comma-separated list of URIs). The server applies the extension only to a request that activates it, and echoes the extensions it applied in the `A2A-Extensions` response header. For a streamed response the header is written with the response head, so a server that decides to apply the extension must know it before the first event.

A request that does not activate the extension is plain A2A: the stream begins with the current `Task`, which carries none of this extension's metadata, and `Last-Event-ID` is ignored. A server MAY still send SSE `id`s on that stream, and a plain client ignores them. The unactivated stream is otherwise unspecified by this extension.

## Versioning

The major version is part of the URI. A breaking change publishes a new URI (`durable-history-v2.md`) and the server never falls back to an older version on its own: a request that activates only `-v1` is answered under `-v1` or not at all. A server MAY advertise several majors at once.

## Metadata namespace

Extension data lives in the `metadata` map of the `Task`, under the key that is this extension's URI. The extension never repurposes a core A2A field. Only the first event of a stream, the `Task`, carries this namespace.

| Field | Type | Meaning |
| --- | --- | --- |
| `cursor` | string | The cursor C of the durable history at the instant this `Task` was read. Required. |
| `requestedCursor` | string | The cursor the client sent in `Last-Event-ID`. Present only when the request carried one. |
| `gap` | object | Present only when `requestedCursor` is below the server's retention floor. Holds `requestedCursor` (the same value) and `firstRetainedCursor`, the oldest cursor the server still holds. |

<!-- schema: metadata -->

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "Durable history Task metadata namespace",
  "type": "object",
  "required": ["cursor"],
  "properties": {
    "cursor": { "type": "string", "minLength": 1 },
    "requestedCursor": { "type": "string", "minLength": 1 },
    "gap": {
      "type": "object",
      "required": ["requestedCursor", "firstRetainedCursor"],
      "properties": {
        "requestedCursor": { "type": "string", "minLength": 1 },
        "firstRetainedCursor": { "type": "string", "minLength": 1 }
      },
      "additionalProperties": false
    }
  },
  "dependentRequired": { "gap": ["requestedCursor"] },
  "additionalProperties": false
}
```

## Cursors

A cursor is an opaque string. A client MUST NOT parse it, order it, or do arithmetic on it; it compares cursors for equality only. A server MAY change the encoding at any time. A cursor contains no carriage return, line feed, or NUL, because it travels as an SSE `id`.

## `SubscribeToTask` with resumption

The request is the standard A2A `SubscribeToTask` request, which carries only `tenant` and `id`. The resume point travels in the standard SSE `Last-Event-ID` request header, set to the `id` of the last event the client received.

The server answers with a Server-Sent Events stream. Each event's `data` is one JSON-RPC response whose `result` is one A2A `StreamResponse`. The stream obeys these rules.

1. **The first event is always the current `Task`.** Whether the subscription is fresh or resumed, the first `data` is a `result.task`. Its `metadata` carries this extension's namespace: `cursor` is C, `requestedCursor` echoes `Last-Event-ID` when one was sent, and `gap` is present when the requested cursor is below the retention floor. The `Task` already contains every status and artifact the client missed, so a client replaces its state with it.
2. **Then only durable events after C.** After the `Task`, the stream carries `statusUpdate` and `artifactUpdate` events whose cursor is later than C, in cursor order, each with its cursor as the SSE `id`. The client's state never moves backwards.
3. **The server never replays events older than the `Task` it just sent.** A resumed client does not receive the events between its `Last-Event-ID` and C; the `Task` supersedes them. A client that needs every intermediate event reads the full history from the management plane (for Bureau, the `bureau.tasks.events` operation), which is outside A2A.
4. **An event without a durable cursor carries no `id`.** The server holds the live copy of a status or artifact change until its durable append commits and then sends it with its cursor. Only when that append fails does it send the live copy without an SSE `id`, and it then closes the stream (see below). Step, delta, and tool frames never reach an A2A stream at all. A client MUST NOT treat the absence of an `id` as an error and MUST NOT resume from it; it keeps the last `id` it saw.
5. **The `Task` event carries C as its SSE `id`.** Like every durable-history event, the snapshot carries its cursor as the SSE `id`, and the same value is its metadata `cursor`. A client that disconnects before receiving any later event resumes from it.
6. **A gap is not an error.** When `gap` is present the stream continues normally from C. The client learns that events were lost to retention, and that the `Task` is its recovery, from `gap`.
7. **Repairs are ordinary events.** When the server repairs a missed update (a `task.resynced` durable event), it projects the repair as one `statusUpdate` carrying the task's current status followed by one `artifactUpdate` per artifact, each a normal event with a cursor. Nothing marks them as repairs; a client applies them like any update.

A server that closes a stream for any of the reasons below does so cleanly, and the task is unaffected. A disconnect never cancels the task.

- **Slow consumer.** A subscriber that falls behind its buffer is closed instead of being sent a thinned stream, because every active stream for a task must carry the same events in the same order (A2A 1.0.1 section 3.5.2).
- **Retention overtaking the tail (`fleet:gap`).** When the subscription's next cursor has fallen below the retention floor while it was open, the stream is closed instead of skipping events silently.
- **A live copy whose durable append failed.** The server sends the live event without an `id` and then closes the stream.
- **A terminal task.** After the final event of a task that reaches a terminal state, the stream ends, as A2A requires.

In every case except the last, the client reconnects with `Last-Event-ID` set to the last `id` it received and starts again at rule 1. If the task reached a terminal state while the client was away, the reconnect is answered with `UnsupportedOperationError` (see Errors), and the client reads the final state with `GetTask`.

### Request example

```http
POST /agents/support HTTP/1.1
Content-Type: application/json
Accept: text/event-stream
A2A-Version: 1.0
A2A-Extensions: https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/durable-history-v1.md
Last-Event-ID: cur_0041
```

```json
{
  "jsonrpc": "2.0",
  "id": "sub-1",
  "method": "SubscribeToTask",
  "params": { "tenant": "acme", "id": "task-7" }
}
```

### Response example

The response header echoes the applied extension:

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
A2A-Extensions: https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/durable-history-v1.md
```

The stream, for a client whose `cur_0041` is older than the retention floor:

```text
id: cur_0090
data: {"jsonrpc":"2.0","id":"sub-1","result":{"task":{"id":"task-7","contextId":"ctx-3","status":{"state":"TASK_STATE_WORKING"},"metadata":{"https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/durable-history-v1.md":{"cursor":"cur_0090","requestedCursor":"cur_0041","gap":{"requestedCursor":"cur_0041","firstRetainedCursor":"cur_0060"}}}}}}

id: cur_0091
data: {"jsonrpc":"2.0","id":"sub-1","result":{"statusUpdate":{"taskId":"task-7","contextId":"ctx-3","status":{"state":"TASK_STATE_COMPLETED"}}}}

```

The first event, as a document the schema checks:

<!-- example: metadata at /result/task/metadata/{uri} -->

```json
{
  "jsonrpc": "2.0",
  "id": "sub-1",
  "result": {
    "task": {
      "id": "task-7",
      "contextId": "ctx-3",
      "status": { "state": "TASK_STATE_WORKING" },
      "metadata": {
        "https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/durable-history-v1.md": {
          "cursor": "cur_0090",
          "requestedCursor": "cur_0041",
          "gap": { "requestedCursor": "cur_0041", "firstRetainedCursor": "cur_0060" }
        }
      }
    }
  }
}
```

A fresh subscription, with no `Last-Event-ID`, carries only the cursor:

<!-- example: metadata at /result/task/metadata/{uri} -->

```json
{
  "jsonrpc": "2.0",
  "id": "sub-2",
  "result": {
    "task": {
      "id": "task-7",
      "contextId": "ctx-3",
      "status": { "state": "TASK_STATE_WORKING" },
      "metadata": {
        "https://github.com/stevekinney/weft/blob/main/packages/weft/documentation/a2a/extensions/durable-history-v1.md": {
          "cursor": "cur_0090"
        }
      }
    }
  }
}
```

## Errors

The extension adds no error codes. It produces these standard ones, each a JSON-RPC error envelope with HTTP 200, with `error.data` an array of `google.rpc.ErrorInfo` entries as A2A 1.0.1 section 9.5 requires:

| Code | When |
| --- | --- |
| `-32602` (invalid params) | `Last-Event-ID` is not well formed as a cursor of this server (any cursor the server issued is accepted, whatever it names: a client compares cursors for equality only and cannot tell which event a cursor belongs to), or `tenant` differs from the mounted interface's tenant. ErrorInfo reason: the A2A standardized reason for invalid params. The server never guesses a resume point from a malformed cursor. |
| `-32001` (`TaskNotFoundError`) | The task does not exist, or the caller may not see it. Denial is indistinguishable from absence. |
| `-32004` (`UnsupportedOperationError`) | The task is already in a terminal state and cannot be subscribed to (A2A 1.0.1 section 3.1.6). The client reads its final state with `GetTask`. |

A cursor that is valid but below the retention floor is not an error; see rule 6. Authentication (401) and rate limiting (429) are rejected before the JSON-RPC handler and use HTTP statuses.
