/**
 * Draft state for the page that creates a goal (`bureau.goals.create`): an agent, a prompt, an
 * identity (a name and a version), a validator named by free text (a name and a version), and the
 * most attempts the goal may make. A plain rune-backed class, so validation and the payload are
 * testable without a DOM.
 *
 * The validator is free text because it names one this Bureau was configured with, which a browser
 * cannot list: one the Bureau lacks is refused as `Unprocessable`, and the page says so.
 */
import type { GoalInput } from '../../lib/bureau-goals.ts';

/** Whole numbers of one or more, as the text of a field. */
const POSITIVE_INTEGER = /^[1-9]\d*$/;

/** Attempts a goal makes unless the person says otherwise. */
export const DEFAULT_MAXIMUM_ATTEMPTS = '3';

/** Steps, across all its attempts, a goal takes unless the person says otherwise. */
export const DEFAULT_MAXIMUM_TOTAL_STEPS = '50';

export class GoalFormState {
  agentName = $state('');
  prompt = $state('');
  identityName = $state('');
  identityVersion = $state('');
  validatorName = $state('');
  validatorVersion = $state('');
  maximumAttempts = $state(DEFAULT_MAXIMUM_ATTEMPTS);
  maximumTotalSteps = $state(DEFAULT_MAXIMUM_TOTAL_STEPS);

  /** Whether the text of the attempts field is a whole number of one or more. */
  get attemptsValid(): boolean {
    return POSITIVE_INTEGER.test(this.maximumAttempts.trim());
  }

  /** Whether the text of the steps field is a whole number of one or more. */
  get stepsValid(): boolean {
    return POSITIVE_INTEGER.test(this.maximumTotalSteps.trim());
  }

  get isValid(): boolean {
    return (
      this.agentName.trim().length > 0 &&
      this.prompt.trim().length > 0 &&
      this.identityName.trim().length > 0 &&
      this.identityVersion.trim().length > 0 &&
      this.validatorName.trim().length > 0 &&
      this.validatorVersion.trim().length > 0 &&
      this.attemptsValid &&
      this.stepsValid
    );
  }

  /** What the last request was, and the key it was sent under. Plain bookkeeping, not state. */
  #lastRequest = '';
  #lastKey = '';

  /**
   * The key for what the form holds now. It is the same for as long as the request is the same, so
   * sending one submission again after a lost answer is the same goal, and it is a new one as soon
   * as anything is changed, because the Bureau refuses a different request under a key it has seen.
   */
  #keyFor(request: Omit<GoalInput, 'idempotencyKey'>): string {
    const signature = JSON.stringify(request);
    if (signature !== this.#lastRequest) {
      this.#lastRequest = signature;
      this.#lastKey = crypto.randomUUID();
    }
    return this.#lastKey;
  }

  /** What `bureau.goals.create` is sent. Only valid when `isValid` is. */
  toInput(): GoalInput {
    const request = this.#request();
    return { ...request, idempotencyKey: this.#keyFor(request) };
  }

  #request(): Omit<GoalInput, 'idempotencyKey'> {
    return {
      agentName: this.agentName.trim(),
      prompt: this.prompt,
      identity: { name: this.identityName.trim(), version: this.identityVersion.trim() },
      validator: { name: this.validatorName.trim(), version: this.validatorVersion.trim() },
      maximumAttempts: Number(this.maximumAttempts.trim()),
      maximumTotalSteps: Number(this.maximumTotalSteps.trim()),
    };
  }
}
