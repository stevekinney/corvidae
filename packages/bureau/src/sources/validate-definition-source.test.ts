/**
 * COR-1866 — `createBureau` refuses an agent source that cannot read an agent file's references,
 * and a source of the wrong kind, naming the option.
 */
import { describe, expect, it } from 'bun:test';

import { validateDefinitionSource } from './validate-definition-source';

const noop = async (): Promise<never> => {
  throw new Error('not called');
};

function refusal(
  option: 'agentSource' | 'workflowSource',
  kind: 'agent' | 'workflow',
  value: unknown,
) {
  try {
    validateDefinitionSource(option, kind, value, (message) => {
      throw new TypeError(message);
    });
  } catch (error) {
    return (error as Error).message;
  }
  return undefined;
}

const base = { load: noop, watch: () => () => undefined, write: noop, delete: noop };

describe('validateDefinitionSource', () => {
  it('accepts an agent source that reads siblings, and a workflow source that does not', () => {
    expect(
      refusal('agentSource', 'agent', { ...base, kind: 'agent', readSibling: noop }),
    ).toBeUndefined();
    expect(refusal('workflowSource', 'workflow', { ...base, kind: 'workflow' })).toBeUndefined();
  });

  it('refuses an agent source with no readSibling, naming the option and the method', () => {
    const message = refusal('agentSource', 'agent', { ...base, kind: 'agent' });
    expect(message).toContain('options.agentSource');
    expect(message).toContain('readSibling');
  });

  it('still says a workflow source is the wrong kind before it asks for readSibling', () => {
    const message = refusal('agentSource', 'agent', { ...base, kind: 'workflow' });
    expect(message).toContain('kind "agent"');
  });
});
