import { describe, expect, it } from 'bun:test';
import { displayDocumentActivityInput, displayStack } from './run-diagnostic-display.ts';

describe('run diagnostic display', () => {
  it('masks only absolute stack-frame locations while retaining the message and frame coordinates', () => {
    expect(
      displayStack(
        'Error: read /Users/alice/notes\n    at load (file:///Users/alice/project/app.ts:12:4)\n    at C:\\build\\task.ts:9:2\n    at relative (src/task.ts:3:1)',
      ),
    ).toBe(
      'Error: read /Users/alice/notes\n    at load ([path]/app.ts:12:4)\n    at [path]/task.ts:9:2\n    at relative (src/task.ts:3:1)',
    );
  });

  it('masks UNC and coordinate-free absolute frames without changing human text', () => {
    const stack =
      'Error: open \\\\server\\share\\notes\n    at run (\\\\server\\share\\lib\\job.ts:12:4)\n    at bare (/Users/alice/file.ts)\n    at \\\\server\\share\\worker.ts\n    at remote (https://example.com/app.js:2:3)';
    expect(displayStack(stack)).toBe(
      'Error: open \\\\server\\share\\notes\n    at run ([path]/job.ts:12:4)\n    at bare ([path]/file.ts)\n    at [path]/worker.ts\n    at remote (https://example.com/app.js:2:3)',
    );
  });

  it('removes only the matching top-level execution identity in a confirmed document envelope', () => {
    const input = {
      input: { workflowId: 'user-id', value: 'unchanged' },
      trigger: null,
      previous: null,
      workflowId: 'run-id',
      step: 1,
      stepAddress: '1',
    };
    expect(JSON.parse(displayDocumentActivityInput(JSON.stringify(input), 'run-id'))).toEqual({
      input: input.input,
      trigger: null,
      previous: null,
      step: 1,
      stepAddress: '1',
    });
    expect(displayDocumentActivityInput(JSON.stringify(input), 'other')).toBe(
      JSON.stringify(input),
    );
    expect(displayDocumentActivityInput('{broken', 'run-id')).toBe('{broken');
    expect(displayDocumentActivityInput('{"workflowId":"run-id"}', 'run-id')).toBe(
      '{"workflowId":"run-id"}',
    );
  });
});
