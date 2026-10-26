import type { TokenUsage } from 'conversationalist';

/**
 * The model's answer did not satisfy the request, even after one retry with
 * the validation error appended. `usage` is summed across both attempts.
 */
export class DecisionSchemaError extends Error {
  /** How many times the model was asked (always 2 for the language-model fallback). */
  readonly attempts: number;
  /** Tokens spent across every attempt, when the provider reported any. */
  readonly usage: TokenUsage | undefined;
  /** The validation failure of the last attempt, as text. */
  readonly validation: string;

  constructor(
    options: {
      readonly attempts: number;
      readonly usage: TokenUsage | undefined;
      readonly validation: string;
    },
    errorOptions?: { cause?: unknown },
  ) {
    super(
      `The model's answer did not satisfy the request after ${options.attempts} attempts: ${options.validation}`,
      errorOptions,
    );
    this.name = 'DecisionSchemaError';
    this.attempts = options.attempts;
    this.usage = options.usage;
    this.validation = options.validation;
  }
}

/**
 * A decision provider cannot be used because something it needs is missing,
 * such as an optional peer dependency that is not installed.
 */
export class DecisionProviderUnavailableError extends Error {
  /** The provider that cannot be used, such as `typesafe`. */
  readonly provider: string;

  constructor(provider: string, message: string, errorOptions?: { cause?: unknown }) {
    super(message, errorOptions);
    this.name = 'DecisionProviderUnavailableError';
    this.provider = provider;
  }
}
