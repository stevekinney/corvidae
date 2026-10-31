/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, fireEvent, render, screen } = await import('@testing-library/svelte');
const { default: SchemaForm } = await import('./schema-form.svelte');
const { createSchemaFormModel } = await import('./schema-form-model.ts');
const { summarizeGroup } = await import('./schema-form-summary.ts');

// load-proof: Svelte effects and promise continuations settle in the microtask queue, so this turn only drains them and awaits no timer or IO
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const schema = {
  type: 'object',
  properties: {
    room: { type: 'string', title: 'Room' },
    size: { type: 'integer', title: 'Size' },
  },
};

describe('SchemaForm host-reported issues', () => {
  afterEach(() => cleanup());

  test('shows an issue on the field its path names and leaves the others valid', async () => {
    render(SchemaForm, {
      props: { schema, issues: [{ path: ['room'], message: 'Room is already booked' }] },
    });
    await flush();

    const room = screen.getByLabelText(/Room/);
    expect(room.getAttribute('aria-invalid')).toBe('true');
    const errorId = room
      .getAttribute('aria-describedby')
      ?.split(' ')
      .find((id) => id.includes('error'));
    expect(document.getElementById(errorId ?? '')?.textContent).toContain('Room is already booked');
    expect(screen.getByRole('spinbutton', { name: /Size/ }).getAttribute('aria-invalid')).not.toBe(
      'true',
    );
  });

  test('a new set of issues replaces the last, and editing the field clears its issue', async () => {
    const view = render(SchemaForm, {
      props: { schema, issues: [{ path: ['room'], message: 'Room is already booked' }] },
    });
    await flush();

    await view.rerender({ issues: [{ path: ['size'], message: 'Size is too large' }] });
    await flush();
    expect(screen.getByRole('spinbutton', { name: /Size/ }).getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(screen.getByLabelText(/Room/).getAttribute('aria-invalid')).not.toBe('true');

    await fireEvent.input(screen.getByRole('spinbutton', { name: /Size/ }), {
      target: { value: '3' },
    });
    await fireEvent.blur(screen.getByRole('spinbutton', { name: /Size/ }));
    await flush();
    expect(screen.getByRole('spinbutton', { name: /Size/ }).getAttribute('aria-invalid')).not.toBe(
      'true',
    );
  });

  test('a string marked writeOnly is a password field', async () => {
    render(SchemaForm, {
      props: {
        schema: {
          type: 'object',
          properties: { token: { type: 'string', title: 'Token', writeOnly: true } },
        },
      },
    });
    await flush();

    expect((screen.getByLabelText(/Token/) as HTMLInputElement).type).toBe('password');
  });

  test('an issue at a nested path shows on that field, and one that names no field shows on the form', async () => {
    const nested = {
      type: 'object',
      properties: {
        room: { type: 'string', title: 'Room' },
        address: {
          type: 'object',
          title: 'Address',
          properties: { city: { type: 'string', title: 'City' } },
        },
        rows: {
          type: 'array',
          title: 'Rows',
          items: {
            type: 'object',
            properties: { name: { type: 'string', title: 'Name' } },
          },
        },
      },
    };
    const city = render(SchemaForm, {
      props: { schema: nested, issues: [{ path: ['address', 'city'], message: 'No such city' }] },
    });
    await flush();
    expect(screen.getByLabelText(/City/).getAttribute('aria-invalid')).toBe('true');
    expect(city.container.textContent).toContain('No such city');
    cleanup();

    const unplaced = render(SchemaForm, {
      props: {
        schema: nested,
        issues: [
          { path: ['answer', 'room'], message: 'Rooted at the answer' },
          { path: ['nope'], message: 'Not a field' },
        ],
      },
    });
    await flush();
    expect(unplaced.container.querySelectorAll('[aria-invalid="true"]')).toHaveLength(0);
    expect(unplaced.container.textContent).toContain('Rooted at the answer');
    expect(unplaced.container.textContent).toContain('Not a field');
  });

  test('an issue inside a closed group opens it', async () => {
    const properties: Record<string, unknown> = {};
    for (let index = 0; index < 8; index += 1) {
      properties[`f${index}`] = { type: 'string', title: `Field ${index}` };
    }
    properties['account'] = {
      type: 'object',
      title: 'Account',
      properties: { owner: { type: 'string', title: 'Owner' } },
    };
    render(SchemaForm, {
      props: {
        schema: { type: 'object', properties },
        issues: [{ path: ['account', 'owner'], message: 'Owner is taken' }],
      },
    });
    await flush();
    expect(screen.getByLabelText(/Owner/).getAttribute('aria-invalid')).toBe('true');
  });
});

describe('SchemaForm with a secret field', () => {
  afterEach(() => cleanup());

  const largeSecretSchema = {
    type: 'object',
    properties: {
      ...Object.fromEntries(
        Array.from({ length: 8 }, (_, index) => [
          `f${index}`,
          { type: 'string', title: `Field ${index}` },
        ]),
      ),
      account: {
        type: 'object',
        title: 'Account',
        properties: {
          token: { type: 'string', title: 'Token', writeOnly: true, 'x-secret': true },
          owner: { type: 'string', title: 'Owner' },
        },
      },
    },
  };

  test('a closed group counts a secret as set without ever printing it', async () => {
    const { container } = render(SchemaForm, { props: { schema: largeSecretSchema } });
    await flush();

    const group = screen.getByRole('button', { name: /Account/ });
    await fireEvent.click(group);
    await flush();
    await fireEvent.input(screen.getByLabelText(/Token/), { target: { value: 'sk-live-123' } });
    await fireEvent.input(screen.getByLabelText(/Owner/), { target: { value: 'ada' } });
    await flush();
    await fireEvent.click(screen.getByRole('button', { name: /Account/ }));
    await flush();

    expect(container.textContent).toContain('ada');
    expect(container.textContent).toContain('••••');
    expect(container.textContent).not.toContain('sk-live-123');
    expect(container.innerHTML).not.toContain('sk-live-123');
  });

  test('a large form with a secret field offers no Edit as JSON panel', async () => {
    render(SchemaForm, { props: { schema: largeSecretSchema } });
    await flush();

    expect(screen.queryByRole('button', { name: 'Edit as JSON' })).toBeNull();
  });

  test('a large form without one still offers it', async () => {
    const plain = structuredClone(largeSecretSchema);
    delete (plain.properties.account.properties.token as Record<string, unknown>)['writeOnly'];
    delete (plain.properties.account.properties.token as Record<string, unknown>)['x-secret'];
    render(SchemaForm, { props: { schema: plain } });
    await flush();

    expect(screen.getByRole('button', { name: 'Edit as JSON' })).toBeTruthy();
  });
});

describe('SchemaForm optional moments', () => {
  afterEach(() => cleanup());

  test('an untouched optional date, time or date-time is left out of the answer, and a cleared one too', async () => {
    const submitted: unknown[] = [];
    const { container } = render(SchemaForm, {
      props: {
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string', title: 'Name' },
            due: { type: 'string', format: 'date', title: 'Due' },
            at: { type: 'string', format: 'time', title: 'At' },
            when: { type: 'string', format: 'date-time', title: 'When' },
          },
          required: ['name'],
        },
        onSubmit: (value: unknown) => {
          submitted.push(value);
        },
      },
    });
    await flush();

    await fireEvent.input(screen.getByLabelText(/Name/), { target: { value: 'ada' } });
    await fireEvent.input(screen.getByLabelText(/Due/), { target: { value: '2026-02-27' } });
    await fireEvent.input(screen.getByLabelText(/Due/), { target: { value: '' } });
    const form = container.querySelector('form')!;
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    await flush();
    await flush();

    expect(submitted).toEqual([{ name: 'ada' }]);
  });
});

