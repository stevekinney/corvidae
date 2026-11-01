/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { requiredInstance, setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { render, cleanup, fireEvent, screen } = await import('@testing-library/svelte');
const { default: ChatQuestion } = await import('./chat-question.svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

// load-proof: Svelte effects, event handlers and promise continuations settle in the microtask queue, so this turn only drains them and awaits no timer or IO
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

type Schema = Record<string, unknown>;

async function ask(schema: Schema, props: Record<string, unknown> = {}) {
  const submitted: unknown[] = [];
  const view = render(ChatQuestion, {
    props: { schema, id: 'q', onSubmit: (value: unknown) => submitted.push(value), ...props },
  });
  await flush();
  return { ...view, submitted };
}

async function send(): Promise<void> {
  await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await flush();
}

describe('ChatQuestion draws each kind from its schema and submits a valid answer', () => {
  test('pick one: a button per choice, labelled, and a click answers', async () => {
    const { submitted } = await ask({
      type: 'string',
      enum: ['stg', 'prod'],
      'x-labels': { stg: 'Staging', prod: 'Production' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Production' }));
    expect(submitted).toEqual(['prod']);
  });

  test('pick one: a description shows under its label, wraps, and the name stays the label', async () => {
    const long = 'Rolls out to every region at once and cannot be undone. '.repeat(6).trim();
    const { container, submitted } = await ask({
      type: 'string',
      enum: ['stg', 'prod'],
      'x-labels': { stg: 'Staging', prod: 'Production' },
      'x-descriptions': { prod: long },
    });
    const described = screen.getByRole('button', { name: 'Production' });
    const description = container.querySelector('.chat-question-choice-description');
    expect(description?.textContent).toBe(long);
    expect(described.contains(description)).toBe(true);
    expect(described.getAttribute('aria-describedby')).toBe('q-choice-1-description');
    const label = described.querySelector('.chat-question-choice-label');
    expect(label?.nextElementSibling).toBe(description);
    // A choice without a description draws the label alone, as it did before.
    const plain = screen.getByRole('button', { name: 'Staging' });
    expect(plain.querySelector('.chat-question-choice-description')).toBeNull();
    expect(plain.hasAttribute('aria-describedby')).toBe(false);
    expect(container.querySelectorAll('.chat-question-choice-description')).toHaveLength(1);
    await fireEvent.click(described);
    expect(submitted).toEqual(['prod']);
  });

  test('pick several: a description shows beside its checkbox', async () => {
    const { container } = await ask({
      type: 'array',
      items: { enum: ['a', 'b'] },
      'x-descriptions': { a: 'The first one' },
    });
    expect(container.textContent).toContain('The first one');
  });

  test('pick one or something else: a choice answers, and Something else opens a field', async () => {
    const schema = {
      anyOf: [{ enum: ['red', 'blue'] }, { type: 'string', maxLength: 40 }],
      'x-allowOther': true,
    };
    const first = await ask(schema);
    await fireEvent.click(screen.getByRole('button', { name: 'blue' }));
    expect(first.submitted).toEqual(['blue']);
    cleanup();

    const second = await ask(schema);
    await fireEvent.click(screen.getByRole('button', { name: 'Something else…' }));
    await fireEvent.input(screen.getByLabelText('Something else'), { target: { value: 'teal' } });
    await send();
    expect(second.submitted).toEqual(['teal']);
  });

  test('pick several: checkboxes, and Send answers with the picked values in a list', async () => {
    const { submitted } = await ask({
      type: 'array',
      uniqueItems: true,
      items: { enum: ['a', 'b', 'c'] },
      minItems: 1,
      maxItems: 2,
    });
    expect(screen.getByRole('button', { name: 'Send' }).hasAttribute('disabled')).toBe(true);
    await fireEvent.click(screen.getByLabelText('a'));
    await fireEvent.click(screen.getByLabelText('c'));
    await send();
    expect(submitted).toEqual([['a', 'c']]);
  });

  test('free text with no composer: a field in place', async () => {
    const { submitted } = await ask({ type: 'string', maxLength: 100 });
    await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'because' } });
    await send();
    expect(submitted).toEqual(['because']);
  });

  test('free text through the composer: Answer below, and no field of its own', async () => {
    const { container } = await ask({ type: 'string' }, { answerInComposer: true });
    expect(container.textContent).toContain('Answer below');
    expect(container.querySelector('textarea, input')).toBeNull();
  });

  test('yes or no: two buttons that answer true and false', async () => {
    const { submitted } = await ask({ type: 'boolean' });
    await fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await fireEvent.click(screen.getByRole('button', { name: 'No' }));
    expect(submitted).toEqual([true, false]);
  });

  test('number: a number field, answered as a number', async () => {
    const { submitted } = await ask({ type: 'integer', minimum: 1, maximum: 10, title: 'Count' });
    const field = screen.getByRole('spinbutton', { name: /Count/ });
    await fireEvent.input(field, { target: { value: '7' } });
    await fireEvent.blur(field);
    await send();
    expect(submitted).toEqual([7]);
  });

  test('date: a date field, answered as YYYY-MM-DD', async () => {
    const { submitted } = await ask({ type: 'string', format: 'date', title: 'Day' });
    await fireEvent.input(screen.getByLabelText('Day'), { target: { value: '2026-10-29' } });
    await send();
    expect(submitted).toEqual(['2026-10-29']);
  });

  test('time: a time field, answered as an RFC 3339 time', async () => {
    const { submitted } = await ask({ type: 'string', format: 'time', title: 'At' });
    await fireEvent.input(screen.getByLabelText('At'), { target: { value: '14:30' } });
    await send();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatch(/^\d{2}:30:00Z$/);
  });

  test('date and time: a date and a time, answered as an RFC 3339 date-time', async () => {
    const { submitted } = await ask({ type: 'string', format: 'date-time', title: 'When' });
    await fireEvent.input(screen.getByLabelText('When: date'), { target: { value: '2026-10-29' } });
    await fireEvent.input(screen.getByLabelText('When: time'), { target: { value: '14:30' } });
    await send();
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatch(/^2026-10-29T\d{2}:30:00Z$/);
  });

  test('rating: a step per integer with its label, answered as the integer', async () => {
    const { submitted } = await ask({
      type: 'integer',
      minimum: 1,
      maximum: 3,
      'x-kind': 'rating',
      'x-labels': { '1': 'Poor', '3': 'Great' },
    });
    await fireEvent.click(screen.getByRole('radio', { name: 'Great' }));
    await send();
    expect(submitted).toEqual([3]);
  });

  test('a few fields: a SchemaForm whose valid submit answers with the object', async () => {
    const { container, submitted } = await ask({
      type: 'object',
      properties: { room: { type: 'string', title: 'Room', minLength: 1 } },
      required: ['room'],
    });
    await fireEvent.input(screen.getByLabelText(/Room/), { target: { value: 'Atlas' } });
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    await flush();
    expect(submitted).toEqual([{ room: 'Atlas' }]);
  });

  test('secret: a password field, and the draft is gone from the field once sent', async () => {
    const { container, submitted } = await ask({
      type: 'string',
      writeOnly: true,
      'x-secret': true,
      title: 'Token',
    });
    const field = requiredInstance(screen.getByLabelText('Token'), HTMLInputElement);
    expect(field.type).toBe('password');
    await fireEvent.input(field, { target: { value: 'hunter2' } });
    await send();
    expect(submitted).toEqual(['hunter2']);
    expect(field.value).toBe('');
    expect(container.innerHTML).not.toContain('hunter2');
  });

  test('file: uploads through the host and answers with the asset id', async () => {
    const uploaded: string[] = [];
    const { container, submitted } = await ask(
      { type: 'string', contentMediaType: 'image/png', 'x-asset': true },
      {
        uploadFile: (file: File) => {
          uploaded.push(file.name);
          return Promise.resolve('asset-42');
        },
      },
    );
    const input = requiredInstance(container.querySelector('input[type="file"]'), HTMLInputElement);
    const file = new File(['x'], 'logo.png', { type: 'image/png' });
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await fireEvent.change(input);
    await flush();
    await flush();
    expect(uploaded).toEqual(['logo.png']);
    expect(submitted).toEqual(['asset-42']);
  });

  test('file with no host upload says so instead of drawing a dropzone', async () => {
    const { container } = await ask({ type: 'string', 'x-asset': true });
    expect(container.querySelector('input[type="file"]')).toBeNull();
    expect(container.textContent).toContain('cannot upload files');
  });
});

describe('ChatQuestion states', () => {
  test('an answered question reads You answered … with Change', async () => {
    let changed = 0;
    const { container } = await ask(
      { type: 'string', enum: ['stg'], 'x-labels': { stg: 'Staging' } },
      {
        answer: {
          toolCallId: 'c',
          toolName: 't',
          message: undefined,
          schema: {},
          summary: 'Staging',
          value: 'stg',
          secret: false,
        },
        onChange: () => (changed += 1),
      },
    );
    expect(container.textContent).toContain('You answered');
    expect(container.textContent).toContain('Staging');
    expect(container.querySelector('button.chat-question-choice')).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: 'Change' }));
    expect(changed).toBe(1);
  });

  test('issues for a single-value question show on its field', async () => {
    const { container } = await ask(
      { type: 'string', format: 'date', title: 'Day' },
      { issues: [{ path: [], message: '"Day" must be a date as YYYY-MM-DD' }] },
    );
    const field = screen.getByLabelText('Day');
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(container.textContent).toContain('must be a date as YYYY-MM-DD');
  });

  test('issues for a few fields show on the field they name', async () => {
    await ask(
      {
        type: 'object',
        properties: {
          room: { type: 'string', title: 'Room' },
          size: { type: 'integer', title: 'Size' },
        },
      },
      { issues: [{ path: ['room'], message: 'Room is already booked' }] },
    );
    const room = screen.getByLabelText(/Room/);
    expect(room.getAttribute('aria-invalid')).toBe('true');
    expect(
      document.getElementById(
        room
          .getAttribute('aria-describedby')
          ?.split(' ')
          .find((id) => id.includes('error')) ?? '',
      )?.textContent,
    ).toContain('Room is already booked');
    expect(screen.getByRole('spinbutton', { name: /Size/ }).getAttribute('aria-invalid')).not.toBe(
      'true',
    );
  });

  test('an issue whose path names no field shows on the form, nested ones on their field', async () => {
    const schema = {
      type: 'object',
      properties: {
        room: { type: 'string', title: 'Room' },
        address: {
          type: 'object',
          title: 'Address',
          properties: { city: { type: 'string', title: 'City' } },
        },
      },
    };
    const nested = await ask(schema, {
      issues: [{ path: ['address', 'city'], message: 'No such city' }],
    });
    expect(screen.getByLabelText(/City/).getAttribute('aria-invalid')).toBe('true');
    expect(nested.container.textContent).toContain('No such city');
    cleanup();

    const rooted = await ask(schema, {
      issues: [{ path: ['answer', 'room'], message: 'Rooted at the answer' }],
    });
    expect(rooted.container.querySelectorAll('[aria-invalid="true"]')).toHaveLength(0);
    expect(rooted.container.textContent).toContain('Rooted at the answer');
  });
});

