/**
 * Testing a key and then saving it, for the dialogs that take one (Connect and Replace key; board
 * SettingsShell, "Connect" and "Replace key, in progress"). The key is tested first, with one
 * request of one token that stores nothing (`POST /host/providers/<name>/test`), and saved
 * (`PUT /host/providers/<name>`) only once the provider has accepted it, so a key that fails is
 * never in use and the key already saved keeps working until the new one passes. A dialog that
 * edits the provider's configuration stores it before the test (`beforeTest`), because the host
 * probes with the configuration it holds: a refused key leaves that configuration stored.
 *
 * The key is held in `key` for as long as the person is working on it, which is also how the field
 * keeps showing what they pasted after a refusal. It is cleared when the host has saved it and when
 * the dialog is dismissed, and it is never put in a message: a refusal is worded in terms of the
 * field and the provider's status (`lib/host-providers.ts` replaces any message that held it).
 */
import { MODELS_COPY } from '../../../app/copy/models.ts';
import {
  connectProvider,
  HostProviderError,
  testProviderKey,
} from '../../../lib/host-providers.ts';
import { providerDisplayName } from './format-model.ts';

/** Where the key is in its test-then-save sequence. */
export type KeyFlowPhase =
  /** Nothing has been asked yet, or the key was edited since the last answer. */
  | 'idle'
  /** The provider is being asked whether it accepts the key. */
  | 'testing'
  /** The provider accepted the key and the host is saving it. */
  | 'saving'
  /** The test failed: the reason is in `fieldError`. */
  | 'failed'
  /** A Test on its own passed, and the key has not been saved. */
  | 'tested'
  /** The host saved the key. */
  | 'connected';

/** What the sequence needs from its dialog. */
export type KeyFlowOptions = {
  /** The provider the dialog is for, read when a test or save begins. */
  readonly provider: () => string | null;
  /** Called once the host has saved the key, with the provider and how many models its test counted. */
  readonly onSaved: (provider: string, models: number) => void;
  /**
   * Called before the provider is asked about the key, such as to store the provider's
   * configuration first (as `interborough providers connect` does): the host probes the key with the
   * configuration it holds, so a drafted base URL has to be stored for the probe to reach it, and a
   * key that passes is then the key tested against what will stay stored. It resolves `refused`
   * after showing why it could not, which stops the sequence; `stored` when it changed what the
   * host holds, which makes an earlier passing test of this key stale; and `unchanged` otherwise.
   */
  readonly beforeTest?: () => Promise<'stored' | 'unchanged' | 'refused'>;
};

/** The test-then-save sequence of one key field. Create one per dialog. */
export class KeyFlow {
  /** What the field holds. Bind the input to it. */
  key = $state('');
  /** Where the sequence is. */
  phase = $state<KeyFlowPhase>('idle');
  /** The reason the key was refused, or that the field is empty: shown at the field. */
  fieldError = $state('');
  /** Why the host could not save a key the provider accepted: shown in a callout, not at the field. */
  failure = $state('');
  /** How many models the last passing test counted. */
  models = $state(0);

  readonly #options: KeyFlowOptions;
  #tested: string | null = null;
  #controller: AbortController | undefined;
  #generation = 0;

  constructor(options: KeyFlowOptions) {
    this.#options = options;
  }

  /** Whether a request is in flight, which holds the field and the primary button. */
  get busy(): boolean {
    return this.phase === 'testing' || this.phase === 'saving';
  }

  /** Whether the host is writing the key, which cannot be cancelled half way. */
  get saving(): boolean {
    return this.phase === 'saving';
  }

  /** The field changed: an earlier answer no longer describes it. */
  edited(): void {
    if (this.busy || this.phase === 'connected') return;
    if (this.#tested !== null && this.#tested !== this.key) this.#tested = null;
    if (this.phase === 'failed' || this.phase === 'tested') this.phase = 'idle';
    this.fieldError = '';
    this.failure = '';
  }

  /** Asks the provider whether it accepts the key, and saves no key (`beforeTest` still stores the configuration). */
  async test(): Promise<void> {
    await this.#run(false);
  }

  /** Tests the key, unless it has just passed, and then saves it. */
  async submit(): Promise<void> {
    await this.#run(true);
  }

  /** Stops what is in flight and puts the sequence back as it was before the dialog opened. */
  reset(): void {
    this.#generation += 1;
    this.#controller?.abort();
    this.#controller = undefined;
    this.key = '';
    this.#tested = null;
    this.phase = 'idle';
    this.fieldError = '';
    this.failure = '';
    this.models = 0;
  }

  async #run(save: boolean): Promise<void> {
    const provider = this.#options.provider();
    if (this.busy || this.phase === 'connected' || provider === null) return;
    const key = this.key;
    if (key.trim() === '') {
      this.fieldError = MODELS_COPY.connectDialog.keyRequired;
      return;
    }
    const generation = ++this.#generation;
    this.fieldError = '';
    this.failure = '';
    if (this.#options.beforeTest !== undefined) {
      this.phase = 'testing';
      let prepared: 'stored' | 'unchanged' | 'refused';
      try {
        prepared = await this.#options.beforeTest();
      } catch (error) {
        if (generation !== this.#generation) return;
        this.failure = failureWords(error);
        this.phase = 'idle';
        return;
      }
      if (generation !== this.#generation) return;
      if (prepared === 'refused') {
        this.phase = 'idle';
        return;
      }
      if (prepared === 'stored') this.#tested = null;
    }
    if (this.#tested !== key) {
      this.phase = 'testing';
      const controller = new AbortController();
      this.#controller = controller;
      const reason = await this.#askProvider(provider, key, controller.signal);
      if (generation !== this.#generation) return;
      this.#controller = undefined;
      if (reason !== null) {
        this.fieldError = reason;
        this.phase = 'failed';
        return;
      }
      this.#tested = key;
    }
    if (!save) {
      this.phase = 'tested';
      return;
    }
    this.phase = 'saving';
    try {
      await connectProvider(provider, key);
    } catch (error) {
      if (generation !== this.#generation) return;
      this.failure = failureWords(error);
      this.phase = 'idle';
      return;
    }
    if (generation !== this.#generation) return;
    // The host has the key; the page does not keep it.
    this.key = '';
    this.#tested = null;
    this.phase = 'connected';
    this.#options.onSaved(provider, this.models);
  }

  /** Asks the provider; resolves to the words of why the key did not pass, or `null` when it did. */
  async #askProvider(provider: string, key: string, signal: AbortSignal): Promise<string | null> {
    const name = providerDisplayName(provider);
    try {
      const result = await testProviderKey(provider, key, { signal });
      if (result.ok) {
        this.models = result.models;
        return null;
      }
      return result.status === 401 || result.status === 403
        ? MODELS_COPY.keyTest.rejected(name, result.status)
        : MODELS_COPY.keyTest.unfinished(name, result.status);
    } catch (error) {
      if (signal.aborted) return MODELS_COPY.keyTest.failed;
      if (error instanceof HostProviderError && error.kind === 'invalid' && error.message !== '') {
        return error.message;
      }
      return MODELS_COPY.keyTest.failed;
    }
  }
}

/** The words for a refusal to save, none of which is the key. */
function failureWords(error: unknown): string {
  const copy = MODELS_COPY.connectDialog;
  if (!(error instanceof HostProviderError)) return copy.saveFailed;
  if (error.kind === 'locked') return copy.locked;
  if (error.kind === 'partial') return error.message === '' ? copy.partial : error.message;
  return error.message === '' ? copy.saveFailed : `${copy.saveFailed} ${error.message}`;
}
