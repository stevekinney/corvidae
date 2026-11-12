import { nameList } from './shared.ts';

/** The words for a reasoning effort, from least to most: the agent editor, the agent page and Model policy say them alike. */
export const EFFORT_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Maximum',
} as const;

/** The words the agent editor uses outside its view states (`/agents/new`, `/agents/:agent/edit`). */
export const AGENT_EDITOR_COPY = {
  createHeading: 'New agent',
  /**
   * The New agent form (`/agents/new`, board PageAgentEditor): the line under the heading, the
   * identifier the name sets and the field that changes it, what a submit says at a field, the
   * tools table and its Asks selects, the question before leaving with unsaved changes, and what
   * the form says while a save is in flight, when it fails, and when it is not answered.
   */
  newAgent: {
    /** The line under the heading (row 41a). */
    subtitle:
      'An agent is a model with instructions and tools. Try it beside the form before you save.',
    /** The icon button beside the file path (row 41c), and what it says once it has copied. */
    copyFilePath: 'Copy the file path',
    copiedFilePath: 'File path copied',
    /** What follows the identifier while it follows the name (row 41e). */
    setFromName: ', set from the name',
    /** The link that turns the identifier into a field (rows 41e, 42x), and its accessible name. */
    changeIdentifier: 'Change',
    changeIdentifierLabel: 'Change the ID',
    /** The hint under the identifier field once it can be changed (row 42x). */
    identifierHint:
      'Lowercase letters, numbers and hyphens. It appears in URLs and wherever you type the agent’s name.',
    /** The action that puts the identifier back to the one the name sets (row 42x). */
    resetIdentifier: (identifier: string): string => `Reset to ${identifier}`,
    /** The message at Name after a submit with no name (row 42m). */
    nameRequired: 'Enter a name. It becomes the agent’s ID.',
    /** The message at Name when it holds no letter or digit an identifier could be made of. */
    nameNeedsLetters: 'Use letters or numbers in the name. It becomes the agent’s ID.',
    /** The message at Name when the identifier it sets is taken (rows 42n, 14u). */
    nameTaken: (name: string): string =>
      `An agent named ${name} already exists. Pick another name.`,
    /** The message at Model after a submit with no model, or one that cannot be saved (row 42m). */
    modelRequired: 'Choose a model so the agent can answer.',
    /** What leads the link to Settings › Models under the abilities (row 41h). */
    notListed: 'Not listed? Connect a provider in',
    /** The model field when the catalog did not load (row 42v): a failure, so a danger callout. */
    modelsFailed: {
      placeholder: 'No models to show',
      title: 'Couldn’t load models',
      description: 'The provider list didn’t load. You can keep editing.',
      retry: 'Try again',
    },
    /** The Tools section while the catalog has not loaded: its tools come with its models. */
    toolsWaitOnModels: 'The tools load with the models.',
    /** The counter at the right of the Instructions label (row 41i), as two words. */
    instructionsFormat: 'Markdown',
    wordCount: (count: number): string => (count === 1 ? '1 word' : `${String(count)} words`),
    /** The count beside the Tools title (row 41k), such as `3 of 9`. */
    toolCount: (chosen: number, offered: number): string =>
      `${String(chosen)} of ${String(offered)}`,
    /** The tools table (rows 41k, 41l): its caption and columns. */
    toolsCaption: 'The tools this agent may call',
    columns: { tool: 'Tool', risk: 'Risk', asks: 'Asks' },
    /** The accessible name of a row's Asks select. */
    asksLabel: (tool: string): string => `When ${tool} asks first`,
    /** An Asks option; the tool's own default says so (row 41l). */
    asksOption: (level: string, isDefault: boolean): string =>
      isDefault ? `${level} (default)` : level,
    /** The note under the tools table (row 41m). */
    asksNote:
      'Each Asks level starts at the tool’s default and is set here with one select per row while the agent is new; once it is saved, the Access tab owns the levels and every change there saves a version.',
    /** The sticky bar's status while a save is in flight (rows 43j, 14w). */
    saving: 'Saving…',
    /** The banner's text when the server failed a save (row 42w), or did not answer at all. */
    serverError: (status: number | undefined): string =>
      status === undefined
        ? 'Interborough didn’t answer. Nothing was changed. What you typed is still here.'
        : `The server answered with an error (${String(status)}). Nothing was changed. What you typed is still here.`,
    /** What the form says when a save has had no answer for 15 seconds (row 14x). */
    timedOut: 'Couldn’t confirm the save. Your changes are still here.',
    tryAgain: 'Try again',
    /** The question before leaving a form that differs from what was saved (rows 42o, 42p). */
    leave: {
      title: 'Leave without saving?',
      description: (changed: readonly string[]): string =>
        `This agent has changes that aren’t saved: ${nameList(changed)}. Leaving discards them.`,
      keep: 'Keep editing',
      discard: 'Discard and leave',
    },
  },
  /**
   * The Edit agent form (`/agents/:agent/edit`, board PageAgentEditor, rows 41q to 43k): the line
   * under the heading, the read-only lines that stand for what the Settings and Access tabs own (the
   * model, the tools, the guardrails and the spend limit), the reference documents, the block that
   * holds the delete, the sticky bar's saved status, and what the form says while the agent loads.
   * Every separator is a comma or a full stop, never a middle dot.
   */
  edit: {
    /** The line under the heading (row 41q). */
    subtitle:
      'Changes are saved as a new version. Running chats keep the version they started with.',
    /** The same line while a save is in flight, naming the version it makes (row 43k). */
    subtitleSaving: (revision: number): string =>
      `Changes are saved as a new version (Version ${String(revision)} once this finishes).`,
    /** The message at Name when a saved agent's name is emptied and Save is pressed (row 41s). */
    nameRequired: 'Enter a name.',
    /** The label before the saved identifier, which is shown small and monospaced (row 41s). */
    idLabel: 'ID',
    /** The sticky bar's status for the version the agent is at (row 41y). */
    saved: (revision: number): string => `Saved, Version ${String(revision)}`,
    /** What the form announces and the sticky summary reads while the agent loads (rows 43h, 43i). */
    loading: 'Loading agent',
    /**
     * The model of a saved agent (row 41u): read-only text, with where to change it. The model is
     * saved on the Settings tab, so a person who cannot save here because of it is sent there.
     */
    model: {
      /** The model's name and its provider's, as one line. */
      value: (model: string, provider: string): string => `${model}, ${provider}`,
      /** The note under the model: a link on "Settings tab" sits between these two halves. */
      changeLead: 'Change it on the ',
      settingsTab: 'Settings tab',
      changeTail: '; a saved agent’s model is saved there.',
      /** The notice when the agent's own model is only turned off: a save keeps it. */
      keptNotice: (model: string, reason: string): string =>
        `This agent’s model, ${model}, is not offered now. ${reason} Saving keeps it.`,
      /** The notice when the model policy forbids it: a save is refused and a run fails. */
      refusedNotice: (model: string, reason: string): string =>
        `This agent’s model, ${model}, is not offered now. ${reason} Saving is refused and a run fails until another model is chosen on the Settings tab.`,
      /** The notice when the model is retired or gone from the catalog: a save is refused. */
      replacementNotice: (model: string, reason: string): string =>
        `This agent’s model, ${model}, is not offered now. ${reason} Saving is refused until another model is chosen on the Settings tab.`,
    },
    /** The tools line (row 41v): the count, then a link on "Access tab" between these two halves. */
    tools: {
      count: (count: number): string => (count === 1 ? '1 tool.' : `${String(count)} tools.`),
      changeLead: 'Change on the ',
      accessTab: 'Access tab',
      changeTail: '.',
    },
    /** The guardrails and spend line (row 41w), then a link on "Access tab" and what a change there does. */
    guardrails: {
      summary: (guardrails: readonly string[], spendLimit: string | null): string =>
        `Guardrails: ${guardrails.length === 0 ? 'none' : guardrails.join(', ')}. Spend limit: ${spendLimit ?? 'none'}.`,
      /** Read-only money carries digit grouping ("$1,000,000"); an amount that is not a number reads as typed. */
      spendPerRun: (usd: string): string => {
        const amount = Number(usd);
        const text = Number.isFinite(amount)
          ? amount.toLocaleString('en-US', { maximumFractionDigits: 6 })
          : usd;
        return `$${text} per run`;
      },
      changeLead: 'Change on the ',
      accessTab: 'Access tab',
      changeTail: '. Changes there save a version on their own.',
    },
    /** The reference documents the file reads (row 41t); each can be removed with the next save. */
    references: {
      heading: 'Reference documents',
      note: 'Read with every chat',
      none: 'No reference documents',
      removeLabel: (path: string): string => `Remove ${path}`,
    },
    /** The demoted block at the foot of the form that holds the delete (row 41x). */
    deleteBlock: {
      title: 'Delete this agent',
      description: (name: string): string =>
        `${name} is an agent you created, so it can be deleted. Chats that already happened keep the version they used.`,
    },
  },
  /** The name a copy of an agent starts with. */
  copyName: (name: string): string => `${name} copy`,
  /** Duplicate (`/agents/new?from=`): what the page says about the agent it copies. */
  copy: {
    /** The line under the heading of a form filled from another agent. */
    from: (agent: string): string =>
      `Copied from ${agent}. Nothing is saved until you create the agent: name it, change what you like, then create it.`,
    /** What the page says when the agent to copy cannot be read, or has nothing to copy. */
    sourceFailed: {
      title: 'This agent could not be copied',
      description:
        'The agent could not be read, or it has no usable definition. Check that it exists and its file is valid, then try again.',
    },
    /** The tools of the original the catalog does not offer, so the copy leaves them out. */
    droppedTools: (tools: readonly string[]): string =>
      `${tools.length === 1 ? 'This tool is' : 'These tools are'} not offered by this installation, so the copy leaves ${tools.length === 1 ? 'it' : 'them'} out: ${tools.join(', ')}.`,
  },
  /**
   * Try it (COR-1911): a throwaway chat with the definition as it stands in the form, saved or
   * not. It writes no file and no memory, and ends when the drawer closes or the page is left.
   */
  try: {
    /** The header button that opens Try it below 1024px (rows 43t, 44a). */
    action: 'Try it',
    /** The title of the panel beside the form, and of the sheet (rows 41n, 43x). */
    title: 'Try it',
    /** Said when the agent names reference documents, which a trial runs without. */
    leftOut: (documents: readonly string[]): string =>
      `This agent reads ${documents.length === 1 ? 'a document' : 'documents'} that ${documents.length === 1 ? 'is' : 'are'} not available in a trial, so the trial runs without ${documents.length === 1 ? 'it' : 'them'}: ${documents.join(', ')}.`,
    /** The line under the title: what the trial runs on. */
    usesChanges: 'Uses your unsaved changes',
    /** Said beside `usesChanges` once the host reports a model provider with a key (rows 43g, 43x). */
    providerConnected: 'Provider connected',
    /** The line above an approval the test run is parked on (row 43d). */
    waitingOn: (tool: string): string => `Waiting on you for ${tool}`,
    /** The context line of an approval inside Try it: answering it runs the tool for real (row 43e). */
    testChat: 'Test chat, this runs for real',
    /** The accessible name of the sheet's Close control, which keeps the transcript (rows 43x, 43z). */
    closeSheet: 'Close',
    /** The page's subtitle on a tablet, where Try it opens from the header (row 44a). */
    subtitleTablet: 'An agent is a model with instructions and tools. Try it before you save.',
    /** The page's subtitle on a phone (row 43u). */
    subtitlePhone: 'An agent is a model with instructions and tools.',
    /** The new agent form's sticky status while nothing is saved yet (rows 43w, 44b). */
    notSavedYet: 'Not saved yet',
    messagePlaceholder: 'Send a test message',
    /** The line under the composer, said while no other status is. */
    hint: 'Tools run for real, under this agent’s approval rules. Test chats aren’t saved and leave no memories.',
    chatLabel: 'Trial chat',
    /** Ends the chat and starts a fresh one with the form as it is now. */
    startOver: 'Reset',
    /** The title of a test answer that failed, and what it adds to the reason: the trial saves nothing. */
    failureTitle: 'Couldn’t get an answer',
    nothingSaved: 'Nothing was saved.',
    tryAgain: 'Try again',
    /** The name of a tool call that is running, "Using Lookup order…", and one that finished. */
    usingTool: 'Using',
    usedTool: 'Used',
    /** Said when the form has changed since the trial chat started. */
    changed: 'The form changed after this chat started, so the agent here is the earlier version.',
    notRemoved: 'The trial chat could not be removed. It is left out of your chat list.',
    forbidden: 'This installation does not let you try agents.',
    failed: 'The agent could not be tried',
  },
  editHeading: (name: string): string => `Edit ${name}`,
  /** The accessible name of the form. */
  formLabel: 'Agent definition',
  /** The label before the agent's file path. */
  fileLabel: 'File',
  /**
   * The words that differ when the host keeps its state in a bucket (`mode: 'remote'` from
   * `/host/paths`). An agent is an object there, so it is not "a file". Everything not named here
   * is the same in both modes.
   */
  remote: {
    fileLabel: 'Stored in',
    noProvider: {
      description:
        'An agent needs a model to answer. This installation keeps its provider keys in its deployment, so connect one there, then check again.',
      configurationStep:
        'Put this in configuration.json in the bucket. If it exists, add the provider’s plugin to its plugins.',
      secretStep:
        'Set the provider’s API key in the environment variable shown, then restart the host.',
    },
  },
  /** The directory under the state directory that holds agent files, when the host does not say where. */
  fallbackDirectory: 'agents',
  /** The titles of the form's four sections. */
  sections: {
    identity: 'Identity',
    model: 'Model',
    instructions: 'Instructions',
    tools: 'Tools',
    limits: 'Guardrails and limits',
  },
  limits: {
    description:
      'What keeps a run in bounds. Leave a spend or tool field empty for no limit; the agent page shows what is set.',
    guardrailsLabel: 'Guardrails',
    guardrailsDescription:
      'Plugin guardrails the agent runs besides the default ones, as plugin:name, one per line.',
    stepLimitLabel: 'Steps per run',
    stepLimitDescription: 'The most steps one run may take. Empty uses the default of 25.',
    spendPerRunLabel: 'Spend per run (USD)',
    spendPerRunDescription: 'A run that reaches this stops.',
    spendPerChatLabel: 'Spend per chat (USD)',
    spendPerChatDescription: 'All the runs of one chat together. Needs a limit per run.',
    toolCallsLabel: 'Tool calls per run',
    toolCallsDescription: 'The most tool calls one run may make.',
    toolSecondsLabel: 'Tool time per run (seconds)',
    toolSecondsDescription: 'How long a run may keep calling tools, counted from its start.',
    errors: {
      guardrails: 'Write each guardrail as plugin:name, one per line.',
      stepLimit: (maximum: number): string => `Use a whole number from 1 to ${String(maximum)}.`,
      spend: (maximum: number): string => `Use an amount above 0, up to ${String(maximum)}.`,
      chatNeedsRun: 'Set a limit per run first: a chat limit sits on top of it.',
      toolCalls: (maximum: number): string => `Use a whole number from 1 to ${String(maximum)}.`,
      toolSeconds: (maximum: number): string =>
        `Use a number of seconds above 0, up to ${String(maximum)}.`,
    },
  },
  /** The keyboard shortcut's group in the `?` map. */
  shortcutGroup: 'Agent editor',
  nameLabel: 'Name',
  nameDescription: 'What people see.',
  identifierLabel: 'Identifier',
  identifierCreateDescription: 'The file name, without .md. Fixed once saved.',
  /** What an identifier that is not a file name gets at its field on submit (row 42y). */
  identifierInvalid: 'Use lowercase letters, numbers and hyphens, for example order-helper.',
  /** `new` is the address of the page that creates an agent, so an agent called `new` could never be opened. */
  identifierReserved:
    'This identifier is reserved: /agents/new is the page that creates an agent, so an agent called new could never be opened. Choose another.',
  /**
   * What a typed identifier the Bureau refused gets at its field (row 42y), whether a file or an
   * agent defined in code holds it. An identifier the name set says so at the name instead
   * (`newAgent.nameTaken`).
   */
  identifierTaken: (identifier: string): string =>
    `An agent with the ID ${identifier} already exists. Pick another ID.`,
  descriptionLabel: 'Description',
  /** The helper under Description (row 41f). */
  descriptionDescription: 'Shown in the agent list and when picking an agent.',
  modelLabel: 'Model',
  modelDescription: 'The models this installation offers.',
  modelPlaceholder: 'Choose a model',
  /**
   * The model field's words (`agent-editor-model-field.svelte`): models grouped by provider, a
   * provider with no key disabled and pointing to Settings › Models, a model that is not offered
   * disabled with its reason, and the abilities of the chosen one.
   */
  model: {
    /** The option that stands for a provider with no key. */
    notConnected: (provider: string): string => `${provider} is not connected`,
    notConnectedDescription: 'Connect it in Settings › Models to use its models.',
    /** What precedes the link to Settings › Models when a provider is not connected. */
    unconnectedLead: (providers: readonly string[]): string => {
      const names = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' }).format(
        providers,
      );
      return providers.length === 1
        ? `${names} is not connected. Connect it in`
        : `${names} are not connected. Connect them in`;
    },
    settingsLink: 'Settings › Models',
    /** Why a model is listed and cannot be chosen. */
    reasons: {
      'provider-denied': 'The model policy does not allow this provider.',
      'model-denied': 'The model policy does not allow this model.',
      'turned-off': 'Turned off in Settings › Models.',
      retired: 'Retired by its provider.',
      'not-in-catalog': 'This installation no longer offers this model.',
    },
    abilitiesLabel: 'Abilities of the chosen model',
    abilities: {
      tools: 'Tools',
      images: 'Images',
      structuredOutput: 'Structured output',
      streaming: 'Streaming',
    },
    textOnly: 'Text only',
    context: (size: string): string => `${size} context window`,
    maxOutput: (size: string): string => `${size} largest answer`,
  },
  /**
   * The default effort field (`agent-editor-effort-field.svelte`): the reasoning effort a chat of
   * the agent starts at, limited to what the chosen model supports.
   */
  effort: {
    label: 'Default effort',
    description:
      'How hard a chat of this agent thinks until the person changes it in the chat. None leaves the provider’s own default.',
    /** The option that leaves the file without an effort. */
    none: 'None',
    /** The select's note for a model that has no effort control. */
    notSupportedByModel: 'This model does not support a default effort.',
    /** What the field says when a change of model dropped an effort the new model cannot do. */
    cleared: (effort: string, model: string): string =>
      `${effort} effort is not supported by ${model}, so the default effort was cleared. Choose another, or leave it as None.`,
    /** Why the effort the file holds cannot be saved with the file's own model. */
    unsupported: (effort: string, model: string): string =>
      `${model} does not support ${effort} effort. Choose another effort or None, or choose another model.`,
  },
  /**
   * What the page shows instead of the form when the catalog holds no model: an agent cannot be
   * saved without one, and nothing in the application can add a provider.
   */
  noProvider: {
    title: 'No model provider yet',
    /** What the card says under its title (row 42b). */
    description:
      'An agent needs a model to answer. Connect a provider in Settings › Models; you return to this form afterwards.',
    /** The line under Connect a provider (row 42b). */
    blocked: 'Nothing else on this form works until then.',
    configurationStep:
      'Put this in the configuration file. If the file exists, add the provider’s plugin to its plugins.',
    secretStep: 'Save the provider’s API key in its own file, readable only by you (chmod 600).',
    restartStep: 'Restart the host, then check again.',
    reload: 'Check again',
    snippetLabel: 'Provider configuration',
    /** The action that opens Settings › Models, which returns to the form once a provider is connected. */
    connectAction: 'Connect a provider',
    /** What leads the steps for a person who would rather edit the files. */
    byHand: 'Or set it up by hand:',
  },
  noTools: 'This installation offers no tools.',
  /** What the list says when the agent has no tool yet. */
  noToolsChosen: 'No tools chosen. The agent can reply, but it cannot call anything.',
  /** The action that opens the picker. */
  addToolsAction: 'Add tools',
  /** The marker on a tool that asks before it runs, and on one that never runs. */
  toolStanding: {
    'asks-first': 'Asks first',
    blocked: 'Blocked',
  },
  /** The tool picker (`Add tools`): a search over every tool the installation offers, grouped by source. */
  toolPicker: {
    title: 'Add tools',
    done: 'Done',
    searchLabel: 'Search tools',
    searchPlaceholder: 'Search by name, description or source',
    /** Announced as the search narrows. */
    resultCount: (count: number): string => (count === 1 ? '1 tool' : `${String(count)} tools`),
    noMatchesTitle: 'No tools match',
    noMatchesDescription: (search: string): string =>
      `Nothing is named or described like “${search}”.`,
    /** The count in a group's heading, such as `2 of 5`. */
    groupCount: (chosen: number, total: number): string => `${String(chosen)} of ${String(total)}`,
    /** The heading of a saved tool source's group; the source is the identifier its tool names start with. */
    savedSource: (source: string): string => source,
  },
  /** The disclosure on a tool row that shows the full text the model is told about the tool. */
  toolDisclosure: 'What the agent is told',
  instructionsLabel: 'Instructions',
  instructionsDescription: 'What the agent should do. This is the body of its file.',
  a2aLabel: 'Available over A2A',
  a2aDescription:
    'Lets other agents and A2A clients find and call this agent. Chats with it work either way.',
  /** The action on the agent list that opens the form for a new agent. */
  newAction: 'New agent',
  /** The action on an agent's page that opens its editor. */
  editAction: 'Edit',
  /** The badge on an agent file the Bureau cannot use, in the agent list. */
  invalidBadge: 'Invalid file',
  forbidden: 'This installation does not let you change agents.',
  /** Save on the New agent form (row 42n): the sticky bar reads Cancel, then Save. */
  createAction: 'Save',
  saveAction: 'Save changes',
  cancelAction: 'Cancel',
  deleteAction: 'Delete agent',
  deleteDialog: {
    title: 'Delete this agent?',
    description: (name: string): string =>
      `This removes the file for ${name}. Runs that already happened keep the version they used.`,
    confirm: 'Delete agent',
  },
  /** The title of the banner above the form when a save failed (row 42w). */
  saveFailed: 'Couldn’t save the agent',
  deleteFailed: 'The agent was not deleted',
  stale: {
    title: 'This agent changed outside Interborough',
    description:
      'Its file was edited or replaced after this page loaded, so nothing was saved or deleted. Reloading shows what is on disk and discards your unsaved edits.',
    action: 'Reload from disk',
  },
  invalid: {
    title: 'This agent’s file is invalid',
    description: 'Interborough cannot run it until the file is fixed. Edit the file, then reload.',
    action: 'Reload from disk',
    fileLabel: 'File',
  },
  loadFailed: {
    title: 'The agent could not be loaded',
    description: 'The server did not answer. Check that the host is running, then try again.',
  },
  revisions: {
    heading: 'Revision history',
    description: 'The versions of this agent that have run, most recently run first.',
    caption: 'Versions of this agent that have run',
    versionColumn: 'Version',
    lastRunColumn: 'Last run',
    emptyTitle: 'No version has run yet',
    empty: 'A version appears here once the agent runs on it.',
    failedTitle: 'The revision history could not be loaded',
  },
} as const;