describe('ChatQuestion file gates', () => {
  const FILE = { type: 'string', contentMediaType: 'image/png', 'x-asset': true };

  async function drop(container: HTMLElement, file: File): Promise<void> {
    const input = requiredInstance(container.querySelector('input[type="file"]'), HTMLInputElement);
    Object.defineProperty(input, 'files', { value: [file], configurable: true });
    await fireEvent.change(input);
    await flush();
    await flush();
  }

  test('the drop zone takes only the schema media type and the host size limit', async () => {
    const { container } = await ask(FILE, {
      uploadFile: () => Promise.resolve('a'),
      maxFileSize: 1024,
    });
    const input = requiredInstance(container.querySelector('input[type="file"]'), HTMLInputElement);
    expect(input.getAttribute('accept')).toBe('image/png');
  });

  test('a type the browser cannot name is accepted: empty, or the x- form of the schema type', async () => {
    const yaml = { type: 'string', contentMediaType: 'application/yaml', 'x-asset': true };
    for (const type of ['', 'application/x-yaml', 'application/yaml']) {
      const uploaded: string[] = [];
      const { container, submitted } = await ask(yaml, {
        uploadFile: (file: File) => {
          uploaded.push(file.name);
          return Promise.resolve('asset-yaml');
        },
      });
      await drop(container, new File(['a: 1'], 'config.yaml', { type }));
      expect(uploaded).toEqual(['config.yaml']);
      expect(submitted).toEqual(['asset-yaml']);
      cleanup();
    }
  });

  test('a file of another type is refused before anything is uploaded', async () => {
    const uploaded: string[] = [];
    const { container, submitted } = await ask(FILE, {
      uploadFile: (file: File) => {
        uploaded.push(file.name);
        return Promise.resolve('asset-1');
      },
    });
    await drop(container, new File(['x'], 'notes.txt', { type: 'text/plain' }));
    expect(uploaded).toEqual([]);
    expect(submitted).toEqual([]);
    expect(container.textContent).toContain('notes.txt');
  });

  test('a file over the size limit is refused before anything is uploaded', async () => {
    const uploaded: string[] = [];
    const { container, submitted } = await ask(FILE, {
      maxFileSize: 4,
      uploadFile: (file: File) => {
        uploaded.push(file.name);
        return Promise.resolve('asset-1');
      },
    });
    await drop(container, new File(['too large'], 'big.png', { type: 'image/png' }));
    expect(uploaded).toEqual([]);
    expect(submitted).toEqual([]);
    expect(container.textContent).toContain('big.png');
  });
});

describe('ChatQuestion Change on a moment', () => {
  async function sendBack(schema: Schema, value: string): Promise<unknown[]> {
    const { submitted } = await ask(schema, {
      initialValue: value,
      answer: undefined,
    });
    await flush();
    await send();
    return submitted;
  }

  test('a time sent as RFC 3339 reopens in the time field and can be sent again', async () => {
    const submitted = await sendBack({ type: 'string', format: 'time', title: 'At' }, '14:30:00Z');
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatch(/^\d{2}:30:00Z$/);
  });

  test('a date-time sent as RFC 3339 reopens in both fields and can be sent again', async () => {
    const submitted = await sendBack(
      { type: 'string', format: 'date-time', title: 'When' },
      '2026-10-29T14:30:00Z',
    );
    expect(submitted).toHaveLength(1);
    expect(submitted[0]).toMatch(/^2026-10-29T\d{2}:30:00Z$/);
  });
});
