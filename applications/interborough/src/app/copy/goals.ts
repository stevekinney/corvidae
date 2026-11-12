/**
 * The words the goals list (`/goals`) uses. The list draws its own empty, loading and failed states
 * under its own header (`ownsStatesOnPatterns` in `views.ts`), so `VIEW_COPY.goals` takes its empty
 * words from here.
 */
export const GOALS_COPY = {
  newAction: 'New goal',
  /** The line under the heading. */
  subtitle: 'Work an agent keeps trying until its check is met.',
  /** The accessible name of the filter bar. */
  filtersLabel: 'Filter goals',
  /** The accessible name of the list of goals. */
  rowsLabel: 'Goals',
  /** The status segments, in the order the filter bar draws them. */
  segments: {
    all: 'All',
    running: 'Running',
    done: 'Done',
    gaveUp: 'Gave up',
    stopped: 'Stopped',
  },
  /** The add-facet chip that narrows the list to one agent. */
  agentLabel: 'Agent',
  clearAction: 'Clear filters',
  /** Nothing yet: the empty state that is the page. */
  empty: {
    title: 'No goals yet',
    description:
      'A goal runs an agent again and again until a check you write passes. Try one when a single reply may not be enough.',
  },
  /** A filter that matches none of the goals read. */
  noMatch: {
    title: 'No goals match these filters',
  },
  /** The name of the loading region, and the line that says the read is slow. */
  loading: 'Loading goals',
  stillLoading: 'Still loading goals…',
  /** What the page says after "Cancel" in the "Still loading" line: nothing failed, the person stopped it. */
  stopped: {
    title: 'Stopped loading goals',
    description: 'You stopped the read, so the goals are not shown. Nothing was changed.',
  },
  /** A read that did not give the page its goals, with the status the server answered with. */
  failed: {
    title: 'Couldn’t load goals',
    answered: (status: number): string =>
      `The server answered with an error (${String(status)}). Nothing you did caused it.`,
    /** A refusal (401 or 403) is something to fix, so it carries the server's own words. */
    refused: (status: number, message: string): string =>
      `The server answered with an error (${String(status)}): ${message.replace(/[.\s]+$/, '')}.`,
    noAnswer: 'The server didn’t answer. Nothing you did caused it.',
    unknown: 'Something went wrong reading the goals. Nothing you did caused it.',
    openHealth: 'Check Health',
    openHealthPath: '/health',
  },
  /** Why the header's "+" is inert while the goals could not be read. */
  newActionOffReason: 'New goal is off until the goals load.',
  /** A day band's words for the days that are not named by their date. */
  band: { today: 'Today', yesterday: 'Yesterday', earlier: 'Earlier' },
  /** What a goal's row says it is trying to make true: the check's text after the word. */
  checkLine: (text: string): string => `Check: ${text}`,
  /** The qualifier on Running for a goal that has been asked to stop and has not yet. */
  stopping: 'stopping',
  /**
   * The goal's own page (`/goals/:goal`): its name and status, the note that says how it ended or
   * what it waits on, its attempts newest first, and a Details panel beside them. The page draws
   * its own loading and failed states under its own header (`ownsStatesOnPatterns` in `views.ts`).
   */
  detail: {
    /** The heading while the goal is read, before its name is known (row 68t). */
    loadingTitle: 'Goal',
    /** The name of the loading region, and the line that says the read is slow. */
    loading: 'Loading this goal',
    stillLoading: 'Still loading this goal…',
    /** What the page says after "Cancel" in the "Still loading" line: nothing failed, the person stopped it. */
    stopped: {
      title: 'Stopped loading this goal',
      description: 'You stopped the read, so the goal is not shown. Nothing was changed.',
    },
    editAction: 'Edit',
    startAgainAction: 'Start again',
    stopAction: 'Stop goal',
    /** Why Start again is off for a model agent while no provider holds a key, and where to fix it. */
    connectProvider: 'Connect a provider',
    connectProviderPath: '/settings/models',
    /** Why Edit and Stop goal are inert while the server gives no answer (row 68w). */
    offlineReason: 'Edit and Stop goal are off until Interborough answers.',
    /** The qualifier on Running while an attempt's result is checked (sweep S73). */
    checkingQualifier: 'checking the result',
    /** The qualifier on Running while the goal is about to make its next attempt (sweep S73). */
    retryingQualifier: (next: number, most: number): string =>
      `attempt ${String(next)} of ${String(most)}`,
    attemptsHeading: 'Attempts',
    /** The accessible name of the list of attempts. */
    attemptsLabel: 'Attempts of this goal, newest first',
    attemptTitle: (number: number): string => `Attempt ${String(number)}`,
    noAttempts: {
      title: 'No attempts yet',
      description: 'The goal has not started an attempt. Its attempts are listed here as they run.',
    },
    /** Line two of an attempt's row, after the agent's name. */
    line: {
      took: (duration: string): string => `took ${duration}`,
      /** While the result is checked, "took" covers the agent's part of the attempt. */
      agentTook: (duration: string): string => `Agent took ${duration}`,
      agentStopped: (why: string): string => `Agent stopped: ${why}`,
      canceledAt: (clock: string, duration: string): string =>
        `canceled at ${clock} after ${duration}`,
      canceled: 'canceled',
      runningFor: (duration: string): string => `running for ${duration}`,
      waitingApproval: (tool: string): string => `${tool} is waiting for your approval`,
      waitingQuestion: 'A question is waiting for your answer',
      /** What an approval is for before its review has been read. */
      aTool: 'A tool',
    },
    /** Why an agent stopped, for the finish reasons that are not its normal end. */
    agentStopReasons: {
      tripwire: 'a guardrail',
      'maximum-steps': 'step limit',
      'budget-exceeded': 'budget',
      error: 'error',
    },
    /** The note under the header: how the goal ended, or what its attempt waits on. */
    note: {
      done: (attempt: number, most: number, when: string | undefined): string =>
        when === undefined
          ? `Done on attempt ${String(attempt)} of ${String(most)}: the check was met.`
          : `Done on attempt ${String(attempt)} of ${String(most)}: the check was met on ${when}.`,
      gaveUp: (made: number, most: number, when: string | undefined): string =>
        `Gave up${when === undefined ? '' : ` on ${when}`}, after ${String(made)} of ${String(most)} attempts. None of them met the check.`,
      stopped: (made: number, most: number, when: string | undefined): string =>
        `Stopped${when === undefined ? '' : ` on ${when}`}, after ${String(made)} of ${String(most)} attempts.`,
      attemptCanceled: (attempt: number): string =>
        `Attempt ${String(attempt)} was canceled; the work it did is kept in its run.`,
      failed: (made: number, most: number, when: string | undefined): string =>
        `Failed${when === undefined ? '' : ` on ${when}`}, after ${String(made)} of ${String(most)} attempts.`,
      openAttempt: (attempt: number): string => `Open attempt ${String(attempt)}`,
      waiting: (attempt: number, what: string): string =>
        `Attempt ${String(attempt)} is waiting on you: ${what}`,
      approvalNeeded: (tool: string): string =>
        `${tool} needs your approval before it can continue.`,
      questionNeeded: 'A question needs your answer before it can continue.',
      /** What an approval is for before its review has been read. */
      aTool: 'A tool',
      openInReviews: 'Open in Reviews',
    },
    /** "Fri, Oct 30 at 10:08 AM". */
    when: (day: string, clock: string): string => `${day} at ${clock}`,
    detailsHeading: 'Details',
    checkFact: 'Check',
    agentFact: 'Agent',
    limitFact: 'Attempt limit',
    stopsFact: 'Stops',
    createdFact: 'Created',
    attemptLimit: (most: number): string => (most === 1 ? '1 attempt' : `${String(most)} attempts`),
    stops: 'When the check passes, or after the last attempt',
    created: (when: string, by: string): string => `${when} by ${by}`,
    createdByYou: 'you',
    /** The Stop goal confirmation (row 67y). */
    stop: {
      title: (name: string): string => `Stop ${name}?`,
      checking: (attempt: number): string =>
        `Attempt ${String(attempt)} has finished and its result is being checked. Stopping cancels the check, and the work the attempt did stays in its run. No more attempts start. You can start the goal again later.`,
      running: (attempt: number): string =>
        `Attempt ${String(attempt)} is still running. Stopping cancels it, and the work the attempt did stays in its run. No more attempts start. You can start the goal again later.`,
      between: 'No more attempts start. You can start the goal again later.',
      busy: 'Stopping…',
      failedTitle: 'Couldn’t stop the goal.',
      failed: 'Interborough didn’t answer. Nothing was changed.',
      changed:
        'The goal changed while you were reading it. Nothing was changed, so look again and try once more.',
    },
    loadFailed: {
      title: 'The goal could not be loaded',
      description: 'The server did not answer. Check that the host is running, then try again.',
    },
  },
  /** The words for attempts used, of the most the goal may make. */
  attempts: (used: number, most: number): string => `${String(used)} of ${String(most)}`,
  /**
   * New goal (`/goals/new`, which Start again opens prefilled) and Edit goal (`/goals/:goal/edit`),
   * one form with four fields: what to do, the check, the agent and the attempt limit. The words
   * of Edit are in `edit`; every other key is the form's own.
   */
  form: {
    title: 'New goal',
    description:
      'Describe what you want and how to tell it worked. The agent keeps trying until the check passes.',
    /** The accessible name of the form's fields. */
    fieldsLabel: 'Goal',
    promptLabel: 'What should the agent do?',
    promptDescription:
      'Say what the agent should do. The first line becomes the goal’s name, shown in Goals and on each attempt.',
    promptRequired: 'Say what the agent should do.',
    checkLabel: 'Check',
    checkDescription: 'Write it as a statement that is true or false about the result.',
    checkPlaceholder: 'How will we know it worked?',
    checkRequired: 'Say how to tell the goal is done, such as “Reply says hello”.',
    agentLabel: 'Agent',
    agentPlaceholder: 'Choose an agent',
    agentDescription: 'The agent that makes each attempt.',
    agentUnavailableDescription: 'The agents could not be listed. Reload the page to try again.',
    noAgents: {
      title: 'No agents to run a goal',
      description: 'A goal runs an agent, and this installation lists none. Create an agent first.',
    },
    maximumAttemptsLabel: 'Attempt limit',
    maximumAttemptsDescription: 'Gives up after this many attempts, from 1 to 20.',
    maximumAttemptsInvalid: 'Use a number from 1 to 20.',
    /** Above the first field when a model agent is chosen and no provider holds a key. */
    needsProvider: (agent: string): string =>
      `${agent} needs a model provider, so a goal can’t make attempts yet.`,
    connectProvider: 'Connect a provider',
    connectProviderPath: '/settings/models',
    useAgent: (agent: string): string => `Use ${agent}`,
    /** The note beside the buttons: what the agent chosen needs, or what the form is doing. */
    footer: {
      scripted: (agent: string): string => `${agent} is scripted, so no provider is needed.`,
      starts: 'Creating the goal starts attempt 1.',
      gated: (agent: string): string =>
        `Create goal is off until a provider is connected, or you choose ${agent}.`,
      creating: 'Creating the goal and starting attempt 1…',
      prompt: 'The prompt is required before this can start.',
      check: 'The check is required before this can start.',
      attempts: 'The attempt limit is out of range.',
    },
    createAction: 'Create goal',
    creatingAction: 'Creating…',
    cancelAction: 'Cancel',
    /** What Cancel is called once the goal exists, so there is nothing left to cancel. */
    closeAction: 'Close',
    /** A create the Bureau did not take: what failed, then what is kept. */
    failedTitle: 'Couldn’t create the goal.',
    unreachable: 'Interborough didn’t answer.',
    kept: 'Nothing was saved, and everything you typed is still here.',
    tryAgain: 'Try again',
    /** The goal was committed, and the Bureau could not start its controller: it stays pending until recovery. */
    startFailedTitle: 'Goal created, but it did not start',
    startFailedGoal: (id: string): string => `Goal ${id}`,
    /** The name of the placeholders while Start again reads the goal it opens from. */
    loading: 'Loading the goal',
    /** Edit goal: New goal's four fields, prefilled, and a Save that starts no attempt. */
    edit: {
      title: 'Edit goal',
      description:
        'Changes apply to future attempts only. Attempts already made keep the check they ran against.',
      footer: 'Saving doesn’t start an attempt.',
      saving: 'Saving the goal…',
      saveAction: 'Save',
      savingAction: 'Saving…',
      /** The goal's view carries only the first line of its prompt, so the field starts empty, says how the current one begins and keeps it. */
      promptPlaceholder: (name: string): string =>
        name === ''
          ? 'Leave this empty to keep the current prompt.'
          : `Leave this empty to keep the current prompt, which begins “${name}”.`,
      /** Why the agent cannot change on a goal that already has attempts. */
      agentLocked: 'Attempts keep the agent they started with.',
      failedTitle: 'Couldn’t save the goal.',
      kept: 'Nothing was changed.',
      changed: 'The goal changed while you were editing it. Look at it again, then try once more.',
    },
  },
} as const;
