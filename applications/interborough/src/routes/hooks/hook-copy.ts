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
    /**
     * The delivery log beside the steps (board PageHooks, rows 84u to 84y, 85k and 86a to 86c). No
     * sentence here joins parts with a middle dot: a comma does.
     */
    deliveries: {
      heading: 'Delivery log',
      /** The accessible name of the All / Failed switch, whose heading is the log's own. */
      filterLabel: 'Show deliveries',
      all: 'All',
      failed: 'Failed',
      /** A hook with no delivery yet, which a new hook always is. */
      none: {
        title: 'No deliveries yet',
        description:
          'Each time this hook fires, the delivery shows here with its tries and the payload.',
      },
      /** The Failed filter over a log in which nothing failed. */
      noneFailed: {
        title: 'No failed deliveries',
        description: 'Nothing in this log has failed. Choose All to see every delivery.',
      },
      /** The accessible name of the placeholders while the log is read. */
      loadingLabel: 'Loading the delivery log',
      /** The status line under the placeholders when the read is slow. */
      stillLoading: 'Still loading. This is taking longer than usual.',
      /** What the log says after Cancel in the still-loading line: nothing failed. */
      stopped: {
        title: 'Stopped loading the delivery log',
        description: 'You stopped the read, so the log is not shown. The hook itself is unchanged.',
      },
      /** A read of the log that failed: only the log is read again by Try again. */
      loadFailed: {
        title: 'Couldn’t load the delivery log',
        answered: (status: number): string =>
          `The server answered with an error (${String(status)}). The hook itself is unchanged.`,
        noAnswer: 'The server didn’t answer. The hook itself is unchanged.',
        unknown: 'Something went wrong reading the log. The hook itself is unchanged.',
      },
      testEvent: 'Test event',
      /** What a delivery that is retrying says after its word: `Retrying, try 3 of 8`. */
      tryOf: (made: number, allowed: number): string => `try ${String(made)} of ${String(allowed)}`,
      /** The right-hand word of one try in the list of tries. */
      answer: {
        noAnswer: 'No answer',
        refused: 'Refused',
        interrupted: 'Stopped',
        sending: 'Sending',
        completed: 'Done',
        failed: 'Failed',
      },
      /** The line about the tries a delivery's list folds away. */
      moreTries: (count: number, answer: string | undefined): string => {
        const tries = `${String(count)} more ${count === 1 ? 'try' : 'tries'}`;
        return answer === undefined ? `${tries}.` : `${tries}, all ${answer}.`;
      },
      triesHeading: 'Tries',
      tryNumber: (number: number): string => `Try ${String(number)}`,
      showAll: 'Show all',
      showFewer: 'Show fewer',
      /** The label of the payload inspector over what the delivery sent. */
      payloadLabel: 'Payload sent',
      /** What the inspector says for a delivery that sent no request. */
      noPayload: 'This delivery sent no payload.',
      /** The Event field of the payload's Fields view: the event in words, and its kind. */
      eventField: (words: string, kind: string): string => `${words} (${kind})`,
      facts: { event: 'Event', sentTo: 'Sent to', lastResponse: 'Last response' },
      /** Why a delivery ended badly, and what to try, said at the head of its open line. */
      cause: {
        receiver: 'The receiver',
        hintRemoved: 'The webhook URL may have been removed. Check the URL, then retry.',
        hintSignature:
          'The receiver may not accept the signature. Check the signing secret, then retry.',
        hintDefault: 'Check the receiver, then retry.',
        secretMissing:
          'The signing secret could not be read, so nothing was sent. Replace the signing secret, then retry.',
        notSent: (receiver: string): string =>
          `Interborough never reached ${receiver}, so nothing was sent. Check the URL, then retry.`,
        refusedOutright: (receiver: string, hint: string): string =>
          `${receiver} refused this delivery outright, so Interborough stopped. ${hint}`,
        refused: (detail: string, hint: string): string =>
          `Interborough refused to send to that address${detail}, so it stopped. ${hint}`,
        answeredEvery: (receiver: string, answer: string, tries: number, hint: string): string =>
          `${receiver} answered ${answer} on ${
            tries === 1 ? 'its one try' : `all ${String(tries)} tries`
          }, so Interborough stopped. ${hint}`,
        answeredLast: (receiver: string, answer: string, tries: number, hint: string): string =>
          `${receiver} answered ${answer} on its last of ${String(tries)} tries, so Interborough stopped. ${hint}`,
        noAnswer: (receiver: string, tries: number, every: boolean, hint: string): string =>
          `${receiver} didn’t answer ${
            every
              ? tries === 1
                ? 'its one try'
                : `any of the ${String(tries)} tries`
              : `the last of ${String(tries)} tries`
          }, so Interborough stopped. ${hint}`,
      },
      /** The buttons that send a delivery again. */
      retry: 'Retry delivery',
      retryNow: 'Retry now',
      /** The line beside Retry now: when the next try is due, from `nextTryWords`. */
      nextTry: (when: string): string => `Next try in ${when}`,
      nextTryDue: 'a moment',
      retried: {
        delivered: 'Retried. The delivery went through.',
        waiting: 'Retried. It will try again soon.',
        failed: 'Retried, and it failed again.',
      },
      retryFailed: 'The delivery was not retried',
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
