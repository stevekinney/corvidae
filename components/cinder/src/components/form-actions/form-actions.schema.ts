import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    label: {
      type: 'string',
      description: 'Accessible name of the bar, read as the name of its group.',
      default: 'Form actions',
    },
    unsavedChanges: {
      type: 'number',
      description:
        'How many changes the form holds that are not saved. Above zero the bar\'s left side reads\n"1 unsaved change" or "N unsaved changes" in neutral text; at zero it says nothing.',
    },
    sticky: {
      type: 'boolean',
      description:
        'Keeps the bar at the bottom of the nearest scrolling container, so Save is in reach however\nlong the form gets. It clears the home indicator and rides above the on-screen keyboard.',
      default: false,
    },
    error: {
      type: 'string',
      description:
        'What a failed save says, in a danger alert above the buttons: "Couldn\'t save. Interborough\ndidn\'t answer. Your choices are still here." The first sentence is drawn as the title when\n`errorTitle` is not set. The buttons keep their labels, so Save is the retry.',
    },
    errorTitle: {
      type: 'string',
      description: 'Bold lead-in for `error`, such as "Couldn\'t save."',
    },
    class: {
      type: 'string',
      description: 'Additional class merged with `.cinder-form-actions`.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'end',
        reason: 'function-or-snippet',
        required: true,
        description:
          'The buttons at the end of the bar, secondary first and the primary submit last, so it sits rightmost: Cancel, then Save.',
      },
      {
        name: 'start',
        reason: 'function-or-snippet',
        description:
          'Controls kept at the start of the bar, after the summary and before the buttons, such as a Delete outside the main pair.',
      },
      {
        name: 'summary',
        reason: 'function-or-snippet',
        description:
          'The left side of the bar: a status line such as "Not saved yet", or the effect of saving ("Saving raises the policy revision."). Follows the unsaved-change count when there is one.',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
