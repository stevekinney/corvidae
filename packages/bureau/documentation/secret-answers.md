# Secret Answers

A question an agent asks with `requestHumanInput` can mark a field as a secret: `{ "type": "string", "writeOnly": true, "x-secret": true }`, on the answer itself or on a field reached through `properties` (Operative refuses one anywhere else). Bureau encrypts that field before anything holds it, hands the model a reference instead, and gives the plaintext back only to a tool of the run that asked, and only one that declares `acceptsSecrets` (Armorer's [secrets](../../armorer/documentation/secrets.md)).

## Configuring it

A Bureau needs `storage`, where the ciphertext is kept, and `answerEncryption`, the keys it is sealed with:

```typescript
import { createBureau } from '@lostgradient/bureau';
import { generateEncryptionKey } from '@lostgradient/cryptography';
import { MemoryStorage } from '@lostgradient/storage';

const bureau = await createBureau({
  storage: new MemoryStorage(),
  durable: true,
  answerEncryption: { current: await generateEncryptionKey() },
});
await bureau.dispose();
```

`answerEncryption.current` seals every new answer. A key retired by a rotation stays readable through `retired(keyId)`, which returns that key or `undefined`; every sealed answer names the id of its key, so the host looks a retired key up by that id instead of loading them all. A Bureau without `answerEncryption` or without `storage` refuses an answer to a question that asks for a secret with `BureauError` (`NOT_CONFIGURED`, subject `encryption`), and nothing is delivered.

## The reference

Once an answer is checked, each secret field is replaced by `{ "secretRef": "<reviewId><field>" }`, where `<field>` is the field's JSON Pointer within the answer: `human-wait:<runId>:login:0/password` for a `password` field, the bare review id when the answer itself is the secret. Any `~` or `/` in the review id (a signal name may hold one) is escaped as `~0` or `~1`, so the first `/` of a reference always starts the field and two questions never share a reference. The reference is not secret.

The signal that releases the run carries the reference, so the model reads `[signal:login] {"password":{"secretRef":"…/password"},"user":"ada"}`, and the conversation, the checkpoint, the transcript, the replay and the run's events hold the same. The model passes the reference to a tool as it would any value.

## Where the plaintext goes

- **Checked, then sealed.** The plaintext is checked against the question's schema (`minLength` and the rest apply), then encrypted with AES-256-GCM (`@lostgradient/cryptography`) as `{ "secretRef", "value" }`, so a ciphertext copied under another reference does not open.
- **Kept once, whole.** The ciphertext is stored under `bureau-secret-answer:v1:<sha256 of the reference>` as `{ version: 1, secretRef, reviewId, runId, owner, encrypted, recordedAt }`, where `encrypted` is `{ version, ciphertext, iv, keyId }` and `owner` is the run's owner. An answer's records are written together, in one compare-and-swap, after the review's decision is claimed and before the signal is sent: every same-decision re-drive signals the references to the secrets the first claimant stored, and an answer is never kept as a mix of two submissions' fields.
- **Read for the asking run.** `createSecretAnswerResolver({ storage, keys })` is an Armorer `secretResolver`. It reads the record and decrypts it only when the tool call's `executionContext.parentRunId`, which Operative sets to the calling run's id over anything a caller passed, is the run that asked. Another run's call, a reference with no record, and a key that is no longer held are refused, which Armorer reports as `secret-unavailable`.

The toolbox Bureau builds itself (when `options.toolbox` is omitted) carries this resolver. A toolbox an agent's author builds keeps its own options, so pass the resolver to it, made over the same storage and keys:

```typescript
import { createSecretAnswerResolver, type AnswerEncryptionKeys } from '@lostgradient/bureau';
import type { Storage } from '@lostgradient/storage';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

declare const storage: Storage;
declare const keys: AnswerEncryptionKeys;

const signIn = createTool({
  name: 'sign-in',
  description: 'Signs in with the password the person gave.',
  input: z.object({ password: z.string() }),
  metadata: { acceptsSecrets: true },
  async execute({ password }) {
    return { signedIn: password.length > 0 };
  },
});

export const toolbox = createToolbox([signIn], {
  secretResolver: createSecretAnswerResolver({ storage, keys }),
});
```

## Every ingress

`bureau.reviews.resolve`, `bureau.tasks.respond` and an AG-UI resume all reach one check (`validateReviewAnswer`), and the secret is sealed there. Before any of them, or A2A, writes anything that covers an answer (a command-ledger claim, a decision digest, a task's history), it passes one gate, `gateSecretAnswer`: it reads every open human wait the answer could reach (the one it names, else all of them) and refuses when any asks for a secret, or cannot be read, unless the path seals and the answer reaches exactly one wait. A read error is the command's, never a reason to digest. A decision whose payload still holds a secret field unsealed is refused before its decision record is claimed. Each ingress keeps nothing of the plaintext:

- **`bureau.tasks.respond`** seals the answer before its command ledger claims it, so the claim a retry completes from holds the sealed form, which the check accepts back after it decrypts under its own reference.
- **Digests.** The `tasks.respond` and AG-UI ledgers and the `review-decision:v1` record digest an answer with each secret replaced by its `{ secretRef }`. Sealing draws a fresh IV, so a digest of the ciphertext would make a same-decision retry a conflict, and a digest of the plaintext would keep something a guess could be checked against. A review that has closed is read back from the audit trail, which keeps the fields its schema marked secret (`review.secretFields`), so a retry after the review closed digests alike.
- **AG-UI frames** show the answer row the run appended, with the reference.
- **Audit.** The decision's entry names each secret by its field and the SHA-256 of its ciphertext (`detail.secretAnswers: [{ field, ciphertextDigest }]`), never by its value.
- **A2A and A2UI.** A2A records the message that carries an answer, so a question that asks for a secret is answered in the chat alone: its task offers no A2UI form, and while it is open every message to the task is judged as A2A keeps it, raw, before a surface admits an action, the send ledger digests the message, or the task's history records it. Only a bare decision passes: one data part holding `decision` and an optional `reason`, no text, no file, no part metadata, and message metadata that names at most `signalName` or `callId`. Anything else is refused (`RequestMalformedError`).
- **Strict shapes.** Every answer ingress refuses a field it does not define instead of dropping it: `bureau.tasks.respond` and the `bureau.reviews.resolve` operation reject unknown keys, and an AG-UI resume payload holds only `decision`, `reason`, and the field its interrupt's kind takes (`answer` for a question, `arguments` for an approval), as its advertised `responseSchema` says. What is digested or kept is what was judged. A free-text `reason` is kept as written.

## Rotating the key

Retire the current key under its id and put a new one in its place. Answers sealed under the old key stay readable as long as `retired(keyId)` returns it; once it does not, they are `secret-unavailable`. Interborough keeps the current key as the Bungalow secret `answer-encryption-key` and each retired one as `answer-encryption-key-<keyId>` (its [README](../../../applications/interborough/README.md) has the steps).

## Not covered

- A signal sent with `bureau.contexts.signal` is not an answer to a review, and its payload is delivered as given.
- An agent's own toolbox resolves secrets only when its author passes `createSecretAnswerResolver`; without it, every reference is `secret-unavailable` to that toolbox's tools.
- A tool that declares `acceptsSecrets` owns what it does with the plaintext: if it returns it, the model reads it.