/**
 * The words the agent list and an agent's page use for what an agent is and has: its model, its
 * tools, and how much it has been used. Where an agent is defined is a fact for the developer, so
 * it is not worded.
 */
export const AGENTS_COPY = {
  modelLabel: 'Model',
  toolsLabel: 'Tools',
  skillsLabel: 'Skills',
  noTools: 'No tools',
  toolCount: (count: number): string => (count === 1 ? '1 tool' : `${count} tools`),
  chatCount: (count: number): string => (count === 1 ? '1 chat' : `${count} chats`),
  noChats: 'No chats yet',
  /** The line under the heading of the list (rows 12d and 36r). */
  subtitle: 'Agents run your chats, goals and schedules.',
  filtersLabel: 'Filter agents',
  searchLabel: 'Search agents',
  searchPlaceholder: 'Search agents',
  clearAction: 'Clear filters',
  /** The segments of the list: every agent, and the ones that can run (row 11c). */
  segments: { all: 'All', available: 'Available' },
  /** The card of the agents that can run, and the card of the ones a disabled plugin holds back (rows 36d and 36j). */
  groups: {
    availableCount: (count: number): string => `Available ${String(count)}`,
    sortedBy: 'Sorted by last activity',
    unavailableCount: (count: number): string => `Unavailable ${String(count)}`,
    /** Why the agents of the second card cannot run, and what brings them back. */
    held: (plugins: readonly string[], agents: number): string =>
      `${agents === 1 ? 'Its plugin' : plugins.length === 1 ? 'Their plugin' : 'Their plugins'}, ${nameList(plugins)}, ${plugins.length === 1 ? 'is' : 'are'} disabled. ${agents === 1 ? 'Chats with this agent are' : 'Chats with these agents are'} read-only until you enable ${plugins.length === 1 ? 'it' : 'them'} and restart.`,
    availableLabel: 'Available agents',
    unavailableLabel: 'Unavailable agents',
  },
  /** A row of the list (rows 36f to 36k, 37d and 37f). */
  row: {
    /** The words after the chat count of an agent the host ships itself (row 36g). */
    builtIn: 'Built in',
    noActivity: 'No activity yet',
    yesterday: 'Yesterday',
    /** In the action slot of an agent a disabled plugin holds back, when the host gives no reason. */
    pluginDisabled: (plugin: string): string => `Plugin ${plugin} is disabled`,
    memoryOf: (agent: string): string => `Memory of ${agent}`,
    newChatWith: (agent: string): string => `New chat with ${agent}`,
    editAgent: (agent: string): string => `Edit ${agent}`,
    /** Why New chat is held while no provider can answer (row 11e). */
    connectToChat: 'Connect a provider to start a chat',
  },
  /** Nothing has been created, and no plugin holds any agent back (row 36m). */
  empty: {
    title: 'No agents yet',
    description: 'An agent is a model with instructions and tools. Create one to chat with it.',
    addPlugin: 'Add a plugin',
  },
  /** Every agent is held back by a disabled plugin (row 36o). */
  onlyUnavailable: {
    title: 'No agent can run yet',
    description: (agents: readonly string[], plugins: readonly string[]): string =>
      `${nameList(agents)} ${agents.length === 1 ? 'is' : 'are'} held back while ${nameList(plugins)} ${plugins.length === 1 ? 'is' : 'are'} disabled.`,
  },
  /** Only the host's own agents exist (row 12c): a compact line beneath them. */
  noneOfYours: {
    title: 'No agents of your own yet',
    description: 'Built-in agents are ready; add your own for work they don’t cover.',
  },
  noMatch: {
    title: 'No agent matches this search',
    description: 'Change the search to see more agents.',
  },
  loading: 'Loading agents',
  stillLoading: 'Still loading agents. This is taking longer than usual.',
  /** The accessible name of the list of agent files the Bureau cannot use. */
  invalidListLabel: 'Agent files with a problem',
  /** The Memory tab with the agent's memory count; `more` is true when pages of it are unread. */
  memoryWithCount: (shown: number, more: boolean): string => `Memory ${shown}${more ? '+' : ''}`,
  fileVersion: 'File version',
  history: 'History',
  /**
   * Enabling the plugin behind the unavailable agents, from the list (rows 36x, 36y, 37g and 37h):
   * the question Settings › Plugins asks, with the effect on running work in an inset note.
   */
  enable: {
    action: 'Enable and restart',
    title: (plugins: readonly string[]): string => `Enable ${nameList(plugins)} and restart?`,
    description: (plugins: readonly string[], agents: readonly string[]): string =>
      `Plugins load at startup, so Interborough restarts to load ${nameList(plugins)}.${agents.length === 0 ? '' : ` ${nameList(agents)} ${agents.length === 1 ? 'becomes' : 'become'} available afterwards.`}`,
    /** The runs going now, said first when there are any; the note never says that nothing is running. */
    running: (runs: number): string =>
      runs === 1 ? '1 run is running now.' : `${String(runs)} runs are running now.`,
    /** What a restart does to work in flight: running work resumes and reviews keep waiting. */
    work: (waiting: number): string =>
      `Running work picks up where it stopped; reviews stay waiting${waiting === 0 ? '' : ` (${String(waiting)} ${waiting === 1 ? 'is' : 'are'} waiting on you)`}. Interborough reconnects on its own when it is back.`,
    confirm: 'Enable and restart',
    /** The bold lead of the failure callout, and what it says when nothing was restarted. */
    failedTitle: (plugin: string): string => `Couldn’t enable ${plugin}.`,
    failedReason: (reason: string): string =>
      `${reason.endsWith('.') ? reason : `${reason}.`} Nothing was restarted and nothing changed.`,
    unknownReason: 'The host did not accept the change.',
    /**
     * The lead of the banner when the switch was saved and the host would not restart: the reason
     * after it is `RESTART_COPY.refusal`, which says to restart it where it runs.
     */
    notRestartedTitle: (plugins: readonly string[]): string =>
      `${nameList(plugins)} ${plugins.length === 1 ? 'is' : 'are'} switched on, but Interborough has not restarted.`,
    openPlugins: 'Open Plugins',
    /** The success banner after the host is back; Settings › Plugins draws the steps of the restart (row 37a). */
    back: (plugins: readonly string[], agents: readonly string[]): string =>
      `${nameList(plugins)} ${plugins.length === 1 ? 'is' : 'are'} on.${agents.length === 0 ? '' : ` ${nameList(agents)} ${agents.length === 1 ? 'is' : 'are'} available again.`}`,
  },
} as const;

