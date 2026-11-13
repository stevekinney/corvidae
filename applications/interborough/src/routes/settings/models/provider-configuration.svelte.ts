/**
 * The draft of a provider's plugin configuration in the Connect and Manage dialogs: what the
 * `contributed-configuration-form` reports, whether it differs from what the host stores, and the
 * save (`PUT /host/plugins/<plugin>`, as Settings › Plugins does it, with its words for the outcome).
 *
 * The form shows defaults and the first choice of a field the configuration holds nothing for, so
 * "differs" compares the draft with what the form would show for the stored value, not with the
 * stored value itself: an untouched dialog is not an edit and saves nothing.
 */
import { schemaFormInitialDraft } from '@lostgradient/cinder';

import { PLUGINS_COPY } from '../../../app/copy/plugins.ts';
import { showToast } from '../../../app/toast-host.svelte';
import {
  contributedFormHasFields,
  contributedFormSchema,
  isSameJson,
} from '../../../lib/contributed-configuration.ts';
import { HostPluginError, updatePlugin } from '../../../lib/host-plugins.ts';
import { refusedField } from '../plugins/plugin-configuration.ts';
import {
  configurationObject,
  configurationWithoutEmpty,
  undrawnFields,
  type ProviderConfigurationSource,
} from './provider-configuration.ts';

/** A refusal shown on the field it names. */
export type ConfigurationIssue = { path: readonly (string | number)[]; message: string };

/** What the draft needs from its dialog. */
export type ProviderConfigurationOptions = {
  /** The provider's configuration source now, or `undefined` while the dialog has none. */
  readonly source: () => ProviderConfigurationSource | undefined;
  /** Called once the host has stored the configuration, so the page reads the plugins again. */
  readonly onSaved: () => Promise<void>;
};

/** The configuration draft of one dialog. Create one per dialog. */
export class ProviderConfigurationDraft {
  /** What the form last reported; `undefined` until the form is edited. */
  draft = $state<Record<string, unknown> | undefined>(undefined);
  /** The fields the host refused, shown at the fields. */
  issues = $state<ConfigurationIssue[]>([]);
  /** Why a save failed when no field is to blame: shown in a callout. */
  failure = $state('');
  /** Whether the host is storing the configuration. */
  saving = $state(false);

  readonly #options: ProviderConfigurationOptions;

  constructor(options: ProviderConfigurationOptions) {
    this.#options = options;
  }

  /** The source the dialog draws, if the provider has a plugin to hold a configuration. */
  get source(): ProviderConfigurationSource | undefined {
    return this.#options.source();
  }

  /** The name the form is made by, so it starts over for another provider. */
  get kindId(): string {
    return `provider:${this.source?.provider ?? ''}`;
  }

  /** The schema as the form reads it. */
  get formSchema(): Record<string, unknown> | undefined {
    const source = this.source;
    return source === undefined ? undefined : contributedFormSchema(this.kindId, source.schema);
  }

  /** Whether the provider's plugin has a configuration schema the page cannot draw. */
  get undrawable(): boolean {
    const source = this.source;
    return source !== undefined && source.schema === null;
  }

  /** Whether the schema has a field to draw. */
  get hasFields(): boolean {
    return contributedFormHasFields(this.formSchema);
  }

  /** What the host stores now, as an object. */
  get stored(): Record<string, unknown> {
    return configurationObject(this.source?.stored);
  }

  /** What the form shows for the stored configuration, which an untouched dialog holds. */
  get #baseline(): Record<string, unknown> {
    const schema = this.formSchema;
    const shown = schema === undefined ? undefined : schemaFormInitialDraft(schema, this.stored);
    return configurationWithoutEmpty(configurationObject(shown ?? this.stored));
  }

  /** Whether the draft differs from what the form shows for the stored configuration. */
  get dirty(): boolean {
    if (this.draft === undefined || !this.hasFields) return false;
    return !isSameJson(configurationWithoutEmpty(this.draft), this.#baseline);
  }

  /** The form reported a draft. */
  change(next: Record<string, unknown>): void {
    this.draft = next;
    this.issues = [];
    this.failure = '';
  }

  /**
   * Stores the draft, with the stored fields the form does not draw kept as they are. Resolves
   * `true` when the host has stored it (or there is nothing to store), and `false` after showing why not.
   */
  async save(): Promise<boolean> {
    const source = this.source;
    const draft = this.draft;
    if (source === undefined || draft === undefined || !this.dirty) return true;
    if (this.saving) return false;
    const copy = PLUGINS_COPY.configuration;
    const configuration = {
      ...undrawnFields(this.stored, this.formSchema),
      ...configurationWithoutEmpty(draft),
    };
    this.saving = true;
    this.issues = [];
    this.failure = '';
    try {
      const stored = await updatePlugin(source.plugin, { configuration });
      showToast(stored.restartRequired ? copy.saved : copy.savedNow, { variant: 'success' });
      await this.#options.onSaved();
      this.draft = undefined;
      return true;
    } catch (error) {
      this.#fail(error);
      return false;
    } finally {
      this.saving = false;
    }
  }

  #fail(error: unknown): void {
    const copy = PLUGINS_COPY.configuration;
    if (error instanceof HostPluginError && error.kind === 'invalid') {
      const key = refusedField(error.field);
      const properties = this.formSchema?.['properties'];
      if (
        key !== undefined &&
        typeof properties === 'object' &&
        properties !== null &&
        Object.hasOwn(properties, key)
      ) {
        this.issues = [{ path: [key], message: copy.rejected(error.message) }];
        return;
      }
      this.failure = copy.rejected(error.message);
    } else if (error instanceof HostPluginError && error.kind === 'locked') {
      this.failure = copy.locked;
    } else {
      this.failure = copy.failed;
    }
  }

  /** Puts the draft back as it was before the dialog opened. */
  reset(): void {
    this.draft = undefined;
    this.issues = [];
    this.failure = '';
    this.saving = false;
  }
}
