import { CryptographyError, generateEncryptionKey } from '@lostgradient/cryptography';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { describe, expect, it } from 'bun:test';

import { createReviewDecisionRecords, digestReviewDelivery } from './review-decision-record.ts';
import {
  createSecretAnswerStore,
  isSealedSecretAnswer,
  openSealedAnswer,
  sealSecretAnswer,
  secretReferenceForm,
  secretReferenceFormOfInput,
  withoutCiphertext,
} from './secret-answers.ts';

const REVIEW = 'human-wait:run-1:login:0';

async function keys() {
  return { current: await generateEncryptionKey() };
}

describe('secretReferenceForm', () => {
  it('replaces each present secret field with its reference and keeps the rest', () => {
    expect(
      secretReferenceForm({ user: 'ada', password: 'x' }, ['/password', '/missing'], REVIEW),
    ).toEqual({ user: 'ada', password: { secretRef: `${REVIEW}/password` } });
    expect(secretReferenceForm('x', [''], REVIEW)).toEqual({ secretRef: REVIEW });
  });
});

describe('secretReferenceFormOfInput', () => {
  it('reads text and an A2UI { response } as JSON before replacing', () => {
    const expected = { user: 'ada', password: { secretRef: `${REVIEW}/password` } };
    expect(
      secretReferenceFormOfInput('{"user":"ada","password":"x"}', ['/password'], REVIEW),
    ).toEqual(expected);
    expect(
      secretReferenceFormOfInput(
        { response: '{"user":"ada","password":"x"}' },
        ['/password'],
        REVIEW,
      ),
    ).toEqual(expected);
  });

  it('stands for one fixed value when the input cannot hold the fields, so no secret is digested', () => {
    const unreadable = secretReferenceFormOfInput('hunter2 not json', ['/password'], REVIEW);
    expect(JSON.stringify(unreadable)).not.toContain('hunter2');
    expect(secretReferenceFormOfInput([1], ['/password'], REVIEW)).toEqual(unreadable);
  });

  it('takes { response } as a field when the answer has one', () => {
    expect(secretReferenceFormOfInput({ response: 'x' }, ['/response'], REVIEW)).toEqual({
      response: { secretRef: `${REVIEW}/response` },
    });
  });
});

describe('sealSecretAnswer', () => {
  it('seals text, keeps the plaintext for the schema check, and opens only under its reference', async () => {
    const answerKeys = await keys();
    const outcome = await sealSecretAnswer({
      reviewId: REVIEW,
      fields: ['/password'],
      answer: { user: 'ada', password: 'hunter2' },
      keys: answerKeys,
    });
    if (!outcome.ok) throw new Error('expected a sealed answer');
    expect(outcome.plaintext).toEqual({ user: 'ada', password: 'hunter2' });
    const sealed = (outcome.sealed as { password: unknown }).password;
    expect(isSealedSecretAnswer(sealed)).toBe(true);
    expect(JSON.stringify(outcome.sealed)).not.toContain('hunter2');
    if (!isSealedSecretAnswer(sealed)) throw new Error('unreachable');
    expect(await openSealedAnswer(sealed.secretRef, sealed.encrypted, answerKeys)).toBe('hunter2');
    expect(
      await rejectionOf(openSealedAnswer(`${REVIEW}/other`, sealed.encrypted, answerKeys)),
    ).toBeInstanceOf(CryptographyError);
    expect(withoutCiphertext(outcome.sealed)).toEqual({
      user: 'ada',
      password: { secretRef: `${REVIEW}/password` },
    });

    // The sealed form is accepted back, opened for the check, and kept as it is.
    const again = await sealSecretAnswer({
      reviewId: REVIEW,
      fields: ['/password'],
      answer: outcome.sealed,
      keys: answerKeys,
    });
    expect(again).toEqual({ ok: true, plaintext: outcome.plaintext, sealed: outcome.sealed });
  });

  it('refuses a sealed answer outside a secret field, and one sealed for another question', async () => {
    const answerKeys = await keys();
    const sealed = await sealSecretAnswer({
      reviewId: 'human-wait:run-2:login:0',
      fields: ['/password'],
      answer: { password: 'hunter2' },
      keys: answerKeys,
    });
    if (!sealed.ok) throw new Error('expected a sealed answer');
    const foreign = (sealed.sealed as { password: unknown }).password;

    const outside = await sealSecretAnswer({
      reviewId: REVIEW,
      fields: ['/password'],
      answer: { password: 'x', note: foreign },
      keys: answerKeys,
    });
    expect(outside.ok).toBe(false);

    const copied = await sealSecretAnswer({
      reviewId: REVIEW,
      fields: ['/password'],
      answer: { password: foreign },
      keys: answerKeys,
    });
    expect(copied).toEqual({
      ok: false,
      issues: [expect.objectContaining({ path: ['password'], code: 'secret' })],
    });
  });
});