describe('SchemaForm secrets in other places', () => {
  afterEach(() => cleanup());

  test('the hidden output field keeps no secret once the host has the value', async () => {
    const taken: unknown[] = [];
    const { container } = render(SchemaForm, {
      props: {
        schema: {
          type: 'object',
          properties: {
            token: { type: 'string', title: 'Token', writeOnly: true, 'x-secret': true },
          },
        },
        onSubmit: (value: unknown) => {
          taken.push(value);
        },
      },
    });
    await flush();
    await fireEvent.input(screen.getByLabelText(/Token/), { target: { value: 'sk-live-123' } });
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    await flush();
    await flush();

    expect(taken).toEqual([{ token: 'sk-live-123' }]);
    expect(container.innerHTML).not.toContain('sk-live-123');
    expect(container.querySelector<HTMLInputElement>('input[type=hidden]')?.value).toBe('');
  });

  test('a form without a secret keeps its serialized output for native readers', async () => {
    const { container } = render(SchemaForm, {
      props: {
        schema: { type: 'object', properties: { name: { type: 'string', title: 'Name' } } },
        onSubmit: () => undefined,
      },
    });
    await flush();
    await fireEvent.input(screen.getByLabelText(/Name/), { target: { value: 'ada' } });
    container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    await flush();
    await flush();

    expect(container.querySelector<HTMLInputElement>('input[type=hidden]')?.value).toBe(
      '{"name":"ada"}',
    );
  });

  test('a writeOnly literal branch of a choice is masked in a group summary', () => {
    const model = createSchemaFormModel({
      type: 'object',
      properties: {
        group: {
          type: 'object',
          title: 'Group',
          properties: {
            auth: {
              oneOf: [
                { type: 'string', writeOnly: true },
                { type: 'object', properties: { user: { type: 'string' } } },
              ],
            },
          },
        },
      },
    });
    const group = model.field.fields[0]!;

    const summary = summarizeGroup(group, { group: { auth: 'sk-live-123' } });

    expect(summary).not.toContain('sk-live-123');
    expect(summary).toContain('••••');
  });

  test('a blank root date that may be null is sent as null, and one that may not is refused with a message', async () => {
    const nullable: unknown[] = [];
    const first = render(SchemaForm, {
      props: {
        schema: { type: ['string', 'null'], format: 'date', title: 'Due' },
        onSubmit: (value: unknown) => {
          nullable.push(value);
        },
      },
    });
    await flush();
    first.container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    await flush();
    await flush();
    expect(nullable).toEqual([null]);
    expect(first.container.textContent).not.toContain('not JSON serializable');
    cleanup();

    const strict: unknown[] = [];
    const second = render(SchemaForm, {
      props: {
        schema: { type: 'string', format: 'date', title: 'Due', minLength: 10 },
        onSubmit: (value: unknown) => {
          strict.push(value);
        },
      },
    });
    await flush();
    second.container
      .querySelector('form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
    await flush();
    await flush();
    expect(strict).toEqual([]);
    expect(second.container.textContent).not.toContain('not JSON serializable');
  });
});
