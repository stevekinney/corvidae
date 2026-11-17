# @lostgradient/plugin-github

An Interborough plugin that contributes one receive trigger, `github:webhook`, which starts a workflow run for each signed GitHub `push` or `pull_request` webhook delivery. It uses no GitHub SDK: the trigger reads the request GitHub sends and nothing else. The plugin is off until the owner enables it, and it declares the Bungalow secret `github-webhook-secret`. Until the secret is saved the plugin is `needs-setup` and the trigger refuses every delivery.

| Setting | Default | What it is |
| --- | --- | --- |
| `events` | `push` and `pull_request` | The events that start a run: any of `push` and `pull_request`. |

With no `events` selected, in a workflow file that omits the setting or lists none, the trigger starts a run for `push` and `pull_request` deliveries. A delivery of any other event, GitHub's `ping` among them, is acknowledged and starts nothing.

## Setting it up

Add a webhook to the repository: the payload URL is `POST <your host>/triggers/<workflow id>`, the content type is `application/json`, the secret is the value you save as `github-webhook-secret` in Settings › Plugins, and the events are the pushes and pull requests you select.

## What a delivery does

The trigger checks `X-Hub-Signature-256` against the raw body before it reads anything else, and answers with a status only, never text:

| Answer | When |
| --- | --- |
| `202` | A run started; a redelivery of a body that already started one; an event the file did not select; a body that is not a JSON object; a paused workflow. |
| `401` | The signature is missing, malformed, or not the HMAC-SHA-256 of the body under the secret. Nothing starts. |
| `503` | The host stopped the trigger or is closing. Nothing started, so GitHub redelivers. |

A run's `trigger.payload` is `{ event, delivery, payload }`: the `X-GitHub-Event` value, GitHub's `X-GitHub-Delivery` id when it is a UUID (for display and logs, otherwise `null`), and the body GitHub signed, parsed.

`trigger.idempotencyKey` is the lowercase hex SHA-256 of the raw signed body, computed after the signature verifies. It is never the `X-GitHub-Delivery` header, which the signature does not cover: a captured delivery replayed under another delivery id, or none, is the same run, and GitHub's own redelivery, which sends the same bytes, starts no second one. The signature has no timestamp window, so this key is the only replay protection.

`src/plugin.test.ts` runs the plugin conformance suite and drives the trigger with signed deliveries built from the bodies in `src/fixtures/`, which carry the fields GitHub documents for each event with made-up identifiers (they are not recordings, and hold no secret). Refresh the committed identities after a schema change with `bun scripts/check-plugin-identities.ts --write plugins/github`.
