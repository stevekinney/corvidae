/**
 * What a sign-in has to say, for Connect tools to draw under its Sign in choice (rows 34k, 34l,
 * 34y): the waiting line as a description, a cancel, a declined sign-in or a blocked window as a
 * note, and a refusal as an error, which the page gives its Try again.
 */
export type SignInNotice = {
  readonly description?: string;
  readonly note?: string;
  readonly error?: string;
};
