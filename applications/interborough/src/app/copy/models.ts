import { nameList } from './shared.ts';

/**
 * The words of Settings › Models: the providers agents call, the models those providers offer, and
 * the models that answer decisions (`routes/settings/models`).
 */
export const MODELS_COPY = {
  title: 'Models',
  intro: 'Agents run on a model. Connect a provider to make its models available.',
  loading: 'Loading providers and models',
  /** The notice shown when a page sent the person here to connect a provider, with the way back. */
  returnNotice: {
    title: 'Connect a provider to continue',
    description: 'Connect one provider, then go back to the agent form.',
    connectedDescription: 'A provider is connected. Go back to the agent form.',
    action: 'Back to the agent form',
  },
  loadFailed: {
    title: 'Providers are unavailable',
    description: 'The host did not answer. Check that it is running, then try again.',
  },
  /** The names of the providers the host can call. A provider not listed here shows its own name. */
  providerNames: { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Gemini' } as Readonly<
    Record<string, string>
  >,
  /** What each provider's models are called, under its name. A provider not listed here shows nothing. */
  providerTaglines: {
    anthropic: 'Claude models',
    openai: 'GPT models',
    gemini: 'Gemini models',
  } as Readonly<Record<string, string>>,
  /** The order the providers are listed in; one the host adds follows them. */
  providerOrder: ['anthropic', 'openai', 'gemini'] as readonly string[],
  locked:
    'This host keeps its providers and keys in its deployment, so they cannot be changed here.',
  providers: {
    heading: 'Providers',
    /** The reason there is no provider banner: while none is connected this says why agents can't answer. */
    description:
      'Agents can’t answer until one is connected. Connect one to make its models available.',
    connectedDescription: 'Connected providers offer their models to your agents.',
    listLabel: 'Providers',
    connected: 'Connected',
    connect: 'Connect',
    manage: 'Manage',
    connectLabel: (name: string): string => `Connect ${name}`,
    manageLabel: (name: string): string => `Manage ${name}`,
  },
  /** Connect (board SettingsShell, "Connect, empty", "testing", "invalid key" and "connected"). */
  connectDialog: {
    title: (name: string): string => `Connect ${name}`,
    /** The line under the title, which says where the dialog is. */
    subtitle: {
      idle: 'Paste an API key, then test it.',
      testing: 'Testing the key.',
      failed: 'The test failed.',
      tested: 'The key works.',
      saveFailed: 'The key could not be saved.',
      connected: 'Connected.',
    },
    keyLabel: 'API key',
    keyPlaceholder: 'Paste your API key',
    keyHelp: 'Saved to ~/.interborough/secrets when you connect, readable only by you.',
    getKey: 'Where do I get one?',
    keyRequired: 'Enter the key.',
    /** Under the field while Connect, or Test, asks the provider. */
    testing: 'Testing the connection…',
    test: 'Test',
    connect: 'Connect',
    /** The primary button while it tests, disabled. */
    connecting: 'Testing…',
    cancel: 'Cancel',
    done: 'Done',
    /** The success banner: after Connect, and after Test on its own. */
    connectedTitle: 'Connected',
    testedTitle: 'The key works',
    models: (count: number): string =>
      count === 1 ? '1 model is available.' : `${String(count)} models are available.`,
    locked: 'This host keeps its keys in its deployment, so it cannot save one.',
    partial: 'The key was stored, but the configuration could not be written.',
    saveFailed: 'The key could not be saved.',
  },
  /** Why a test did not pass, worded at the field. Never carries the key. */
  keyTest: {
    rejected: (provider: string, status: number | undefined): string =>
      `${provider} didn’t accept this key${status === undefined ? '' : ` (${String(status)})`}. Check that you copied all of it.`,
    unfinished: (provider: string, status: number | undefined): string =>
      `Couldn’t finish testing the key with ${provider}${status === undefined ? '' : ` (${String(status)})`}. Check your connection and try again.`,
    failed: 'The key could not be tested.',
  },
  /** Replace key (board SettingsShell, "Replace key, in progress"). */
  replaceDialog: {
    title: (name: string): string => `Replace the ${name === '' ? 'provider' : name} key`,
    subtitle: 'The old key stays in use until the new one passes.',
    keyLabel: 'New API key',
    testing: 'Testing the new key…',
    replace: 'Replace key',
    cancel: 'Cancel',
    toast: (name: string): string => `${name} key replaced`,
  },
  /** Manage (board SettingsShell, "Manage, a connected provider"). The saved key is never shown. */
  manageDialog: {
    /** The title while no provider is chosen, which a closed dialog still carries. */
    fallbackTitle: 'Provider',
    subtitle: 'Connected',
    connected: 'Connected',
    models: (count: number): string => `${String(count)} ${count === 1 ? 'model' : 'models'}`,
    removeKey: 'Remove key',
    replaceKey: 'Replace key',
    done: 'Done',
    /** The primary button while the provider's settings differ from what is stored, in place of Done. */
    save: 'Save',
    saving: 'Saving…',
  },
  /** A provider's plugin settings, drawn from the plugin's own schema in the Connect and Manage dialogs. */
  configuration: {
    /** Names the settings under the key field of the Connect dialog. */
    heading: 'Settings',
    /** Said when the plugin's settings could not be written as a schema the page can draw. */
    unavailable: (plugin: string): string => `The settings of ${plugin} can’t be shown here.`,
  },
  /** Remove key (board SettingsShell, "Remove key, confirm"). */
  removeDialog: {
    title: (name: string): string => `Remove the ${name} key?`,
    /** Names the agents that stop answering. Run now on their schedules is disabled with them. */
    description: (agents: readonly string[]): string =>
      `${nameList(agents)} ${agents.length === 1 ? 'stops' : 'stop'} answering until you add a key. Run now on ${agents.length === 1 ? 'its' : 'their'} schedules is disabled too. Chats and runs stay.`,
    /** When no agent uses the provider's models, so nothing stops answering. */
    descriptionNoAgents: (name: string): string =>
      `No agent uses ${name} models, so none stops answering. Chats and runs stay.`,
    checking: (name: string): string => `Looking for agents that use ${name} models…`,
    agentsUnknown: (name: string): string =>
      `The agents could not be read, so which ones use ${name} models is not known. Chats and runs stay.`,
    trimmedNote: (agents: readonly string[], name: string): string =>
      `${nameList(agents)} still ${agents.length === 1 ? 'answers' : 'answer'}, but ${agents.length === 1 ? 'loses' : 'lose'} ${name} models from the ones ${agents.length === 1 ? 'it' : 'they'} can be switched to.`,
    embedderNote:
      'If a memory embedder from this provider is selected, memory needs setup again until you connect it or choose another.',
    confirm: 'Remove key',
    busy: 'Removing…',
    cancel: 'Cancel',
    toast: (name: string): string => `${name} key removed`,
    failedTitle: 'Couldn’t remove the key.',
    failed: 'The key is still saved.',
    locked: 'This host keeps its keys in its deployment, so it cannot remove one.',
  },
  /** The catalog (board SettingsShell, "Models, /settings/models" and "Models, provider connected"). */
  models: {
    heading: 'Models',
    /** With no model to list, the catalog says only what it is. */
    emptyDescription: 'Every model your connected providers offer.',
    description:
      'Every model your connected providers offer. Which models agents may use is set under Allowed models.',
    tableLabel: 'Models',
    columns: {
      model: 'Model',
      abilities: 'Abilities',
      context: 'Context',
      allowed: 'Allowed',
    },
    allowed: 'Allowed',
    notAllowed: 'Not allowed',
    empty: {
      title: 'No models yet',
      description: 'Models appear here once you connect a provider.',
      action: 'Go to Providers',
    },
    /** The catalog failed to load after the key was saved: the error sits here, not on the provider row. */
    loadFailed: {
      title: 'Couldn’t load the models',
      description: (providers: readonly string[], status: number | undefined): string => {
        const code = status === undefined ? '' : ` (${String(status)})`;
        if (providers.length === 0) return `The model list didn’t come back${code}.`;
        const subject =
          providers.length === 1
            ? `${providers.join('')} is connected, but its model list`
            : `${nameList(providers)} are connected, but their model lists`;
        return `${subject} didn’t come back${code}.`;
      },
      retry: 'Try again',
    },
  },
  /** The Decisions section (board SettingsShell, "Models, /settings/models"). */
  decisions: {
    heading: 'Decisions',
    description:
      'The model that makes quick judgments for the app, apart from the models agents chat with.',
    model: {
      label: 'Decision model',
      description:
        'Answers yes-or-no and classification questions for Interborough. Leave it empty to let the fallback model answer.',
      /** Said instead while the chosen row is empty, missing or needs setup: the row that answers, named by the Bureau. */
      fallbackAnswers: (model: string) => `${model} answers until a decision model is ready.`,
      /** Said while the Bureau reports no row that can answer. */
      nothingAnswers: 'Nothing can answer decisions until you connect a provider or TypeSafe.',
      connect: 'Connect TypeSafe',
      /** The empty option of the select. */
      none: 'The fallback model alone',
      /** The Bureau dropped the stored value and records why; the row warns in these words, not the Bureau's. */
      dropped:
        'The saved decision model no longer exists, so the fallback answers. Choose another.',
      /** The stored value names a row the Bureau does not list as able to answer. */
      missing: (name: string) =>
        `“${name}” can’t answer decisions, so the fallback answers. Choose another.`,
    },
    fallbackModel: {
      label: 'Fallback model',
      description: 'Used when the decision model can’t answer.',
    },
    /** The mark beside a row whose provider has no key saved yet or whose model is off. */
    needsSetup: 'Needs setup',
    maximumPerTask: {
      label: 'Maximum per task',
      description: 'The most decision calls one task may make.',
    },
  },
} as const;

/**
 * The words of Settings › Allowed models (board PageSettingsSections, "Allowed models,
 * /settings/allowed-models"): which models agents may use, and the caller's own preferences among
 * them. Saving is explicit, because it raises the policy revision.
 */
export const ALLOWED_MODELS_COPY = {
  intro: 'Which models agents may use, and what to prefer among them.',
  models: {
    title: 'Models',
    description:
      'Every model your connected providers offer; untick one to keep agents from using it.',
    empty: 'No models yet. Connect a provider and its models appear here to allow.',
    goToProviders: 'Go to Providers',
    /** The name of a provider's group of models. */
    groupLabel: (provider: string): string => `${provider} models`,
    loading: 'Loading models…',
    loadFailed: 'Couldn’t load the models.',
    tryAgain: 'Try again',
    /** Said under a model whose whole provider the policy keeps agents from using. */
    providerDenied: 'Its provider is not allowed by the host.',
    /** What a model that has none of the abilities below says in their place. */
    noAbilities: 'Text only',
    abilities: { tools: 'tools', images: 'images' },
  },
  preferences: {
    title: 'Preferences',
    description: 'Cost, speed and effort, among the models allowed above.',
    prefer: {
      label: 'Prefer',
      identifier: 'preferences.prefer',
      description: 'Which to favour when more than one allowed model fits.',
      options: {
        neither: 'Neither',
        cost: 'Lowest cost',
        speed: 'Fastest',
        both: 'Lowest cost and fastest',
      },
    },
    effort: {
      label: 'Default effort',
      identifier: 'preferences.effort',
      description: 'How hard a model thinks when an agent doesn’t say.',
      notSet: 'Not set',
    },
  },
  /** The effect of saving, under the preferences and beside the buttons. */
  note: 'Saving raises the policy revision, so plans made under the old policy are re-checked.',
  effect: 'Saving raises the policy revision.',
  reset: 'Reset to default',
  save: 'Save',
  saveFailed: {
    title: 'Couldn’t save.',
    didNotAnswer: 'Interborough didn’t answer.',
    stillHere: 'Your choices are still here.',
  },
  lockedNote: 'The host sets the model policy, and it cannot be changed here.',
} as const;
