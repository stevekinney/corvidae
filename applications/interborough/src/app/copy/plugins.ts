import { nameList } from './shared.ts';

/**
 * The words of Settings › Plugins: what Interborough loaded at startup, what each plugin adds and
 * what names it, the choices an owner makes (enabled, configuration, secrets), and the restart that
 * applies them (`routes/settings/plugins`).
 */
export const PLUGINS_COPY = {
  title: 'Plugins',
  intro: 'Code that adds tools, agents and workflows. Plugins load at startup.',
  /** The loading rule every page shares: skeleton rows after 300 ms, then a status line with a Cancel (board PageSettingsSections, "Plugins loading"). */
  loading: {
    label: 'Loading plugins',
    stillLoading: 'Still loading. This is taking longer than usual.',
    cancel: 'Cancel',
    canceled: 'Loading was canceled.',
    tryAgain: 'Try again',
  },
  /** A read that failed with nothing to show; `status` is the HTTP status the host answered, if it answered. */
  loadFailed: {
    title: 'Couldn’t load plugins.',
    description: (status: number | undefined): string =>
      status === undefined
        ? 'Interborough didn’t answer. Nothing you did caused it.'
        : `The server answered with an error (${String(status)}). Nothing you did caused it.`,
    openHealth: 'Open Health',
  },
  locked:
    'This host keeps its plugin choices and secrets in its deployment, so they cannot be changed here.',
  listLabel: 'Plugins',
  detailLabel: 'Plugin details',
  /** The list's header: the word, the number of plugins beside it, and a link to how a plugin is written. */
  listHeader: {
    heading: 'Plugins',
    howToAdd: 'How to add one',
    howToAddHref:
      'https://github.com/stevekinney/corvidae/blob/main/packages/interborough-plugin/README.md#where-a-plugin-lives',
  },
  empty: {
    title: 'No plugins loaded',
    description:
      'Interborough loads plugins from the packages its host lists and from the plugins folder in its home, when it starts.',
  },
  emptyDetail: {
    title: 'Pick a plugin',
    description: 'Its status, what it adds and its choices show here.',
  },
  alwaysOn: 'Always on',
  /** The switch's label tracks its state, so a disabled plugin's switch reads Disabled. */
  enabled: 'Enabled',
  disabled: 'Disabled',
  /** Under a disabled plugin's switch: turning it on is a restart. */
  enableNote: 'Enabling it asks to restart, because plugins load at startup.',
  /** What a disabled plugin holds back: the agents it ships, unavailable until it is on. */
  holdingBack: {
    lead: 'Holding back.',
    body: (names: readonly string[], title: string): string =>
      `${nameList(names)} ${names.length === 1 ? 'is' : 'are'} unavailable until ${title} is enabled.`,
  },
  /** A status word. Needs setup is neutral: amber is for what waits on the person (a restart, an attention). */
  status: {
    running: 'Running',
    needsSetup: 'Needs setup',
    disabled: 'Disabled',
    notLoaded: 'Not loaded',
    enabledAfterRestart: 'Enabled after restart',
    disabledAfterRestart: 'Disabled after restart',
    changesAfterRestart: 'Changes after restart',
  },
  source: { package: 'Package', folder: 'Folder', builtIn: 'Built in' },
  sourceKind: {
    package: 'Package plugin, loaded at startup',
    folder: 'Folder plugin, loaded at startup',
    builtIn: 'Part of Interborough, loaded at startup',
  },
  sections: {
    source: 'Source',
    adds: 'What it adds',
    configuration: 'Configuration',
    secrets: 'Secrets',
  },
  contributionKinds: {
    tool: 'Tools',
    activity: 'Activities',
    skill: 'Skills',
    trigger: 'Triggers',
    validator: 'Validators',
    guardrail: 'Guardrails',
    interceptor: 'Interceptors',
    'decision-router': 'Decision routing',
    reaction: 'Hook actions',
    provider: 'Model provider',
    embedder: 'Embeddings',
    'memory-detector': 'Memory detectors',
    scorer: 'Scorers',
    panel: 'Panels',
    formatter: 'Formatters',
    agent: 'Agents',
  } as Readonly<Record<string, string>>,
  /** The configuration form, built from the plugin's own schema. */
  configuration: {
    description: 'These fields come from the plugin’s own schema.',
    save: 'Save configuration',
    saving: 'Saving',
    /** Beside Save: what saving does and does not do. */
    note: 'Applies after restart. Saving doesn’t restart.',
    saved: 'Saved. Applies after restart.',
    savedNow: 'Saved. It applies at once.',
    /** The bold lead of a failed save; what follows says why. */
    failureLead: 'Couldn’t save the configuration.',
    failed: 'Interborough didn’t answer.',
    rejected: (message: string): string => (message === '' ? 'The host refused it.' : message),
    locked:
      'This host keeps its plugin choices in its deployment, so the configuration cannot be saved here.',
    notSet: 'Not set',
    addTag: 'Add a value',
    tagsLabel: (label: string): string => label,
    json: (label: string): string => `${label}, as JSON`,
    invalidJson: 'This is not valid JSON.',
  },
  secrets: {
    set: 'Set',
    missing: 'Missing',
    add: 'Add the key',
    replace: 'Replace',
    addLabel: (key: string): string => `Add the key for ${key}`,
    replaceLabel: (key: string): string => `Replace ${key}`,
    /** Under a missing key: where it is saved, and what happens once it is. */
    note: (directory: string, title: string, provider: boolean): string =>
      provider
        ? `Saved to ${directory}, readable only by you. The models appear as soon as the key passes a test.`
        : `Saved to ${directory}, readable only by you. ${title} works as soon as the key is saved; no restart.`,
    dialog: {
      title: (key: string): string => `Save ${key}`,
      description: (plugin: string): string =>
        `The value is stored on this machine, where only you can read it, and ${plugin} uses it at once. No restart is needed.`,
      valueLabel: 'Value',
      valueDescription: 'It is sent once and is never shown again.',
      valueRequired: 'Enter a value to save.',
      cancel: 'Cancel',
      save: 'Save',
      saved: (key: string): string => `${key} saved`,
      locked: 'This host keeps its secrets in its deployment, so one cannot be saved here.',
      failed: 'The secret could not be saved.',
    },
  },
  /** The line at the foot of a running plugin: what uses it. */
  inUse: {
    lead: 'In use.',
    nothing: (title: string): string => `Nothing uses ${title} yet.`,
    some: (title: string, parts: readonly string[], singular: boolean): string =>
      `${nameList(parts)} ${singular ? 'uses' : 'use'} ${title}.`,
  },
  counts: {
    agents: (count: number): string => `${String(count)} ${count === 1 ? 'agent' : 'agents'}`,
    schedules: (count: number): string =>
      `${String(count)} ${count === 1 ? 'schedule' : 'schedules'}`,
    waitingRuns: (count: number): string =>
      `${String(count)} waiting ${count === 1 ? 'run' : 'runs'}`,
  },
  banner: {
    changes: (count: number): string =>
      count === 1
        ? '1 change waits for a restart.'
        : `${String(count)} changes wait for a restart.`,
    explanation: 'Plugin code loads when Interborough starts. Runs pick up where they stopped.',
    discard: 'Discard',
    restartNow: 'Restart now',
    failed: 'The changes could not be saved, so Interborough was not restarted.',
    rejected: (plugin: string): string =>
      `${plugin} was not saved, so Interborough was not restarted. Open it to see what the host rejected.`,
    saved: 'Saved. The host applied these changes at once, so no restart was needed.',
    refused: 'This host cannot restart itself. Restart it where it runs.',
    unreachable: 'Interborough did not answer, so it was not asked to restart. Try again.',
  },
  /** The question before a plugin is turned off (row 49x): a Cinder confirm dialog that lists what depends on it. */
  disable: {
    title: (name: string): string => `Disable ${name}?`,
    intro: 'Interborough restarts to unload it. What depends on it:',
    /** The bold word that leads the sentence when nothing depends on the plugin. */
    nothingLead: 'Nothing',
    nothing: (title: string): string => ` uses ${title} yet, so nothing becomes unavailable.`,
    agents: (count: number, ids: string): string =>
      count === 1 ? `uses ${ids} and shows as unavailable.` : `use ${ids} and show as unavailable.`,
    schedules: (count: number, ids: string): string =>
      `${count === 1 ? 'starts' : 'start'} runs through ${ids}. ${count === 1 ? 'It stays' : 'They stay'} listed and ${count === 1 ? 'does' : 'do'} nothing until it is back.`,
    waitingRuns: (count: number, ids: string): string =>
      count === 1
        ? `waits on ${ids}. It shows as unavailable instead of resuming.`
        : `wait on ${ids}. They show as unavailable instead of resuming.`,
    alsoWrites: 'Restarting also saves these changes, which are waiting:',
    alsoSwitchedOn: 'switched on',
    alsoSwitchedOff: 'switched off',
    reassurance: 'Nothing is deleted. Enable it again and restart, and it works as before.',
    cancel: 'Cancel',
    confirm: 'Disable and restart',
  },
  /** The question before a disabled plugin is turned on (row 51b): what becomes available again, and that it restarts. */
  enable: {
    title: (name: string): string => `Enable ${name}?`,
    /** The sentence before what comes back; with nothing to name, it stands alone. */
    intro: 'Interborough restarts to load it.',
    /** What the plugin's agents do once it is on: "Release helper and Changelog writer become available again." */
    available: (names: readonly string[]): string =>
      `${nameList(names)} ${names.length === 1 ? 'becomes' : 'become'} available again.`,
    /** What a restart does to running work, which every restart says. */
    work: 'Running work picks up where it stopped; reviews stay waiting.',
    alsoWrites: 'Restarting also saves these changes, which are waiting:',
    cancel: 'Cancel',
    confirm: 'Enable and restart',
  },
  /**
   * One card per problem code (COR-1895). The table of the first six is the owner's wording
   * (Interborough plugins, boards 26–28); the cards after `developmentSource` are for codes the
   * host added later, in the same voice. A body is a function of the fields its code carries.
   */
  problems: {
    /** The accessible name of the list the Plugins page opens with after a startup with problems. */
    listLabel: 'Plugins that need attention',
    title: 'Needs attention',
    unknown: (code: string): string => `Reported as ${code}.`,
    /** The status of a problem whose code this page has no words for. */
    unknownStatus: 'Not recognised',
    secretMissing: {
      status: 'Needs setup',
      title: 'A secret isn’t saved yet',
      /** `plural` is whether what waits reads as more than one thing ("Gemini models and embeddings"). */
      body: (key: string, what: string, plural: boolean): string =>
        plural
          ? `${key} isn’t saved, so ${what} are unavailable. Save it and they work at once, with no restart.`
          : `${key} isn’t saved, so ${what} is unavailable. Save it and it works at once, with no restart.`,
      /** The body when the host lists nothing that waits for the secret. */
      bodyWithoutContributions: (key: string): string =>
        `${key} isn’t saved, so what this plugin adds is unavailable. Save it and it works at once, with no restart.`,
      action: 'Add the key',
    },
    configurationInvalid: {
      status: 'Not loaded',
      title: 'A setting is invalid',
      /** `label` is the field as a person reads it ("Grounding threshold"), never its key; `message` is what the plugin said. */
      body: (label: string, message: string): string =>
        label === '' ? message : `${label}: ${message}`,
      action: 'Fix the setting',
    },
    /** A provider plugin's `models` allowlist names a model nobody offers: `configuration-invalid` at `models[<index>]`. */
    allowlistInvalid: {
      status: 'Not loaded',
      title: 'A model list names a model nobody offers',
      action: 'Fix the setting',
    },
    referenceUnresolved: {
      status: 'Loaded, 1 file skipped',
      title: 'An agent names something nobody adds',
      body: (file: string, id: string): string =>
        `${file} lists ${id}, which no loaded plugin adds. The agent is unavailable until the name matches.`,
      action: 'Open the file',
    },
    nameClash: {
      status: 'Not loaded',
      title: 'Two plugins share a name',
      body: (first: string, second: string, name: string, loaded: string): string =>
        `${first} and ${second} are both named ${name}. ${loaded} loaded; rename the other.`,
      action: 'Show both',
    },
    pinnedVersionUnavailable: {
      status: 'After a restart',
      title: 'A waiting run needs a version that isn’t loaded',
      body: (id: string, version: string, runs: number): string =>
        runs === 1
          ? `1 waiting run is pinned to ${id}@${version}, so it shows as unavailable. Cancel it, or go back to ${version} and restart.`
          : `${String(runs)} waiting runs are pinned to ${id}@${version}, so they show as unavailable. Cancel them, or go back to ${version} and restart.`,
      action: 'Open the run',
    },
    developmentSource: {
      status: 'Development',
      title: 'Loaded from your working copy',
      body: (path: string): string =>
        `Started with --plugin ${path}. Interborough restarts when its code changes; its agents and workflows reload without one.`,
      action: 'Open the folder',
      /** What the page says once it has put the folder’s path on the clipboard: a browser cannot open a folder. */
      copied: 'The folder’s path is copied.',
      copyFailed: 'The folder’s path could not be copied.',
    },
    /** The host refused a secret the plugin declared; the message names the key and never a value. */
    secretRefused: {
      status: 'Not loaded',
      title: 'A secret can’t be kept here',
      body: (key: string, message: string): string =>
        message === '' ? `${key} can’t be used as this plugin’s secret.` : message,
    },
    /** The plugin’s code did not load from its folder, such as an import nothing provides. */
    loadFailed: {
      status: 'Not loaded',
      title: 'The plugin’s code didn’t load',
      body: (message: string): string => message,
    },
    /** The plugin’s `setup` threw, or returned something that cannot be registered. */
    setupFailed: {
      status: 'Not loaded',
      title: 'The plugin’s setup failed',
      body: (message: string): string => message,
    },
    /** The plugin’s `start` threw; what it adds stays registered. */
    startFailed: {
      status: 'Loaded, a step after startup failed',
      title: 'A step after startup failed',
      body: (message: string): string => message,
    },
    /** A panel the plugin contributed could not be built; the plugin and its other parts run. */
    panelFailed: {
      status: 'Loaded, a panel was not built',
      title: 'A panel the plugin adds did not build',
      body: (panel: string, message: string): string =>
        `The panel ${panel} is not served. ${message}`,
    },
  },
  /** The banner every page shows after a startup where a plugin or a folder did not load. */
  startupBanner: {
    /** The accessible name of the region. */
    label: 'Plugins that did not load',
    message: (count: number): string =>
      count === 1
        ? '1 plugin needs attention after a startup with problems'
        : `${String(count)} plugins need attention after a startup with problems`,
    /** The second line, which says what the problems mean for the work that uses the plugins. */
    consequence: (count: number): string =>
      count === 1
        ? 'Agents and workflows that use it show as unavailable.'
        : 'Agents and workflows that use them show as unavailable.',
    action: 'Open Plugins',
  },
  unloaded: {
    heading: 'Folders that did not load',
    description: 'These folders hold no plugin Interborough could use.',
  },
} as const;

/** What plugins add to hooks and workflows (COR-1893). */
export const PLUGIN_KINDS_COPY = {
  /** The fields of a contributed kind, shown by a form drawn from its schema. */
  fieldsHeading: 'Settings',
  /** A contributed kind whose configuration takes no fields. */
  noFields: 'This takes no settings.',
  /** A contributed kind whose schema the form cannot draw. */
  fieldsUnavailable: 'The settings of this kind cannot be shown here.',
  /** The hook editor's choice for a contributed action: what it does, then the plugin. */
  hookAction: (plugin: string, kind: string): string => `Run ${kind} from ${plugin}`,
} as const;
