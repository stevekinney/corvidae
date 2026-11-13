/** The sections of Settings, in the order its section navigation lists them. */
export const SETTINGS_SECTION_COPY = {
  navigation: 'Settings sections',
  general: 'General',
  models: 'Models',
  modelPolicy: 'Allowed models',
  a2a: 'A2A',
  plugins: 'Plugins',
  dataAndRetention: 'Data and retention',
  apiReference: 'API reference',
} as const;

/**
 * The words of Settings › Data and retention: how long each kind of record is kept, and how much
 * space the records take (board PageSettingsSections, "Data and retention"; rows 50d to 50g).
 */
export const DATA_RETENTION_COPY = {
  title: 'Data and retention',
  intro: 'How long Interborough keeps what it records. Settings save as you leave a field.',
  /** The status at the right of the heading once any row has saved. */
  saved: 'Saved just now',
  /** The names of the four retention rows; the raw key sits small beside each. */
  labels: {
    'retention.audit': 'Audit records',
    'retention.runs': 'Run history',
    'retention.chats': 'Chats',
    'retention.memory': 'Memory',
  } as Readonly<Record<string, string>>,
  retention: {
    heading: 'Retention',
    keepForever: 'Keep forever',
    deleteAfter: 'Delete after',
    days: 'days',
    /** The accessible name of a row's choice between keeping and deleting. */
    choiceLabel: (name: string): string => `${name}: how long to keep`,
    /** The accessible name of a row's days field. */
    daysLabel: (name: string): string => `${name}: days before deleting`,
    daysProblem: 'Enter a number from 1 to 3650.',
  },
  /** The section of the retention windows the board draws no row for: events, tasks, receipts and the rest. */
  otherRetention: {
    heading: 'Other retention',
    description: 'How long the rest of what Interborough records is kept.',
  },
  storage: {
    heading: 'Storage',
    label: 'Space used',
    description: 'What Interborough’s records take up on this machine.',
    firingDescription: 'Health lists this under Needs attention.',
    openHealth: 'Open Health',
    overWarning: (size: string): string => `Storage is over its warning level, ${size}`,
    notReported: 'Not reported yet',
  },
  /** The Clean-up section: the nightly removal of expired records, and "Clean up now" (rows 50h and 50j). */
  cleanUp: {
    heading: 'Clean-up',
    label: 'Remove expired records',
    action: 'Clean up now',
    /** The row's description: when it happens each night, in the host's zone. */
    schedule: (time: string, zone: string): string =>
      `Interborough does this every night at ${time} ${zone}.`,
    /** When it last ran, said after the schedule; `when` already names the day ("Sun Nov 1, 3:00 AM"). */
    last: (when: string): string => `Last cleaned up ${when}.`,
    /** A night it did not run, said after the schedule; `day` is "today" or a day and time. */
    skipped: (day: string): string => `Skipped ${day} while Interborough was off.`,
    working: 'Cleaning up…',
    /** What a clean-up that finished says on the row, with how many records it removed. */
    done: (removed: number): string =>
      removed === 0
        ? 'Cleaned up just now. Nothing was past its retention window.'
        : `Cleaned up just now. Removed ${String(removed)} ${removed === 1 ? 'record' : 'records'}.`,
    /** A clean-up that finished but could not remove some kinds of record; `kinds` names them. */
    partial: (removed: number, kinds: string): string =>
      `Cleaned up just now, but ${kinds} could not be removed. Removed ${String(removed)} ${removed === 1 ? 'record' : 'records'}.`,
    failed: 'Couldn’t clean up. Nothing was removed.',
    retry: 'Try again',
    /** The kinds of record a clean-up removes, as a sentence names them. */
    kinds: {
      audit: 'audit records',
      reviews: 'reviews',
      memories: 'memories',
      logs: 'logs',
      notifications: 'notifications',
      hookDeliveries: 'hook deliveries',
      chats: 'chats',
    } as Readonly<Record<string, string>>,
  },
} as const;

