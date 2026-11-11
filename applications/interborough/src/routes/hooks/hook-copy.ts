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
  /** The Hooks tab of an agent's page: the hooks scoped to that agent. */
  agentTab: {
    loadFailed: 'These hooks could not be loaded.',
    emptyTitle: 'No hooks for this agent yet',
    emptyDescription: 'A hook here runs only for what this agent does.',
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
    newDescription: 'Pick an event, then what should happen.',
    loadFailed: 'The hook could not be read.',
    /** The accessible name of the placeholders while the hook is read. */
    loadingLabel: 'Loading the hook',
    /** The status line under the placeholders when the read is slow. */
    stillLoading: 'Still loading. This is taking longer than usual.',
    /** What the page says in place of the editor once Cancel stopped a slow read: nothing failed. */
    stopped: {
      title: 'Stopped loading the hook',
      description: 'You stopped the read, so the hook is not shown. Nothing was changed by it.',
    },
    /** A hook that is not the caller's, or was deleted. */
    notFound: {
      title: 'That hook doesn’t exist',
      description: 'It may have been deleted. Your other hooks are unchanged.',
    },
    saved: 'Saved.',
    /** The bold lead of a failed save, then why, then that nothing typed is lost. */
    saveFailed: 'Couldn’t save the hook.',
    saveFailedKept: 'What you typed is still here.',
    /** Why a write failed: the server's status when it answered with an error, else its own words. */
    answeredWithError: (status: number): string =>
      `The server answered with an error (${String(status)}).`,
    noAnswer: 'The server didn’t answer.',
    staleTitle: 'This hook changed',
    changedDescription:
      'Someone else changed it since you opened it. Nothing was saved, and what you typed is still here. Reload to start from their version.',
    reload: 'Reload',
    staleDescription: 'Someone else changed it since you opened it. It has been read again.',
    /** The header of a hook that is already saved: its switch, its menu, and its latest delivery. */
    header: {
      /** The visible label of the header's switch; the hook's title follows it in the accessible name. */
      on: 'On',
      /** The accessible name of the menu button that holds Delete hook. */
      menuLabel: 'More actions for this hook',
      /** What the latest delivery's line says for a hook that has sent nothing yet. */
      nothingSent: 'Nothing sent yet',
      jumpToLog: 'Jump to log',
      /** The accessible name of the latest delivery's line. */
      latestLabel: 'Latest delivery',
    },
    /** What the header's switch says in a toast once it has saved, with an Undo. */
    toggled: {
      off: (title: string): string => `${title} is off. It won’t run until you turn it on.`,
      on: (title: string): string => `${title} is on.`,
      failed: 'The hook was not changed',
    },
    steps: {
      when: { number: '1', title: 'When' },
      what: { number: '2', title: 'Then' },
      check: { number: '3', title: 'Check' },
      /** The phone's compact step opens its fields with this button. */
      edit: 'Edit',
      /** The compact summary of the When step: the events, then what the hook is limited to. */
      whenSummary: (events: string, limit: string | undefined): string =>
        limit === undefined ? events : `${events}, ${limit}`,
    },
    event: {
      label: 'Event',
      placeholder: 'Pick an event',
      description: 'Choose an event to add. The hook runs for each one it lists.',
      /** Why a hook that has no event yet cannot be saved. */
      required: 'Pick an event.',
      tooMany: 'Choose at most 64 events.',
      /** Under the Event field of a hook that is saved. */
      fixed:
        'Can’t be changed after the hook is saved. Create a new hook to watch a different event.',
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
      /** Under Only for when the event belongs to a workflow and narrows by nothing else. */
      workflowDescription:
        'This event belongs to a workflow, so it narrows by workflow. System events have no narrowing.',
      everything: 'Everything',
      anyWorkflow: 'Any workflow',
      anyAgent: 'Any agent',
      anySchedule: 'Any schedule',
      /** Why nothing is offered: the events chosen are about the whole system. */
      none: 'These events are about the whole system, so this hook runs for all of them.',
      /** Why a hook limited to a kind of subject with none chosen cannot be saved. */
      required: 'Choose one, or choose Everything.',
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
      webhook: 'Send a webhook',
      startWorkflow: 'Start a workflow',
      notify: 'Notify me',
      /** What a hook that notifies says in place of fields. */
      notifyNote: 'You get a notification in Interborough, in the bell at the top right.',
      plugin: 'Run an action from a plugin',
    },
    webhook: {
      urlLabel: 'URL',
      urlPlaceholder: 'https://',
      /** An address that does not start with a scheme the Bureau sends to, or that holds none. */
      urlMissing: 'Enter a URL that starts with https://',
      urlInvalid: 'Use an HTTP or HTTPS address with no user name, password, or fragment.',
      secretLabel: 'Signing secret',
      secretHelp:
        'Deliveries are signed with the secret above so the receiver can verify them. If a delivery fails, Interborough retries with backoff, up to 8 tries.',
      /** What the masked secret reads to a screen reader, never the secret. */
      secretMasked: 'Signing secret, masked',
      secretReplace: 'Replace',
      secretReplacing: 'Replacing',
      /** Said beside a secret shown for the one time it can be seen. */
      secretOnce: 'Copy this now. You won’t be able to see it again.',
      secretReplaced: 'Replaced. The old secret stopped working.',
      secretReplaceFailed: 'The signing secret was not replaced',
      seePayload: 'See the payload',
    },
    workflow: {
      label: 'Workflow',
      placeholder: 'Choose a workflow',
      /** Under the picker: what the workflow receives. */
      payload: 'The event’s payload is the workflow’s input.',
      payloadEvent:
        'It receives the details of the event, the kind of event, and when it happened.',
      /** Why a workflow that was deleted cannot stay chosen, and what to do. */
      deleted: 'That workflow was deleted. Pick another to keep this hook working.',
      /** The old name, kept on the field and marked. */
      deletedName: (id: string): string => `${id}, can’t find this workflow`,
      required: 'Pick a workflow.',
      none: 'No workflow is ready to start',
      noneDescription: 'A workflow must be ready and not paused before a hook can start it.',
      create: 'New workflow',
    },
    check: {
      sentenceLabel: 'This hook',
      /** In the quiet box of a hook that is not saved yet and has no event. */
      pickEvent: 'Pick an event to see what this hook does.',
      /** In the quiet box of a hook that is not saved yet: the event it will watch. */
      eventLine: 'Event',
      saveToStart: 'Save hook to start watching.',
      nameLabel: 'Name',
      nameDescription: 'Optional. A label for the list.',
      nameTooLong: 'Use at most 100 characters.',
      save: 'Save hook',
      create: 'Save hook',
      test: 'Send a test event',
      testWebhookOnly:
        'A test event is sent only by a hook that sends a webhook. Other actions would start a real workflow or write a real notification.',
      /** The result under the buttons: what answered, how, and that nothing was saved when it was not. */
      testSent: (host: string, answer: string, milliseconds: number | undefined): string =>
        `Test event sent. ${host} answered ${answer}${
          milliseconds === undefined ? '' : ` in ${String(milliseconds)} ms`
        }.`,
      testSentUnsaved: 'Nothing was saved.',
      testFailed: 'Test event failed.',
      testFailedAnswered: (host: string, answer: string): string =>
        `${host} answered ${answer}. Check the URL, then send another test.`,
      testFailedNoAnswer: (host: string): string =>
        `${host} didn’t answer. Check the URL, then send another test.`,
      delete: 'Delete hook',
      deleteTitle: (name: string): string => `Delete “${name}”?`,
      deleteDescription:
        'The hook stops watching for events and its delivery log is removed. This can’t be undone. Turn it off instead to keep it.',
      deleteConfirm: 'Delete hook',
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