/** Words joined as a sentence says them, the last pair with "and" and no comma before it: "A, B and C". */
function joinedWithAnd(words: readonly string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words.at(-1) ?? ''}`;
}

/** The words of an agent's page: its tabs, the controls over its chats, its instructions and its settings. */
export const AGENT_PAGE_COPY = {
  tabsLabel: 'Sections of this agent',
  /** Each tab's name, in the tab bar, in the narrow form's select and as the last breadcrumb. */
  tabs: {
    chats: 'Chats',
    instructions: 'Instructions',
    access: 'Access',
    hooks: 'Hooks',
    memory: 'Memory',
    settings: 'Settings',
  },
  /**
   * The header every tab shares (board PageAgent, rows 38a to 38c): the status line under the
   * description, which names what the agent's chats are doing and then how many there are, and the
   * reason an agent that needs a model cannot answer while no provider is connected.
   */
  header: {
    waiting: 'Waiting on you',
    running: 'Running',
    unavailable: 'Unavailable',
    noChats: 'No chats yet',
    /** The status word, then the chat count: "Waiting on you, 3 chats". */
    status: (state: string, chats: string): string => `${state}, ${chats}`,
    needsProvider: 'Can’t answer until a provider is connected,',
    connectProvider: 'Connect a provider',
  },
  /**
   * What a tab body shows when it has nothing to show yet or its read failed (board PageAgent,
   * "Loading" and "Error" frames, rows 39e to 39g). The header and the tab bar stay as they are.
   */
  tabState: {
    loading: (tab: string): string => `Loading ${tab}`,
    stillLoading: 'Still loading this tab. This is taking longer than usual.',
    failedTitle: 'Couldn’t load this tab',
    failedDescription: (status: number | undefined): string =>
      status === undefined
        ? 'The server didn’t answer. Nothing you did caused it.'
        : `The server answered with an error (${String(status)}). Nothing you did caused it.`,
    /** The tab still shows what it last loaded, and the banner over it says when that was. */
    staleTitle: 'Couldn’t refresh this tab.',
    staleSubject: 'this tab',
  },
  /**
   * An agent whose plugin is disabled (board PageAgent, "Agent from a disabled plugin", rows 39c and
   * 39d): it can be read and duplicated, and the banner over each tab says why it cannot run.
   */
  unavailable: {
    title: (agent: string): string => `${agent} isn’t available`,
    description: (plugin: string): string =>
      `Its plugin, ${plugin}, is disabled. Chats stay readable; sending, approving and running need the agent.`,
    enable: 'Enable and restart',
    /** Why New chat is held: the reason its tooltip gives. */
    newChatReason: (plugin: string): string => `Enable ${plugin} to start a chat`,
  },
  /**
   * The Chats tab (board PageAgent, rows 38e to 38g and 39p): one filter row of the state segments
   * with their counts, a search, Started by and Sort by, over the chats under day bands. Sort by
   * reads "Newest first" while it is clear: the chats by their last activity.
   */
  chats: {
    filtersLabel: 'Filter this agent’s chats',
    stateLabel: 'Status',
    states: { all: 'All', 'needs-you': 'Waiting on you', running: 'Running' },
    searchLabel: 'Search chats by title',
    searchPlaceholder: 'Search chats',
    startedByLabel: 'Started by',
    startedByAnyone: 'Anyone',
    startedBy: { chat: 'You', schedule: 'A schedule', goal: 'A goal' },
    sortLabel: 'Sort by',
    sortDefault: 'Newest first',
    sorts: { newest: 'Newest started', oldest: 'Oldest first' },
    emptyTitle: 'No chats yet',
    emptyDescription: (agent: string): string => `Chats with ${agent} appear here, newest first.`,
    /** The empty state of an agent whose plugin is disabled: no chat can start, so it names the way back. */
    unavailableDescription: (plugin: string): string => `Enable ${plugin} to start a chat.`,
    filteredTitle: 'No chats match',
    filteredDescription: 'None of this agent’s chats match these filters.',
    clearFilters: 'Clear filters',
  },
  /**
   * Duplicate on an agent defined in code or kept in a file: opens the form for a new agent filled
   * from it. The copy is named there, so nothing exists until it is created.
   */
  duplicate: 'Duplicate',
  /** A plugin's agent: read-only, with Duplicate to make a copy the owner can edit (COR-1873). */
  plugin: {
    duplicate: 'Duplicate',
    note: (plugin: string): string =>
      `The ${plugin} plugin ships this agent, so it is read-only. Duplicate it to make a copy you can edit.`,
    exists: (name: string): string =>
      `You already have an agent named ${name}. Open it, or rename or delete it to duplicate this one again.`,
    notLoaded: 'This agent is not loaded now, so it cannot be duplicated.',
    forbidden: 'You may not add agents.',
    failed: 'The agent could not be duplicated.',
  },
  /**
   * The Instructions tab (board PageAgent, rows 38i, 38j and 39r): the version line, the agent
   * file's body as a document, and the reference documents it reads, which are changed in the
   * editor, so the tab only lists them.
   */
  instructions: {
    heading: 'Instructions',
    builtIn: 'This agent is built in, so its instructions cannot be edited here.',
    emptyTitle: 'No instructions',
    emptyDescription: 'This agent has no instructions of its own.',
    emptyAction: 'Add instructions',
    /** The line over the document: "Version 4, saved Oct 29 by you". A save made by editing the file has no person to name. */
    version: (revision: number, saved: string, byYou: boolean): string =>
      `Version ${String(revision)}, saved ${saved}${byYou ? ' by you' : ' in the file'}`,
    referencesHeading: 'Reference documents',
    referencesDescription: 'Read with every chat',
    referencesNote:
      'Documents are added and removed in the editor, so each change becomes a version.',
    editAgent: 'Edit agent',
    /** The one muted line of an agent that reads no document: the editor, its one link, between the two halves. */
    noReferencesBefore: 'None added. Add one in ',
    noReferencesEditor: 'the editor',
    noReferencesAfter: '.',
    /** The same line for a plugin's agent, whose file the page cannot change, so it links nowhere. */
    noReferencesReadOnly: 'None added.',
  },
  /**
   * The Access tab (board PageAgent, rows 38l to 40c; board ResponsiveAndDark, rows 07a and 07b): a
   * toolbar with a search, a segment per source and the one allowed count, the tools in collapsible
   * groups with a leading allow box and an Asks select on each row, the skills, then Guardrails and
   * spend. Each change saves at once as a new version, and each row says when its own save is in
   * flight or failed.
   */
  access: {
    heading: 'Access',
    builtIn: 'This agent is built in, so its access cannot be changed here.',
    loadFailed: 'The access settings could not be loaded.',
    invalid: 'This agent’s file has a problem, so its access cannot be changed until it is fixed.',
    forbidden: 'You may not change this agent.',
    /** The toolbar over the table (row 38l): the search, the source segments, and the allowed count. */
    toolbarLabel: 'Filter tools',
    searchLabel: 'Search tools by name',
    searchPlaceholder: 'Search tools',
    sourceLabel: 'Source',
    all: 'All',
    /** The one allowed count, at the right of the toolbar: "3 of 9 allowed". */
    toolCount: (allowed: number, total: number): string =>
      `${String(allowed)} of ${String(total)} allowed`,
    /** Beside the count once a change saved, and the toast that says the same (row 39h). */
    saved: (revision: number | null): string =>
      revision === null ? 'Saved' : `Saved as Version ${String(revision)}`,
    viewVersions: 'View versions',
    /** What the offline banner names as the data it still shows (row 40b). */
    offlineSubject: 'Access',
    tableCaption: 'The tools this agent may call, and when each asks first',
    /** The table's columns (row 38m); the first holds each row's allow box. */
    columns: {
      allow: 'Allowed',
      tool: 'Tool',
      does: 'What it does',
      risk: 'Risk',
      asks: 'Asks',
    },
    /** The accessible name of a row's allow box. */
    allowLabel: (tool: string): string => `Allow ${tool}`,
    /** The accessible name of a row's Asks select. */
    asksFirstLabel: (tool: string): string => `When ${tool} asks first`,
    approvals: {
      never: 'Never',
      'on-changes': 'On changes',
      always: 'Always',
      blocked: 'Blocked',
    },
    /** An Asks option; the tool's own default says so (row 38p). */
    asksOption: (level: string, isDefault: boolean): string =>
      isDefault ? `${level} (default)` : level,
    /** Under `never`, for a tool that declares no tier: Armorer still asks about a call it cannot classify. */
    neverUnclassifiedHint:
      'This tool declares no tier, so it still asks before every call, even here.',
    /** A group's header after its source: how many of its tools are allowed (row 38m). */
    groupCount: (allowed: number, total: number): string =>
      `${String(allowed)} of ${String(total)} tools allowed`,
    /** The group of tools the file lists that the host no longer offers. */
    notInCatalogGroup: 'No longer offered',
    notInCatalog: 'Not offered by this host any more',
    noToolsTitle: 'This host offers no tools',
    noToolsDescription: 'Tools come from the host’s plugins and saved tool sources.',
    noMatchTitle: 'No tools match',
    noMatchDescription: 'No tool’s name matches this search in this source.',
    clearSearch: 'Clear search',
    /** A row's own state while its change is saved (row 39j). */
    saving: 'Saving…',
    /** The line under a row whose save failed (row 39k), before its Try again link. */
    failed: (subject: string, restored: string): string =>
      `Couldn’t save ${subject}. It went back to ${restored}.`,
    retry: 'Try again',
    /** What a failed allow box or guardrail box went back to. */
    restoredAllowed: 'allowed',
    restoredNotAllowed: 'not allowed',
    restoredOn: 'on',
    restoredOff: 'off',
    /** The Skills group (row 38q): its title and the note after it; skills are not counted with the tools. */
    skillsTitle: (count: number): string => (count === 1 ? '1 skill' : `${String(count)} skills`),
    skillsNote: 'They follow the tools they use.',
    skillWord: 'Skill',
    /** The Risk cell of a skill: it has no risk of its own. */
    skillRisk: '—',
    skillAsks: 'Follows its tools',
    /** A skill the agent's file defines itself (sweep S65), listed above the host's. */
    definedInFile: 'Defined in this file',
    grantLabel: (skill: string): string => `Grant ${skill}`,
    skillsLoadFailed: 'The skills could not be loaded.',
    /** The section under the table (row 38r). */
    guardrailsHeading: 'Guardrails and spend',
    guardrailsLabel: 'Guardrails',
    guardrailsNote: 'Guardrails come from enabled plugins. The default ones always run.',
    noGuardrails: 'No enabled plugin offers a guardrail.',
    guardrailsLoadFailed: 'The guardrails could not be loaded.',
    /** A guardrail the file lists that no enabled plugin offers now. */
    guardrailMissing: 'Not offered by an enabled plugin',
    spendLabel: 'Spend limit per chat',
    spendPlaceholder: 'No limit',
    spendUnit: 'USD',
    spendNote: 'Stops and asks when reached.',
    /** What a failed spend limit is called, and what it went back to when it had none. */
    spendSubject: 'the spend limit',
    noLimit: 'No limit',
  },
  settings: {
    heading: 'Settings',
    modelLabel: 'Model',
    /** The model a chat starts on and its provider, as the Model section names them (row 38u). */
    modelLine: (model: string, provider: string): string => `${model}, ${provider}`,
    /** The models a chat may change to (row 38v). */
    modelsLabel: 'Can switch to',
    modelsNote: 'Models a chat may change to.',
    addModel: 'Add a model',
    removeModel: (model: string): string => `Remove ${model}`,
    /** The provider of the agent's model holds no key (row 38u). */
    noProvider: {
      title: (provider: string): string => `${provider} isn’t connected`,
      description: (agent: string): string =>
        `${agent} can’t answer until a provider is connected. Connect one in Settings › Models.`,
      action: 'Connect a provider',
    },
    effortLabel: 'Effort',
    stepLimitLabel: 'Step limit',
    stepLimitNote: 'Most steps one run may take.',
    /** What an empty Step limit runs at: Operative's default. */
    stepLimitPlaceholder: (steps: number): string => `${String(steps)} (default)`,
    /** What a Step limit that is not a whole number from 1 to the bound says at the field (row 39s). */
    stepLimitError: (maximum: number): string =>
      `Enter a whole number from 1 to ${String(maximum)}. A run stops after this many steps.`,
    /** The step limit of an agent whose file sets none: Operative's default applies. */
    stepLimitDefault: (steps: number): string => `Default (${String(steps)} steps)`,
    defaultEffortLabel: 'Default effort',
    none: 'No limit',
    notSet: 'Not set',
    builtIn: 'This agent is built in, so its settings cannot be changed here.',
    /** The form's actions and what a save makes (row 38w). */
    save: 'Save changes',
    discard: 'Discard',
    saveNote: (next: number | null): string =>
      next === null ? 'Saving makes a new version.' : `Saving makes Version ${String(next)}.`,
    saved: (revision: number | null): string =>
      revision === null ? 'Saved' : `Saved as Version ${String(revision)}`,
    saveFailed: 'The settings could not be saved.',
    /** What the leave question calls each part of the form. */
    parts: {
      model: 'Model',
      models: 'Can switch to',
      effort: 'Effort',
      stepLimit: 'Step limit',
    },
    /** The question a tab switch asks while the form holds changes (row 39b). */
    leave: {
      title: 'Leave without saving?',
      description: (parts: readonly string[]): string =>
        `Settings has changes that aren’t saved: ${joinedWithAnd(parts)}. Leaving this tab discards them.`,
      stay: 'Stay on Settings',
      confirm: 'Discard and leave',
    },
    /** The block at the end of an agent the owner keeps (row 39a). */
    deleteHeading: 'Delete this agent',
    deleteNote: 'Its chats stay, read-only. Its versions and memories are deleted.',
    deleteAction: 'Delete agent',
    deleteFailed: 'The agent could not be deleted.',
    deleteDialog: {
      title: (name: string): string => `Delete ${name}?`,
      description: (chats: number | undefined, dependents: string): string => {
        const kept =
          chats === undefined || chats === 0
            ? 'Its chats stay, read-only.'
            : chats === 1
              ? 'Its 1 chat stays, read-only.'
              : `Its ${String(chats)} chats stay, read-only.`;
        const lost = 'Its versions and memories are deleted, and this can’t be undone.';
        return dependents === ''
          ? `${kept} ${lost}`
          : `${kept} ${lost} ${dependents} will stop finding it.`;
      },
      typeLabel: (id: string): string => `Type ${id} to confirm`,
      confirm: 'Delete agent',
    },
    /** What finds the agent, as the delete question names it: "1 workflow (Order refund)". */
    dependents: {
      schedule: (count: number): string =>
        count === 1 ? '1 schedule' : `${String(count)} schedules`,
      workflow: (count: number): string =>
        count === 1 ? '1 workflow' : `${String(count)} workflows`,
      hook: (count: number): string => (count === 1 ? '1 hook' : `${String(count)} hooks`),
      named: (counted: string, names: readonly string[]): string =>
        `${counted} (${names.join(', ')})`,
      joined: (groups: readonly string[]): string => joinedWithAnd(groups),
    },
    stale: 'This agent changed after the page loaded. Reload to see its current settings.',
    forbidden: 'You may not change this agent.',
  },
  versions: {
    heading: 'Versions',
    description: 'Every save keeps a version; running chats keep theirs.',
    revision: (revision: number): string => `Version ${String(revision)}`,
    current: 'Current',
    /** A version a run started on (sweep W60). */
    ran: 'Ran',
    /** When a version was saved and by whom: "Oct 29, 11:38 AM, you". */
    saved: (when: string, byHand: boolean): string =>
      `${when}, ${byHand ? 'edited in the file' : 'you'}`,
    created: 'Created',
    nothingChanged: 'Saved with no change',
    /** What a version changed, by part: "Model: Haiku 5.5 to Sonnet 5.5", "Tools: added Issue refund". */
    change: {
      fromTo: (part: string, from: string, to: string): string => `${part}: ${from} to ${to}`,
      edited: (part: string): string => `${part}: changed`,
      tools: (added: readonly string[], removed: readonly string[]): string =>
        [
          ...(added.length === 0 ? [] : [`added ${added.join(', ')}`]),
          ...(removed.length === 0 ? [] : [`removed ${removed.join(', ')}`]),
        ].join(', '),
      none: 'None',
    },
    /** What each changed key of a version is called. A key not named here is shown as it is. */
    keys: {
      name: 'Name',
      description: 'Description',
      model: 'Model',
      models: 'Can switch to',
      effort: 'Effort',
      tools: 'Tools',
      instructions: 'Instructions',
      limits: 'Limits',
      approvals: 'Asks',
      guardrails: 'Guardrails',
      skills: 'Skills',
      references: 'Reference documents',
      a2a: 'A2A',
    },
    viewAction: 'View',
    viewLabel: (revision: number): string => `View Version ${String(revision)}`,
    restoreAction: 'Restore',
    restoreLabel: (revision: number): string => `Restore Version ${String(revision)}`,
    /** The confirmation a restore asks first (row 38z). */
    restoreDialog: {
      title: (revision: number): string => `Restore Version ${String(revision)}?`,
      description: (revision: number, current: number, changes: string): string => {
        const removed =
          current === revision + 1
            ? `Version ${String(current)}’s changes`
            : `the changes of Versions ${String(revision + 1)} to ${String(current)}`;
        const what = changes === '' ? '' : `: ${changes}`;
        return `Restoring Version ${String(revision)} removes ${removed}${what}. This makes Version ${String(current + 1)}, and Version ${String(current)} stays in the list. Running chats keep the version they started with.`;
      },
      confirm: (revision: number): string => `Restore Version ${String(revision)}`,
    },
    /** One version opened read-only (rows 39t, 39u). */
    view: {
      back: 'Versions',
      readOnly: (saved: string): string => `${saved}, read-only`,
      changedFrom: (revision: number, summary: string): string =>
        `Changed from Version ${String(revision)}: ${summary}`,
      note: (current: number): string =>
        `Instructions, tools and guardrails are shown as they were; nothing here can be edited. Version ${String(current)} is the current version.`,
      instructions: 'Instructions',
      tools: 'Tools',
      /** A tool the version allows, with when it asks first: "Lookup order (Never)". */
      tool: (tool: string, asks: string): string => `${tool} (${asks})`,
      notAllowed: (tool: string): string => `${tool} is not allowed in this version`,
      noTools: 'No tools',
      guardrails: 'Guardrails',
      noGuardrails: 'Only the default guardrails',
      noDefinition: 'This version holds no definition to show.',
    },
    restoreFailed: 'That version could not be restored.',
    restoreStale:
      'This agent changed after the page loaded. The versions below are up to date; restore again if you still want that version.',
    loadFailed: 'The versions could not be loaded.',
    emptyTitle: 'No saved versions',
    emptyDescription: 'A version is kept each time this agent is saved.',
  },
} as const;