/** The words the settings page (`/settings`) uses outside its view states. */
export const SETTINGS_COPY = {
  /** The General page (board SettingsShell, "General, /settings"). */
  general: {
    intro: 'Tools, runs and your own preferences. Settings save as you leave a field.',
    /** The heading narrow widths show over the section select, which names the section. */
    narrowTitle: 'Settings',
    sections: {
      tools: { title: 'Tools' },
      runs: {
        title: 'Runs',
        description: 'Settings that apply after a restart say so, and a saved one waits for it.',
      },
      storage: { title: 'Storage' },
      remote: { title: 'Remote deployment' },
      preferences: {
        title: 'Your preferences',
        description:
          'Only you see these. They live in this browser and in quick settings, apart from the settings above that belong to this installation.',
      },
    },
    /** The row of the storage backend, which the host reports rather than the Bureau holding a setting. */
    storageBackend: {
      label: 'Storage backend',
      identifier: 'storage.backend',
      description: 'Where Interborough keeps runs, chats and memories. Chosen when it was set up.',
      remoteDescription: 'Where Interborough keeps runs, chats and memories.',
      local: 'SQLite, on this machine',
      remote: 'Postgres and S3',
      setByDeployment: 'Set by the deployment',
    },
    preferences: {
      theme: {
        label: 'Theme',
        identifier: 'theme',
        description: 'Matches your system by default.',
        options: { system: 'System', light: 'Light', dark: 'Dark' },
      },
      sidebar: {
        label: 'Sidebar',
        identifier: 'sidebar',
        description: 'Whether the sidebar starts expanded on this browser.',
        options: { expanded: 'Expanded', collapsed: 'Collapsed' },
      },
      defaultAgent: {
        label: 'Default agent for new chats',
        identifier: 'chat.defaultAgent',
        description: 'The agent a new chat starts with.',
        none: 'First agent that can run',
      },
      singleKey: {
        label: 'Use single-key shortcuts',
        identifier: 'shortcuts.singleKey',
        description:
          'Press G then a letter to go somewhere, or C for a new chat. They never act while you type in a field.',
      },
    },
    /** The sticky banner over the page while saved settings wait for a restart. */
    restartBanner: {
      title: (count: number): string =>
        count === 1
          ? '1 change waits for a restart'
          : `${String(count)} changes wait for a restart`,
      detail: (names: readonly string[]): string =>
        `${names.join(', ')}. Running work picks up where it stopped; reviews stay waiting.`,
      /** Puts every waiting setting back to the value the host runs now (board SettingsShell, "More states"). */
      revert: (count: number): string =>
        count === 1 ? 'Revert 1 change' : `Revert ${String(count)} changes`,
    },
    /** The Undo toast after Revert, and what the page says when Revert or Undo does not go through. */
    reverted: {
      toast: (count: number): string =>
        `Reverted ${count === 1 ? '1 change' : `${String(count)} changes`}. Nothing needs a restart.`,
      revertFailed: 'Couldn’t revert. The changes still wait for a restart.',
      undoFailed: 'Couldn’t undo. The settings stay reverted.',
    },
    /**
     * A setting's own words where the Remote deployment card shows it, in place of the Bureau's
     * description (board SettingsShell, "Locked settings, remote mode"): a remote deployment's
     * runs are not on this machine.
     */
    remoteDescriptions: {
      'engine.maxConcurrentRuns': 'The most workflow runs that execute at the same time.',
    } as Readonly<Record<string, string>>,
    /** The status of a row a restart just applied. */
    inEffectSince: (time: string): string => `In effect since ${time}`,
    /** Loading, and giving up on it. */
    loading: {
      label: 'Loading settings',
      stillLoading: 'Still loading. This is taking longer than usual.',
      canceled: 'Loading was canceled.',
      tryAgain: 'Try again',
    },
  },
  /** The label of the section select that replaces the navigation below 640px. */
  sectionSelect: 'Section',
  /** A value that failed its check was not saved. */
  nothingSaved: 'Nothing was saved.',
  /** A save that did not go through; the typed value is still in the field. */
  couldNotSave: 'Couldn’t save. Your value is still in the field.',
  /** A locked setting (board SettingsShell, "Locked settings, remote mode"). */
  lockedMessage:
    'Locked by your deployment (remote mode). Change it in the deployment’s configuration.',
  /**
   * The keyboard preference on the General page (design row 03f): it lives in this browser, so it is
   * not one of the deployment's settings above it.
   */
  keyboard: {
    title: 'Keyboard',
    singleKeyLabel: 'Use single-key shortcuts',
    singleKeyDescription:
      'Press G then a letter to go somewhere, or C for a new chat. They never act while you type in a field. Shortcuts held with ⌘ and the ? map always work. This applies to this browser only.',
  },
  intro:
    'These apply to the whole deployment. A setting that applies live takes effect at its next use, and one that needs a restart is kept and applies when the host starts again.',
  /** The accessible name of the form that holds every setting. */
  formLabel: 'Settings',
  saveAction: 'Save changes',
  discardAction: 'Discard changes',
  reloadAction: 'Reload settings',
  /** The words under a switch or a field whose key has no value, so the code default applies. */
  unset: 'Not set. The code default applies.',
  /** What a setting with no value reads, and the option of a select that chooses none. */
  notSet: 'Not set',
  /** The option of a select that chooses none, when the row the setting applies by is known: "Claude Haiku 5.5 (default)". */
  defaultOption: (name: string) => `${name} (default)`,
  /** Reveals the fields of a setting that has no value. */
  setAction: 'Set a value',
  /** Puts a setting whose fields were revealed back to having no value, before it is saved. */
  unsetAction: 'Not set',
  /** The label of the JSON editor under a switch whose options are free-form JSON. */
  optionsLabel: 'Options (JSON)',
  /** Only a setting that needs a restart says how it applies; a live one says nothing. */
  apply: { restart: 'Needs a restart' },
  /** The heading of the settings shortcuts in the `?` map. */
  shortcutGroup: 'Settings',
  /** What the Bureau refused about a value, when it names nothing. */
  invalidValue: 'This value is not one the setting takes.',
  /** The page-level summary of the settings that wait for the host to start again. */
  restartSummary: (keys: readonly string[]): string =>
    keys.length === 1
      ? `1 setting applies when the host starts again: ${keys.join(', ')}.`
      : `${String(keys.length)} settings apply when the host starts again: ${keys.join(', ')}.`,
  pendingRestart: 'Restart pending',
  locked: 'Locked',
  /** Why a locked key cannot be changed, by the reason the Bureau reports. */
  lockedNote: {
    deployment: 'The deployment sets this one, and it cannot be changed here.',
    'shared-storage':
      'Every host on this shared storage has to run the same value, so it is set by the deployment and cannot be changed here.',
  },
  notPersisted:
    'This server does not keep its settings. They go back to the code defaults when the host stops.',
  saved: {
    title: 'Settings saved',
    description: 'The changes apply live where a setting allows it.',
  },
  /** A save the Bureau refused because the settings changed since the page read them. */
  stale: {
    title: 'The settings changed since you loaded them',
    description:
      'Someone or something changed them after this page read them, so nothing was saved. Reload to see what they are now. Reloading discards your changes.',
  },
  /** The page found the settings changed while it held edits. */
  changedElsewhere: {
    title: 'The settings changed while you were editing',
    description:
      'Reload to see what they are now. Reloading discards your changes, and saving them first would overwrite the change.',
  },
  /**
   * The settings could not be read again while the page already holds them: the banner over the old
   * values (board PageSettingsSections, "Error, old data on screen"). Cinder's `refresh-failed`
   * preset writes the rest: when what is shown loaded, and the way to try again.
   */
  refreshFailed: { title: 'Couldn’t refresh these settings.' },
  saveFailed: 'The settings were not saved',
  forbidden: 'You may read the settings but not change them.',
  hostPaths: {
    title: 'Where the host keeps its files',
    description: 'These are set by the host and cannot be changed here.',
    agents: 'Agent files',
    workflows: 'Workflow files',
    configuration: 'Configuration file',
    providers: 'Provider key files',
    unavailable: 'The host did not say where it keeps its files.',
  },
  /** The words that differ when the host keeps its state in a bucket (`mode: 'remote'`). */
  remote: {
    hostPaths: {
      title: 'Where the host keeps its state',
      agents: 'Agents',
      workflows: 'Workflows',
      configuration: 'Configuration',
      providers: 'Provider key variables',
    },
  },
} as const;

