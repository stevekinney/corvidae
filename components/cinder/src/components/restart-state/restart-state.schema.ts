import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    open: {
      type: 'boolean',
      description:
        'Whether the state is showing. It never closes itself: nothing the person can press dismisses\nit, because the host is not answering and the page behind it would show nothing true. The page\ncloses it when the host is back, and says what applied in a banner.',
    },
    phase: {
      enum: ['restarting', 'reconnecting', 'failed'],
      description: 'Which of the three states to show.',
    },
    title: {
      type: 'string',
      description:
        'Heading of the state. Defaults to the phase\'s own words: "Restarting Interborough", "Waiting\nfor Interborough", "Interborough didn’t come back".',
    },
    description: {
      type: 'string',
      description:
        'The sentence under the heading. `restarting` and `failed` name what is happening and what was\nsaved ("Unloading Web search. Running work picks up where it stopped; reviews stay waiting."),\nso the page supplies them. `reconnecting` builds its own from `retryInSeconds`, `attempt` and\n`maxAttempts` when this is left out.',
    },
    steps: {
      type: 'array',
      items: {
        type: 'string',
      },
      description: 'The labels of the steps, in order, for `restarting`.',
      default: [
        'Saved your choice',
        'Stopped the server',
        'Starting Interborough',
        'Checking plugins',
      ],
    },
    currentStep: {
      type: 'number',
      description:
        'How many of `steps` are done in `restarting`: the step at that index is in progress, and the\nones after it are waiting.',
      default: 0,
    },
    attempt: {
      type: 'number',
      description:
        'The attempt under way in `reconnecting`, counted from 1. Fills that many segments of the meter.',
    },
    maxAttempts: {
      type: 'number',
      description: 'How many attempts there are. The meter has this many segments.',
      default: 8,
    },
    retryInSeconds: {
      type: 'number',
      description:
        'Seconds until the next automatic attempt in `reconnecting`. Adds "Trying again in 4 s."',
    },
    retryLabel: {
      type: 'string',
      description: 'Label of the button that tries at once in `reconnecting`.',
      default: 'Retry now',
    },
    checkTitle: {
      type: 'string',
      description: 'Heading of the checklist in `failed`.',
      default: 'What to check',
    },
    check: {
      type: 'string',
      description:
        'What to check in `failed`, in plain words: that the host is still running and that its address\nis reachable from this browser. Left out, the box does not show.',
    },
    detailsLabel: {
      type: 'string',
      description: 'Label of the disclosure for `details`.',
      default: 'Show the error details',
    },
    command: {
      type: 'string',
      description:
        'The exact command the host was launched with, in `failed`, with a Copy button: the way back\nwhen the host that would restart itself is the one that is not answering. Left out, the line\ndoes not show.',
    },
    commandLabel: {
      type: 'string',
      description: 'The words before `command`.',
      default: 'Start it again from the terminal:',
    },
    copyLabel: {
      type: 'string',
      description: 'Label of the button that copies `command`.',
      default: 'Copy',
    },
    keepWaitingLabel: {
      type: 'string',
      description:
        'Label of the primary button in `failed`. There is no restart-again action, because the route\nthat restarts lives on the host that is not answering.',
      default: 'Keep waiting',
    },
    class: {
      type: 'string',
      description: 'Optional extra class on the underlying `<Modal>`.',
    },
  },
  additionalProperties: false,
  required: ['open', 'phase'],
  metadata: {
    unsupportedProps: [
      {
        name: 'details',
        reason: 'function-or-snippet',
        description:
          'The error behind a failure, shown behind the `detailsLabel` disclosure in `failed`. Left out,\nthe disclosure does not show.',
      },
      {
        name: 'onKeepWaiting',
        reason: 'function-or-snippet',
        description:
          'Fired when the person chooses to keep waiting. The button shows only when this is set.',
      },
      {
        name: 'onRetry',
        reason: 'function-or-snippet',
        description:
          'Fired when the person asks to try at once. The button shows only when this is set.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