describe('createSecretAnswerStore', () => {
  it('keeps the first record, refuses another run, and needs the key that sealed it', async () => {
    const kv = textValueStore(new MemoryStorage());
    const first = await keys();
    const store = createSecretAnswerStore({ kv, keys: first, now: () => 1 });
    const review = { id: REVIEW, runId: 'run-1' };
    const seal = async (value: string) => {
      const outcome = await store.seal({ reviewId: REVIEW, fields: [''], answer: value });
      if (!outcome.ok) throw new Error('expected a sealed answer');
      return outcome.sealed;
    };

    const stored = await store.store(review, await seal('first'), 'owner-1');
    expect(stored.payload).toEqual({ secretRef: REVIEW });
    expect(stored.audit).toEqual([
      { field: '', ciphertextDigest: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    // A later store under the same reference keeps the first answer.
    await store.store(review, await seal('second'), 'owner-1');
    expect(await store.resolve(REVIEW, 'run-1')).toBe('first');
    expect(String(await rejectionOf(store.resolve(REVIEW, 'run-2')))).toContain('not available');
    const foreign = await seal('x');
    expect(
      String(
        await rejectionOf(
          store.store({ id: 'human-wait:run-1:other:0', runId: 'run-1' }, foreign, 'o'),
        ),
      ),
    ).toContain('not available');

    const rotated = createSecretAnswerStore({
      kv,
      keys: { current: await generateEncryptionKey(), retired: () => first.current },
      now: () => 2,
    });
    expect(await rotated.resolve(REVIEW, 'run-1')).toBe('first');
    const lost = createSecretAnswerStore({ kv, keys: await keys(), now: () => 3 });
    const failure = await lost.resolve(REVIEW, 'run-1').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CryptographyError);
    expect((failure as CryptographyError).code).toBe('secret-unavailable');
  });
});

describe('the decision record of a sealed answer', () => {
  it('digests two sealings of one answer alike, so a same-decision retry joins the claim', async () => {
    const answerKeys = await keys();
    const sealings = await Promise.all(
      [1, 2].map(() =>
        sealSecretAnswer({
          reviewId: REVIEW,
          fields: ['/password'],
          answer: { user: 'ada', password: 'hunter2' },
          keys: answerKeys,
        }),
      ),
    );
    const [first, second] = sealings.map((outcome) => {
      if (!outcome.ok) throw new Error('expected a sealed answer');
      return outcome.sealed;
    });
    expect(first).not.toEqual(second);
    const digest = digestReviewDelivery(first);
    expect(digestReviewDelivery(second)).toBe(digest);
    expect(digestReviewDelivery(withoutCiphertext(first))).toBe(digest);

    const records = createReviewDecisionRecords(textValueStore(new MemoryStorage()));
    const request = (sealed: unknown) => ({
      reviewId: REVIEW,
      round: 0,
      decision: 'approve' as const,
      principal: 'owner-1',
      digest: digestReviewDelivery(sealed),
    });
    const claimed = await records.claim(request(first));
    const joined = await records.claim(request(second));
    expect(claimed.outcome).toBe('claimed');
    expect(joined.outcome).toBe('same');
  });
});