/** The words of the quick settings popover in the top bar: personal preferences for this browser. */
export const QUICK_SETTINGS_COPY = {
  trigger: 'Quick settings',
  theme: 'Theme',
  /** The name of the theme switch's radiogroup (its positions are Light, System and Dark). */
  themeLabel: 'Color theme',
  sidebar: 'Sidebar',
  expanded: 'Expanded',
  collapsed: 'Collapsed',
  allSettings: 'All settings',
} as const;

/** Said where a write is confirmed when the storage cannot check that the value is unchanged. */
const UNCHECKED_WRITE_NOTE =
  ' This storage cannot check that the value is unchanged first, so it overwrites whatever the key holds now.';

/** The words the storage explorer (`/health/storage`) uses outside its view states. */
export const STORAGE_COPY = {
  title: 'Storage',
  description: 'The keys this installation stores, and the value of each.',
  /** The accessible name of the controls that narrow the table. */
  filtersLabel: 'Find a key',
  groupLabel: 'Group',
  allGroups: 'All groups',
  /** The accessible name of the segmented control that picks how keys are narrowed. */
  modeLabel: 'Search mode',
  modeStartsWith: 'Starts with',
  modeRange: 'Range',
  searchLabel: 'Keys starting with',
  searchPlaceholder: 'Keys starting with',
  /** The accessible name of the two fields of a range, and of each. */
  range: {
    label: 'Range',
    startLabel: 'Range start',
    endLabel: 'Range end',
    startPlaceholder: 'First key',
    endPlaceholder: 'Last key',
    /** The word between the two fields. */
    to: 'to',
    /** What a range whose last key sorts before its first says, under the fields. */
    reversed: 'The end comes before the start. Swap them, or pick a later end.',
    /** The note under a reversed range: the table still shows the last range that was a range. */
    lastResult: (count: number, start: string, end: string): string => {
      const keys = `${String(count)} ${count === 1 ? 'key' : 'keys'}`;
      if (start !== '' && end !== '')
        return `Showing the last result: ${keys} from ${start} to ${end}.`;
      if (start !== '') return `Showing the last result: ${keys} from ${start}.`;
      if (end !== '') return `Showing the last result: ${keys} up to ${end}.`;
      return `Showing the last result: ${keys}.`;
    },
  },
  /** The accessible name of the table of keys. */
  tableLabel: 'Keys',
  columns: {
    key: 'Key',
    group: 'Group',
    size: 'Size',
    /** The column of write times, which names the zone they are read in. */
    updated: (zone: string): string => `Updated (${zone})`,
  },
  /** A key that is in no group, because its name has no prefix. */
  noGroup: 'None',
  /** The Updated column of a key whose backend records no write time. */
  noUpdated: '—',
  /**
   * The table's footer: how many keys are loaded, of how many there are when storage can count them
   * (it cannot for a range), and what loads the rest.
   */
  footer: (loaded: number, total: number | undefined, more: boolean): string => {
    const count = (value: number): string => value.toLocaleString('en-US');
    const keys =
      total === undefined
        ? `Showing ${count(loaded)} ${loaded === 1 ? 'key' : 'keys'}.`
        : `Showing ${count(loaded)} of ${count(Math.max(total, loaded))} ${total === 1 ? 'key' : 'keys'}.`;
    return more ? `${keys} Scroll to load more.` : keys;
  },
  loadingLabel: 'Loading keys',
  /** What the table says after "Cancel" in the "Still loading" line: nothing failed, the person stopped it. */
  stopped: {
    title: 'Stopped loading keys',
    description:
      'You stopped the read, so the keys are not shown. Nothing stored was changed by it.',
    tryAgain: 'Try again',
  },
  /**
   * The footer after "Scroll to load more" failed: the keys already loaded stay, and Cinder's load
   * more says what failed and retries.
   */
  loadMore: {
    itemLabel: 'keys',
    retry: 'Load more',
  },
  empty: {
    title: 'No keys stored yet',
    description: 'Keys appear here once the application stores something.',
  },
  noMatches: {
    title: 'No keys match',
    description: 'No key starts with this text. Choose another group or clear the search.',
    clear: 'Clear filters',
  },
  /** A range in which no key falls. */
  noKeysInRange: {
    title: 'No keys in this range',
    description: 'Nothing is stored between these two keys. Change either end.',
  },
  failed: {
    title: 'The keys could not be read',
    description: 'The server did not answer. Check that the host is running, then try again.',
  },
  /** The marker on a key the application manages. */
  managedBadge: 'Managed',
  detail: {
    label: 'Selected key',
    emptyTitle: 'Select a key to see its value',
    emptyDescription:
      'Pick a row to read what is stored. Keys Interborough doesn’t manage can also be edited and deleted.',
    /** The accessible name of the region that holds the pane. */
    paneLabel: 'Key',
    /** The name of the menu at the end of the header row, which holds Delete. */
    moreActions: 'More actions',
    /** The pane's line while the key is being read: only what the row already says. */
    groupOnly: (group: string): string => group,
    /** The line over the key while its value is being edited after a failed save. */
    editingSummary: (group: string, size: string, key: string): string =>
      `${group}, ${size}, ${key}`,
    /** What the pane says while the value is read: nothing for the first 300 ms, then a skeleton. */
    valueLoadingLabel: 'Loading the value',
    /** What the pane says after "Cancel" in the "Still loading" line. */
    valueStopped: 'You stopped loading this value.',
    /** What the pane says when the value could not be read. */
    valueFailed: 'Couldn’t read the value.',
    valueRetry: 'Try again',
    /** What the pane says when the key was removed after the row was listed. */
    valueGone: 'This key is no longer stored. Another writer removed it.',
    /** The line over the key: its group, size and when it was written. */
    summary: (group: string, size: string, updated: string | null): string =>
      updated === null ? `${group}, ${size}` : `${group}, ${size}, updated ${updated}`,
    /** How long a very long key is, said after it. */
    characters: (count: number): string => `(${count.toLocaleString('en-US')} characters)`,
    copyKey: 'Copy key',
    copyValue: 'Copy value',
    edit: 'Edit',
    delete: 'Delete',
    save: 'Save value',
    cancel: 'Cancel',
    jsonSwitch: 'JSON',
    valueLabel: 'Value',
    editLabel: 'Value',
    /** The lock line of a managed key, around its prefix, which the pane sets in monospace. */
    locked: {
      before: 'Locked: Interborough manages keys that start with ',
      after: ' and needs them to recover runs.',
    },
    /** Why a key has no Edit or Delete, in one string: what a refused write says. */
    managedNote: (prefix: string): string =>
      `Locked: Interborough manages keys that start with ${prefix} and needs them to recover runs.`,
    /** Why no key has Edit or Delete while the managed prefixes are not known. */
    unknownManaged:
      'Locked: Interborough could not say which keys it manages, so no key can be edited or deleted here.',
    binaryNote: 'This value is not text, so it cannot be edited here.',
    notJson: 'The value was JSON and this is not, so it cannot be saved.',
    /**
     * The danger alert over the editor after a failed save: a bold lead, the cause, and what became
     * of the edit.
     */
    saveFailed: {
      lead: 'Couldn’t save the value.',
      noAnswer: 'Interborough didn’t answer.',
      kept: 'Your edit is still here.',
    },
    /**
     * The heading over a value shown as text, which says what it is and how big: "Value, text, 2.1 MB".
     */
    textValueLabel: (size: string): string => `Value, text, ${size}`,
    /**
     * The note under a value shown as text. Each part is said only when it is true: that only the
     * start is shown (and Copy value still copies it all), and why there is no Fields or JSON switch.
     */
    textNote: {
      shownStart: (shown: string, size: string): string =>
        `Showing the first ${shown}. Copy value copies all ${size}.`,
      notJson: 'This value isn’t JSON, so there is no Fields or JSON switch.',
      tooLarge: 'This value is too large for the Fields and JSON switch.',
    },
    /**
     * The warning over the editor when the key was written while it was open: a bold lead, then who
     * wrote it and when. The time is left out when the storage records none.
     */
    rewritten: {
      lead: 'This key changed while you were editing.',
      detail: (time: string | null): string =>
        time === null ? 'The app wrote a new value.' : `The app wrote a new value at ${time}.`,
      discard: 'Discard my edit',
      saveOver: 'Save over it…',
      showNew: 'Show new value',
    },
    capabilityUnknown:
      'The storage has not said whether it can check that a value is unchanged, so nothing was written. Try again in a moment.',
    changedUnderYou:
      'The value changed after it was opened, so nothing was written. Open the key again to see what it holds now.',
    deleteFailed: 'The key was not deleted.',
    saved: (key: string): string => `Saved ${key}`,
    deleted: (key: string): string => `Deleted ${key}`,
  },
  confirmSave: {
    title: 'Save this value?',
    description: (key: string, unchecked = false): string =>
      `This replaces the value of ${key}.${unchecked ? UNCHECKED_WRITE_NOTE : ''}`,
    confirm: 'Save',
  },
  /** The confirmation of Save over it, which replaces the value the application wrote while the editor was open. */
  confirmSaveOver: {
    title: 'Overwrite the app’s newer value?',
    description: (key: string, time: string | null, unchecked = false): string =>
      `${key} was written${time === null ? '' : ` at ${time}`} while you were editing. Saving replaces that value with yours. This can’t be undone.${unchecked ? UNCHECKED_WRITE_NOTE : ''}`,
    confirm: 'Save over it',
  },
  confirmDelete: {
    title: 'Delete this key?',
    /** The sentence after the key, which the dialog sets in monospace: its size and that it cannot be undone. */
    afterKey: (size: string, unchecked = false): string =>
      ` and its ${size} value are removed from storage. This can’t be undone.${unchecked ? UNCHECKED_WRITE_NOTE : ''}`,
    confirm: 'Delete key',
  },
  backend: {
    sqlite: 'SQLite',
    postgres: 'Postgres and S3',
    unknown: 'Storage',
    /** The storage line under the title: the backend, then where it is. */
    line: (backend: string, where: string | undefined): string =>
      where === undefined ? backend : `${backend}, ${where}`,
    popoverLabel: 'What the storage can do',
    popoverHint: 'Storage details',
  },
} as const;
