<script lang="ts">
  import { SchemaView } from './index.ts';

  const schema = {
    type: 'object',
    required: ['repository', 'mode', 'reviewers'],
    properties: {
      repository: {
        type: 'string',
        format: 'uri',
        description: 'The repository to review.',
      },
      mode: {
        type: 'string',
        enum: ['quick', 'thorough', 'security'],
        default: 'thorough',
        description:
          'How deep the review goes. A quick review reads the diff only; a thorough one reads every file the diff touches and the tests that cover them; a security review also follows each input to where it is used.',
      },
      reviewers: {
        type: 'array',
        minItems: 1,
        maxItems: 3,
        description: 'Who reviews the change.',
        items: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', minLength: 1, description: 'The reviewer’s name.' },
            weight: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description:
                'How much this reviewer’s verdict counts against the others when they disagree, from nothing at all to the whole decision, so a lead can outweigh two newer reviewers on the same change.',
            },
          },
        },
      },
      limits: {
        type: 'object',
        description: 'Limits on the run.',
        properties: {
          budget: {
            type: 'object',
            description: 'What the run may spend.',
            properties: {
              tokens: { type: 'integer', minimum: 1000, description: 'Most tokens it may use.' },
              stopOnLimit: { type: 'boolean', default: true, description: 'Stop at the limit.' },
            },
          },
        },
      },
      draft: { type: 'boolean', default: false, description: 'Open the review as a draft.' },
      aVeryLongFieldNameWithoutAnyBreaksThatKeepsGoingAndGoing: {
        type: 'string',
        description: 'A field whose name has no break in it.',
      },
    },
  };
</script>

<!-- The parts of a schema row in one view: every type, a required field, nested objects and
     the items of a list, defaults, formats and constraints, a one-line, a three-line and a very
     long description, and a long unbroken field name. -->
<div class="schema-view-anatomy">
  <SchemaView {schema} label="Review input" />
</div>

<style>
  .schema-view-anatomy {
    padding: 1rem;
    max-inline-size: 56rem;
  }
</style>
