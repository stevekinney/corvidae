/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';
import type { ToolInputMessagePart } from '../../utilities/types.ts';

setupHappyDom();

const { render, cleanup, fireEvent, screen } = await import('@testing-library/svelte');
const { default: ToolInputPart } = await import('./tool-input-part.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// load-proof: Svelte effects, event handlers and promise continuations settle in the microtask queue, so this turn only drains them and awaits no timer or IO
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function submit(container: HTMLElement): Promise<void> {
  const form = requiredInstance(container.querySelector('form'), HTMLFormElement);
  form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  await flush();
  await flush();
}

async function fill(room: string | undefined, attendees: string): Promise<void> {
  if (room !== undefined) {
    await fireEvent.input(screen.getByLabelText(/Room/), { target: { value: room } });
  }
  // NumberInput commits its parsed value on blur.
  const attendeesField = screen.getByRole('spinbutton', { name: /Attendees/ });
  await fireEvent.input(attendeesField, { target: { value: attendees } });
  await fireEvent.blur(attendeesField);
}

function inputPart(overrides?: Partial<ToolInputMessagePart>): ToolInputMessagePart {
  return {
    type: 'tool-input',
    key: 'm:tool-input:call-1',
    toolCallId: 'call-1',
    toolName: 'book_meeting',
    message: 'Which room should I book?',
    schema: {
      type: 'object',
      properties: {
        room: { type: 'string', title: 'Room', minLength: 1 },
        attendees: { type: 'integer', title: 'Attendees', minimum: 1 },
      },
      required: ['room', 'attendees'],
    },
    ...overrides,
  };
}

describe('ToolInputPart', () => {
  test('renders the requested schema as a Cinder SchemaForm instead of code', async () => {
    const { container, getByLabelText, getByRole } = render(ToolInputPart, {
      props: { part: inputPart(), onInputSubmit: () => undefined },
    });
    await flush();

    const section = getByRole('region', { name: 'Which room should I book?' });
    expect(section.hasAttribute('data-cinder-tool-input')).toBe(true);
    expect(container.querySelector('form.cinder-schema-form')).not.toBeNull();
    expect(getByLabelText(/Room/)).toBeInstanceOf(HTMLInputElement);
    expect(getByRole('spinbutton', { name: /Attendees/ })).toBeInstanceOf(HTMLInputElement);
    expect(container.textContent).toContain('Which room should I book?');
    expect(container.textContent).not.toContain('"minLength"');
    expect(container.querySelector('pre, code')).toBeNull();
  });

  test('a valid submission calls onInputSubmit exactly once with the tool call id and value', async () => {
    const calls: { toolCallId: string; value: unknown }[] = [];
    const { container, getByRole } = render(ToolInputPart, {
      props: {
        part: inputPart(),
        onInputSubmit: (toolCallId, value) => {
          calls.push({ toolCallId, value });
        },
      },
    });
    await flush();

    await fill('Atlas', '4');
    await submit(container);

    expect(calls).toEqual([{ toolCallId: 'call-1', value: { room: 'Atlas', attendees: 4 } }]);
    expect(container.querySelector('form')).toBeNull();
    expect(getByRole('status').textContent).toContain('You answered Room: Atlas, Attendees: 4');

    await flush();
    expect(calls).toHaveLength(1);
  });

  test('an invalid submission shows SchemaForm errors, focuses the first invalid field, and calls nothing', async () => {
    const calls: unknown[] = [];
    const { container, getByLabelText } = render(ToolInputPart, {
      props: {
        part: inputPart(),
        onInputSubmit: (_toolCallId, value) => {
          calls.push(value);
        },
      },
    });
    await flush();

    await fill(undefined, '0');
    await submit(container);

    expect(calls).toEqual([]);
    expect(container.querySelector('form')).not.toBeNull();
    const room = getByLabelText(/Room/);
    const errorId = room
      .getAttribute('aria-describedby')
      ?.split(' ')
      .find((id) => id.includes('error'));
    expect(errorId === undefined ? '' : document.getElementById(errorId)?.textContent).toBeTruthy();
    expect(room.getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(room);
  });

  test('lets the reader retry when the submission callback rejects', async () => {
    let attempts = 0;
    const { container } = render(ToolInputPart, {
      props: {
        part: inputPart(),
        onInputSubmit: () => {
          attempts += 1;
          return Promise.reject(new Error('offline'));
        },
      },
    });
    await flush();

    await fill('Atlas', '2');
    await submit(container);

    expect(attempts).toBe(1);
    expect(container.querySelector('form')).not.toBeNull();
  });

  test('uses the question as its one visible heading and the name of its region, and hides the tool identifier', async () => {
    const { container, getByRole } = render(ToolInputPart, {
      props: { part: inputPart(), onInputSubmit: () => undefined },
    });
    await flush();

    const headings = container.querySelectorAll('.chat-tool-input-heading');
    expect(headings).toHaveLength(1);
    expect(headings[0]!.textContent?.trim()).toBe('Which room should I book?');
    // The question is said once, so a screen reader does not hear it twice.
    expect(container.textContent?.split('Which room should I book?').length).toBe(2);
    expect(container.textContent).not.toContain('book_meeting');
    expect(container.textContent).not.toContain('Input requested by');
    const region = getByRole('region', { name: 'Which room should I book?' });
    expect(region.getAttribute('aria-labelledby')).toBe(headings[0]!.id);
  });

  test('puts the question before the controls', async () => {
    const { container } = render(ToolInputPart, {
      props: { part: inputPart(), onInputSubmit: () => undefined },
    });
    await flush();

    const heading = container.querySelector('.chat-tool-input-heading')!;
    const form = container.querySelector('form')!;
    expect(
      heading.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('names the tool when the request has no question', async () => {
    const { getByRole } = render(ToolInputPart, {
      props: {
        part: inputPart({ message: undefined }),
        onInputSubmit: () => undefined,
      },
    });
    await flush();

    expect(getByRole('region', { name: 'Input requested by book_meeting' })).not.toBeNull();
  });

  test('omits the form when no submission callback is available', () => {
    const { container } = render(ToolInputPart, { props: { part: inputPart() } });

    expect(container.querySelector('form')).toBeNull();
    expect(container.textContent).toContain('Which room should I book?');
  });

  test('does not steal focus when it renders', async () => {
    const before = document.createElement('button');
    before.type = 'button';
    document.body.append(before);
    before.focus();

    render(ToolInputPart, { props: { part: inputPart(), onInputSubmit: () => undefined } });
    await flush();

    expect(document.activeElement).toBe(before);
  });
});
