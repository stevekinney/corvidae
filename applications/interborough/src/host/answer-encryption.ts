/**
 * The key a secret answer is sealed with (COR-1920). A question field marked `writeOnly` and
 * `x-secret` is encrypted before Bureau keeps it, under the installation's answer key.
 *
 * Locally the key is created on the host's first start and kept in Bungalow's `secrets/` as
 * `answer-encryption-key`, as the approval secret is. Remotely it is the variable Bungalow names
 * (`INTERBOROUGH_SECRET_ANSWER_ENCRYPTION_KEY`), the same on every host, and a host without it does
 * not start: an answer one host sealed under a key it made up could not be read on another.
 *
 * Rotating the key keeps earlier answers readable. Move the current value to
 * `answer-encryption-key-<keyId>` (the key's 24-character id, which every sealed answer names),
 * then put the new key in `answer-encryption-key`. A retired key is read by its id when an answer
 * sealed under it is resolved; once it is deleted, those answers are `secret-unavailable`.
 *
 * @module answer-encryption
 */

import type { Bungalow } from '@lostgradient/bungalow';
import type { AnswerEncryptionKeys } from '@lostgradient/bureau';
import {
  exportEncryptionKey,
  generateEncryptionKey,
  importEncryptionKey,
} from '@lostgradient/cryptography';

/** The Bungalow secret that holds the current answer key, as base64url of its 32 bytes. */
export const ANSWER_ENCRYPTION_KEY = 'answer-encryption-key';

/** A key id: 24 lowercase hexadecimal characters (`@lostgradient/cryptography`). */
const KEY_ID_PATTERN = /^[0-9a-f]{24}$/;

/** The Bungalow secret a key retired by a rotation is kept under: `answer-encryption-key-<keyId>`. */
export function retiredAnswerEncryptionKey(keyId: string): string {
  return `${ANSWER_ENCRYPTION_KEY}-${keyId}`;
}

/**
 * The installation's answer keys: the current one, created on first use locally and read from the
 * deployment remotely, and each retired one read by its id when an answer names it. Throws before
 * anything is written when a remote host has no key.
 */
export async function answerEncryptionKeys(bungalow: Bungalow): Promise<AnswerEncryptionKeys> {
  let encoded = bungalow.readSecret(ANSWER_ENCRYPTION_KEY);
  if (encoded === undefined) {
    if (bungalow.mode === 'remote') {
      throw new Error(
        `${bungalow.secretLocation(ANSWER_ENCRYPTION_KEY)} is not set. Remote mode needs it: it seals the secret answers every host reads.`,
      );
    }
    encoded = await exportEncryptionKey(await generateEncryptionKey());
    bungalow.writeSecret(ANSWER_ENCRYPTION_KEY, encoded);
  }
  const current = await importEncryptionKey(encoded);
  return {
    current,
    retired: async (keyId) => {
      if (!KEY_ID_PATTERN.test(keyId)) return undefined;
      const stored = bungalow.readSecret(retiredAnswerEncryptionKey(keyId));
      if (stored === undefined) return undefined;
      const key = await importEncryptionKey(stored).catch(() => undefined);
      // A file under the id holds the key with that id, or none at all.
      return key?.keyId === keyId ? key : undefined;
    },
  };
}
