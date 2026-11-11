/**
 * The words the hooks pages (`/hooks`, `/hooks/new`, `/hooks/:hook`) use outside the view states,
 * which are `VIEW_COPY.hooks`. A hook is read as a sentence, so most of this is the pieces the
 * sentence is made of.
 */
export const HOOKS_COPY = {
  newAction: 'New hook',
  loadMore: 'Load more',
  /** The accessible name of the filter bar. */
  filtersLabel: 'Filter hooks',
  searchPlaceholder: 'Search hooks',
  searchLabel: 'Search hooks',
  anyEvent: 'All events',
  eventFilter: 'Event',
  anyAgent: 'Any agent',
  agentFilter: 'Agent',
  clearAction: 'Clear filters',
  /** How many hooks the page lists, as a sentence. */
  count: (count: number): string => `${String(count)} ${count === 1 ? 'hook' : 'hooks'}`,
  /** The accessible name of the list of hooks. */
  rowsLabel: 'Hooks',
  /** The Only for cell of a hook. */
  onlyFor: {
    everything: 'Everything',
    agent: (id: string): string => `Agent ${id}`,
    workflow: (id: string): string => `Workflow ${id}`,
    schedule: (id: string): string => `Schedule ${id}`,
    /** A subject of a kind this page does not know: a home on a newer release can hold one. */
    other: (kind: string, id: string): string => `${kind} ${id}`.trim(),
  },
  /**
   * The list's rows: a status word, the hook's name and the time of its last delivery on line one,
   * and the hook as a sentence on line two. Line two is joined by commas, never a middle dot.
   */
  row: {
    /** The word a hook that has had no delivery reads, in the status column. */
    noDelivery: 'Nothing sent',
    /** The visible label of a row's switch; the hook's sentence follows it in the accessible name. */
    on: 'On',
    /** The clause a row's sentence opens with for an event, by the event's kind. */
    events: {
      'run.error': 'a run fails',
      'run.settled': 'a run finishes',
      'schedule.failed': 'a run fails',
      'schedule.completed': 'a run finishes',
      'schedule.missed': 'a schedule misses a run',
      'review.requested': 'a review is waiting',
      'review.approved': 'a review is approved',
      'review.denied': 'a review is denied',
      'session.created': 'a chat starts',
      'goal.succeeded': 'a goal succeeds',
      'goal.failed': 'a goal fails',
      'goal.canceled': 'a goal is canceled',
    } as Readonly<Record<string, string>>,
    /** What a row's sentence says a webhook and a workflow action do. */
    webhook: (host: string): string => `send a webhook to ${host}`,
    startWorkflow: (workflow: string): string => `start the ${workflow} workflow`,
    /** What a scope adds: a workflow reads inside the sentence, any other subject after it. */
    inWorkflow: (workflow: string): string => `in ${workflow}`,
    onlyFor: (subject: string): string => `only for ${subject}`,
    lastDelivery: (when: string): string => `last delivery ${when}`,
  },
  /** The list's own states, under a header that stays in every one of them. */
  list: {
    /** The line under the heading while there are hooks to list. */
    subtitle:
      'Run something when something happens: send a webhook, start a workflow, or notify you.',
    /** The line under the heading in first use. */
    subtitleShort: 'Run something when something happens.',
    /** First use: the empty state that is the page. */
    firstUse: {
      title: 'No hooks yet',
      description:
        'A hook runs something when an event happens, for example sending a webhook when a run fails.',
    },
    /** Filters that match no hook. */
    noMatch: {
      title: 'No hooks match these filters',
      description: (eventChosen: boolean, search: string): string => {
        if (eventChosen && search !== '') {
          return `No hook watches that event for ${search}. Try another event or search.`;
        }
        if (eventChosen) return 'No hook watches that event. Try another event.';
        if (search !== '') return `No hook matches ${search}. Try another search.`;
        return 'Change the filters to see more hooks.';
      },
    },
    /** The accessible name of the placeholders. */
    loading: 'Loading hooks',
    /** The status line under the placeholders when the read is slow. */
    stillLoading: 'Still loading. This is taking longer than usual.',
    /** What the list says after Cancel in the still-loading line: nothing failed. */
    stopped: {
      title: 'Stopped loading hooks',
      description: 'You stopped the read, so the hooks are not shown. Nothing was changed by it.',
    },
    /** A read that failed with nothing to show. */
    loadFailed: {
      title: 'Couldn’t load hooks',
      answered: (status: number): string =>
        `The server answered with an error (${String(status)}). Nothing you did caused it.`,
      noAnswer: 'The server didn’t answer. Nothing you did caused it.',
      unknown: 'Something went wrong reading the hooks. Nothing you did caused it.',
      openHealth: 'Open Health',
      openHealthPath: '/health',
    },
    /** Why the switches and New hook are off while the list on screen is old. */
    refreshOff: 'Off until Interborough answers.',
    /** Why the header's "+" does nothing while the list could not be read at all. */
    newActionOffReason: 'New hook is off until Interborough answers.',
  },
  toggleFailed: 'The hook was not changed',
  /** What a home that keeps hooks off says in place of the page. */
  unavailable: {
    title: 'Hooks are off on this home',
    description: 'This home was started without hooks, so there is nothing to set up here.',
  },
  /** The Hooks tab of an agent's page: the hooks scoped to that agent (board PageAgent, rows 38s, 38t and 39q). */
  agentTab: {
    loadFailed: 'These hooks could not be loaded.',
    /** The line over the tab's rows, which says what the list is. */
    intro: (agent: string): string =>
      `Hooks that run for ${agent}. This is the Hooks list filtered to this agent.`,
    emptyTitle: (agent: string): string => `No hooks for ${agent}`,
    emptyDescription: 'A hook sends a webhook when something happens to this agent’s runs.',
    /** The label of each row's switch on this tab; the Hooks page words it On. */
    active: 'Active',
  },
  /** The pieces a hook is read from, as a sentence: "When X, send a signed message to Y". */
  sentence: {
    when: 'When',
    noEvent: 'no event is chosen',
    or: 'or',
    more: (count: number): string => `${String(count)} more`,
    webhook: (url: string): string => `send a signed message to ${url}`,
    webhookUnset: 'send a signed message',
    startWorkflow: (workflow: string): string => `start the workflow ${workflow}`,
    startWorkflowUnset: 'start a workflow',
    notify: 'notify me',
    plugin: (plugin: string, kind: string): string => `run ${kind} from ${plugin}`,
    /** What a hook's scope adds after its events. */
    agent: (id: string): string => `for the agent ${id}`,
    workflow: (id: string): string => `for the workflow ${id}`,
    schedule: (id: string): string => `for the schedule ${id}`,
    other: (kind: string, id: string): string => `for the ${kind} ${id}`,
  },
  /** The editor's page. */
  editor: {
    newTitle: 'New hook',
    editTitle: 'Edit hook',
    newDescription: 'Say when it should happen and what it should do.',
    editDescription: 'Change when it happens or what it does.',
    backToList: 'All hooks',
    loadFailed: 'The hook could not be read.',
    loading: 'Reading the hook.',
    saved: 'Saved.',
    saveFailed: 'The hook was not saved',
    staleTitle: 'This hook changed',
    changedDescription:
      'Someone else changed it since you opened it. Nothing was saved, and what you typed is still here. Reload to start from their version.',
    reload: 'Reload',
    staleDescription: 'Someone else changed it since you opened it. It has been read again.',
    steps: {
      when: { number: '1', title: 'When' },
      what: { number: '2', title: 'Then' },
      check: { number: '3', title: 'Check' },
    },
    event: {
      label: 'Event',
      placeholder: 'Search events',
      description: 'Choose an event to add. The hook runs for each one it lists.',
      chosenHeading: 'Events this hook listens to',
      none: 'No event is chosen yet.',
      loadFailed: 'The events could not be read.',
      remove: (name: string): string => `Remove ${name}`,
      removeAction: 'Remove',
      areaOther: 'Other',
      /** Why an event cannot be chosen for the action. */
      notifyLoop:
        'A notification hook cannot listen to this: its own notification would run it again.',
      workflowLoop:
        'A workflow hook cannot listen to this: the workflow it starts could cause the event again.',
    },
    onlyFor: {
      label: 'Only for',
      description: 'Run this hook for one of these, or for everything.',
      everything: 'Everything',
      /** Why nothing is offered: the events chosen are about the whole system. */
      none: 'These events are about the whole system, so this hook runs for all of them.',
      /** Why a kind already on the hook cannot stay, once the events changed. */
      refused:
        'One of these events cannot tell what this is limited to. Remove the event, or choose Everything.',
      loadFailed: 'The choices could not be read.',
      /** The kind a hook holds that this page does not know: shown, never offered. */
      unknownKind: (kind: string): string => `${kind} (not editable here)`,
      kinds: { agent: 'One agent', workflow: 'One workflow', schedule: 'One schedule' },
      subject: {
        agent: 'Agent',
        workflow: 'Workflow',
        schedule: 'Schedule',
      },
      placeholder: 'Choose one',
    },
    action: {
      label: 'Do this',
      choose: 'What the hook does for each event.',
      /** Why a remote home does not offer a signed message: it cannot hold a signing secret. */
      chooseRemote:
        'What the hook does for each event. This home keeps its secrets in its environment, so it cannot send a signed message.',
      fixed: 'The kind of action is fixed once a hook is made.',
      webhook: 'Send a signed message to a web address',
      startWorkflow: 'Start a workflow',
      notify: 'Notify me',
      plugin: 'Run an action from a plugin',
    },
    webhook: {
      urlLabel: 'Web address',
      urlInvalid: 'Use an HTTP or HTTPS address with no user name, password, or fragment.',
      urlDescription: 'Each event is sent here as a POST, signed with the secret below.',
      secretLabel: 'Signing secret',
      secretNewDescription:
        'Between 16 and 256 characters. The receiver uses it to check the signature. It is never shown again.',
      secretKeepDescription:
        'Leave this empty to keep the current secret. A new one replaces it and is never shown again.',
      secretTooShort: 'Use at least 16 characters.',
      secretTooLong: 'Use at most 256 characters.',
    },
    workflow: {
      label: 'Workflow',
      placeholder: 'Choose a workflow',
      description: 'It starts as you, once for each event.',
      none: 'No workflow is ready to start',
      noneDescription: 'A workflow must be ready and not paused before a hook can start it.',
      create: 'New workflow',
      inputLabel: 'What the workflow receives',
      inputPayload: 'The details of the event',
      inputEvent: 'The details, the kind of event, and when it happened',
    },
    notify: {
      titleLabel: 'Title',
      titleDescription: 'Leave this empty to use the name of the event.',
    },
    check: {
      sentenceLabel: 'This hook',
      nameLabel: 'Name',
      nameDescription: 'Optional. A label for the list.',
      save: 'Save hook',
      create: 'Create hook',
      test: 'Send a test event',
      testNeedsSave: 'Save the hook first, then send a test event.',
      testWebhookOnly:
        'A test event is sent only by a hook that sends a signed message. Other actions would start a real workflow or write a real notification.',
      testReaches: (url: string): string =>
        `Sends one signed test message to ${url}. It is a real request.`,
      testFailed: 'The test event was not sent',
      delete: 'Delete hook',
      deleteTitle: 'Delete this hook?',
      deleteDescription: (sentence: string): string =>
        `${sentence}. Its signing secret and its deliveries are deleted with it.`,
      deleteConfirm: 'Delete',
      deleteFailed: 'The hook was not deleted',
    },
    deliveries: {
      heading: 'Recent deliveries',
      none: 'Nothing has been sent yet.',
      loadFailed: 'The deliveries could not be read.',
      testEvent: 'Test event',
      attempts: (made: number, allowed: number): string =>
        `${String(made)} of ${String(allowed)} attempts`,
    },
  },
  /** What the last attempt of a delivery came to, in a line. */
  attempt: {
    sending: 'Sending',
    answered: (status: number): string => `Answered ${String(status)}`,
    noAnswer: 'No answer',
    refused: 'The address was refused',
    interrupted: 'Stopped before an answer came',
    completed: 'Done',
    failed: 'Failed',
    secretMissing: 'The signing secret could not be read',
    aborted: 'Stopped: the hook was turned off or deleted',
    notStarted: 'Waiting for the first attempt',
  },
} as const;
