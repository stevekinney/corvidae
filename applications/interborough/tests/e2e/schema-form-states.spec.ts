/**
 * The states the controls of Cinder's `SchemaForm` open into when a form is given a schema as it
 * was published, for the design review of COR-2774: a field that is also `null` (a number cleared
 * to `null`, a text field and an option list that start as `null`, a yes or no with Not set, a group
 * with Not set and Set, and a list with Not set and Clear), a union drawn as a choice
 * (`retention.checkpoints`, and a nested false-or-object field with its "Off" choice), and the
 * duration unit that sits on a field's own schema. Each screen is one the showcase run does not reach: Settings General with
 * Advanced open, Data and retention, the run setup page, a plugin's configuration and a workflow
 * step's input.
 *
 * Nothing is saved. The values a screen shows are put in the answer of the read (`bureau.settings.get`,
 * `/host/plugins`, the catalog), and the one state that needs an edit (a field cleared to `null`)
 * stops before the field is left, because leaving it is what saves. The capture runs only when
 * `INTERBOROUGH_DESIGN_REVIEW_CAPTURE` is set; an ordinary run reaches each state and checks it is
 * the one named. Each capture is at 1280 (and 1920, which the helper repeats) and at 375 (and 320
 * by 640), in the colour scheme the capture run sets.
 */
import type { Locator, Page } from '@playwright/test';
import { rm } from 'node:fs/promises';

import { WORKFLOW_COPY } from '../../src/app/copy/workflows.ts';
import { captureForDesignReviewWithPhone, nextFrame } from './design-review-capture.ts';
import { E2E_SHOWCASE_URL } from './e2e-constants.ts';
import { expect, test } from './fixtures.ts';
import { jsonEditor, replaceJsonEditorText } from './json-editor-support.ts';
import {
  createWorkflowFile,
  openJsonTab,
  openTab,
  removeWorkflow,
  workflowFilePath,
} from './workflow-support.ts';

const SOURCE = 'schema-form-states.spec.ts';
const BUILDER = WORKFLOW_COPY.builder;
const DESKTOP = { width: 1280, height: 900 } as const;

const settingRow = (page: Page, key: string) => page.locator(`[data-setting="${key}"]`);

/**
 * Brings `element` into view and waits for the frame it lands in, so a capture of the page at each
 * width shows the control the state is named for, and not the top of the page above it. The helper
 * runs again after every resize, as `ready` does.
 */
async function inView(element: Locator): Promise<void> {
  await expect(element).toBeVisible();
  // Centred, not just made visible: a control scrolled to the viewport's edge has its focus ring
  // and its label cut off by it.
  await element.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await nextFrame(element.page());
}

/** What a read of the settings answers with in place of what the host holds. */
type SettingsScene = {
  /** Values put over the ones the host holds, by key. */
  readonly values?: Readonly<Record<string, unknown>>;
  /** Schema nodes put over the ones the host publishes, by key. */
  readonly nodes?: Readonly<Record<string, unknown>>;
};

/** Answers the reads of the settings and of their schema as `scene` says, and changes nothing else. */
async function answerSettings(page: Page, scene: SettingsScene): Promise<void> {
  await page.route('**/jsonrpc', async (route) => {
    const body = route.request().postDataJSON() as { method?: string } | null;
    if (body?.method === 'bureau.settings.get' && scene.values !== undefined) {
      const response = await route.fetch();
      const answer = (await response.json()) as { result: { values: Record<string, unknown> } };
      Object.assign(answer.result.values, scene.values);
      await route.fulfill({ response, json: answer });
      return;
    }
    if (body?.method === 'bureau.settings.schema' && scene.nodes !== undefined) {
      const response = await route.fetch();
      const answer = (await response.json()) as {
        result: { schema: { properties: Record<string, unknown> } };
      };
      Object.assign(answer.result.schema.properties, scene.nodes);
      await route.fulfill({ response, json: answer });
      return;
    }
    await route.fallback();
  });
}

/** Opens Settings General on the sample world with Advanced open. */
async function openAdvanced(page: Page): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await page.goto(`${E2E_SHOWCASE_URL}/settings`);
  await expect(page.locator('[data-view="settings"]')).toHaveAttribute('data-state', 'ready');
  await page.getByRole('button', { name: 'Advanced' }).click();
}

/** Opens Data and retention on the end-to-end host. */
async function openRetention(page: Page): Promise<void> {
  await page.setViewportSize(DESKTOP);
  await page.goto('/settings/data-and-retention');
  await expect(settingRow(page, 'retention.audit')).toBeVisible();
}

test.describe('Settings › General /settings (advanced): a field that is also null', () => {
  test('payload size unset: the limit is null, so its field is empty and its row says nothing is set', async ({
    page,
  }) => {
    await answerSettings(page, { values: { 'engine.payloadSize': { maxBytes: null } } });
    await openAdvanced(page);
    const row = settingRow(page, 'engine.payloadSize');
    await expect(row).toBeVisible();
    await expect(row.getByRole('spinbutton')).toHaveValue('');
    await captureForDesignReviewWithPhone(page, {
      route: '/settings (advanced)',
      state: 'payload-size-unset-null',
      source: SOURCE,
      ready: async (current) => {
        await inView(settingRow(current, 'engine.payloadSize'));
      },
    });
  });

  test('payload size cleared: the limit held 4096 and its field is emptied, which the form reads as null', async ({
    page,
  }) => {
    await answerSettings(page, { values: { 'engine.payloadSize': { maxBytes: 4096 } } });
    await openAdvanced(page);
    const number = settingRow(page, 'engine.payloadSize').getByRole('spinbutton');
    await expect(number).toHaveValue('4,096');
    // Not left: leaving the field is what saves it, and nothing is saved here.
    await number.fill('');
    await expect(number).toHaveValue('');
    await captureForDesignReviewWithPhone(page, {
      route: '/settings (advanced)',
      state: 'payload-size-cleared-to-null',
      source: SOURCE,
      ready: async (current) => {
        const field = settingRow(current, 'engine.payloadSize').getByRole('spinbutton');
        await expect(field).toHaveValue('');
        // Brought into view at each width, so the focused field is not cut off.
        await inView(field);
      },
    });
  });

  test('history and retention: the two other object settings drawn from their published schemas', async ({
    page,
  }) => {
    await openAdvanced(page);
    await expect(settingRow(page, 'engine.history')).toBeVisible();
    await expect(settingRow(page, 'engine.retention')).toBeVisible();
    await captureForDesignReviewWithPhone(page, {
      route: '/settings (advanced)',
      state: 'engine-history-and-retention',
      source: SOURCE,
      ready: async (current) => {
        await inView(settingRow(current, 'engine.history'));
      },
    });
  });

  for (const [state, options] of [
    ['nested-false-or-object--object-chosen', { count: 3 }],
    ['nested-false-or-object--false-chosen', false],
  ] as const) {
    test(`a nested false-or-object field, ${options === false ? 'false' : 'the object'} chosen: an "Off" and "Custom setup" choice in the row's control column, on the title's line, with the object's fields below`, async ({
      page,
    }) => {
      // No shipped setting has one, so one published setting is given the shape for this screen.
      await answerSettings(page, {
        values: { 'engine.history': { options } },
        nodes: {
          'engine.history': {
            type: 'object',
            description: 'A setting with a field that is false or an object.',
            properties: {
              options: {
                anyOf: [
                  { type: 'boolean', const: false },
                  {
                    type: 'object',
                    title: 'Custom setup',
                    properties: { count: { type: 'integer', title: 'Count' } },
                  },
                ],
              },
            },
          },
        },
      });
      await openAdvanced(page);
      const row = settingRow(page, 'engine.history');
      // `false` beside an object is "Off", and the object is named by its title.
      await expect(row.getByRole('radio', { name: 'Off' })).toBeVisible();
      await expect(row.getByRole('radio', { name: 'Custom setup' })).toBeVisible();
      await captureForDesignReviewWithPhone(page, {
        route: '/settings (advanced)',
        state,
        source: SOURCE,
        ready: async (current) => {
          await expect(settingRow(current, 'engine.history').getByRole('radio')).toHaveCount(2);
          await inView(settingRow(current, 'engine.history'));
        },
      });
    });
  }
});

test.describe('Settings › /settings/data-and-retention: a union drawn as a choice', () => {
  for (const [state, value] of [
    ['checkpoints-keep-all', 'keep-all'],
    ['checkpoints-with-duration-timeout', { keepLast: 5, timeoutMilliseconds: 120_000 }],
  ] as const) {
    test(`retention.checkpoints, ${state}: the choice between "keep-all" and its fields, and the timeout as a duration`, async ({
      page,
    }) => {
      await answerSettings(page, { values: { 'retention.checkpoints': value } });
      await openRetention(page);
      const row = settingRow(page, 'retention.checkpoints');
      await expect(row.getByRole('radio', { name: 'Keep all' })).toBeVisible();
      if (typeof value !== 'string') {
        await expect(row.getByRole('combobox', { name: /unit/i })).toBeVisible();
      }
      await captureForDesignReviewWithPhone(page, {
        route: '/settings/data-and-retention',
        state,
        source: SOURCE,
        ready: async (current) => {
          await inView(settingRow(current, 'retention.checkpoints'));
        },
      });
    });
  }
});

test.describe('Run setup /workflows/:workflow/run: an input whose optional fields are also null', () => {
  const id = 'e2e-schema-form-nullable';

  test.afterEach(async ({ request }) => {
    await removeWorkflow(request, id);
    await rm(await workflowFilePath(request, id), { force: true });
  });

  test('a text field and an option list that start as null, a yes or no with Not set, a group with Not set and Set, and a list with Not set', async ({
    page,
    request,
  }) => {
    await createWorkflowFile(request, id, {
      title: 'Nullable input',
      trigger: { kind: 'signal', name: `${id}-go` },
      steps: [{ kind: 'await-signal', signal: `${id}-wait` }],
      inputSchema: {
        type: 'object',
        properties: {
          label: {
            title: 'Label',
            anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
          },
          mode: {
            title: 'Mode',
            anyOf: [{ type: 'string', enum: ['low', 'high'] }, { type: 'null' }],
          },
          flag: { title: 'Flag', anyOf: [{ type: 'boolean' }, { type: 'null' }] },
          options: {
            title: 'Options',
            anyOf: [
              {
                type: 'object',
                properties: { a: { type: 'string', minLength: 1 } },
                required: ['a'],
              },
              { type: 'null' },
            ],
          },
          tags: {
            title: 'Tags',
            anyOf: [{ type: 'array', items: { type: 'string' } }, { type: 'null' }],
          },
        },
      },
    });
    await page.setViewportSize(DESKTOP);
    await page.goto(`/workflows/${id}/run`);
    await expect(page.locator('[data-view="workflows"]')).toHaveAttribute('data-state', 'ready');
    const input = page.getByTestId('run-setup-input');
    await expect(input.getByRole('textbox', { name: /Label/ })).toHaveValue('');
    // The option list's empty choice is the null: "Not set", and it is the one chosen.
    const mode = input.getByRole('combobox', { name: /Mode/ });
    await expect(mode).toHaveValue('');
    await expect(mode.getByRole('option', { name: 'Not set' })).toBeAttached();
    // A yes or no that may be unset is three segments, and no field is a code editor.
    await expect(input.getByRole('radio', { name: 'Not set' })).toHaveCount(2);
    await expect(input.locator('.cinder-json-editor')).toHaveCount(0);
    await captureForDesignReviewWithPhone(page, {
      route: '/workflows/:workflow/run',
      state: 'nullable-inputs-seeded-null',
      source: SOURCE,
      ready: async (current) => {
        await inView(current.getByTestId('run-setup-input').getByRole('radio', { name: 'Yes' }));
      },
    });
  });
});

test.describe('Settings › Plugins /settings/plugins: a configuration with a field that is also null', () => {
  test('a text field, a number and an option list that hold or start as null', async ({ page }) => {
    await page.route('**/host/plugins', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const response = await route.fetch();
      const snapshot = (await response.json()) as {
        plugins: {
          descriptor: { name: string };
          configuration: unknown;
          configurationSchema: unknown;
        }[];
      };
      for (const plugin of snapshot.plugins) {
        if (plugin.descriptor.name !== 'guardrails') continue;
        plugin.configuration = { label: 'Operations', limit: null };
        plugin.configurationSchema = {
          type: 'object',
          properties: {
            label: {
              anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
              description: 'What the plugin is called here.',
            },
            limit: {
              anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }],
              description: 'How many results come back. Empty for no limit.',
            },
            region: {
              anyOf: [{ type: 'string', enum: ['us', 'eu'] }, { type: 'null' }],
              description: 'Where the work runs.',
            },
            cacheMs: {
              anyOf: [{ type: 'number', unit: 'milliseconds' }, { type: 'null' }],
              description: 'How long a result is kept.',
            },
          },
        };
      }
      await route.fulfill({ response, json: snapshot });
    });
    await page.setViewportSize(DESKTOP);
    await page.goto(`${E2E_SHOWCASE_URL}/settings/plugins?plugin=guardrails`);
    const configuration = page
      .locator('[data-plugin-detail="guardrails"]')
      .getByTestId('plugin-configuration');
    for (const key of ['label', 'limit', 'region', 'cacheMs']) {
      await expect(configuration.locator(`[data-cinder-field="${key}"]`)).toBeVisible();
    }
    await expect(configuration.locator('[data-cinder-field="region"] select')).toHaveValue('');
    await captureForDesignReviewWithPhone(page, {
      route: '/settings/plugins',
      state: 'configuration-with-nullable-fields',
      source: SOURCE,
      ready: async (current) => {
        await inView(
          current
            .locator('[data-plugin-detail="guardrails"]')
            .getByTestId('plugin-configuration')
            .locator('[data-cinder-field="limit"]'),
        );
      },
    });
  });
});

test.describe('The workflow builder /workflows/new (step cards): a step whose input has a field that is also null', () => {
  test('a workflow step draws a nullable text field, a number and a yes or no as controls, with Not set', async ({
    page,
  }) => {
    await page.route('**/jsonrpc', async (route) => {
      const body = route.request().postData() ?? '';
      if (!body.includes('bureau.workflows.catalog')) {
        await route.fallback();
        return;
      }
      const id = (JSON.parse(body) as { id?: unknown }).id ?? null;
      await route.fulfill({
        json: {
          jsonrpc: '2.0',
          id,
          result: {
            stepKinds: [],
            triggers: [],
            activities: [],
            workflows: [
              {
                id: 'demo:nullable',
                name: 'nullable',
                title: 'Notify with options',
                inputSchema: {
                  type: 'object',
                  properties: {
                    subject: {
                      title: 'Subject',
                      anyOf: [{ type: 'string', minLength: 1 }, { type: 'null' }],
                    },
                    limit: {
                      title: 'Limit',
                      anyOf: [{ type: 'integer', minimum: 1 }, { type: 'null' }],
                    },
                    urgent: { title: 'Urgent', anyOf: [{ type: 'boolean' }, { type: 'null' }] },
                  },
                },
              },
            ],
          },
        },
      });
    });
    await page.setViewportSize(DESKTOP);
    await page.goto('/workflows/new');
    await expect(page.locator('[data-view="workflows"]')).toHaveAttribute('data-state', 'ready');
    const root = page.locator('[data-page="workflow-creator"]');
    await openJsonTab(root);
    const json = await jsonEditor(root, WORKFLOW_COPY.creator.textLabel);
    await replaceJsonEditorText(
      json,
      JSON.stringify({
        name: 'e2e-nullable-step',
        trigger: { kind: 'manual' },
        steps: [{ kind: 'workflow', workflow: 'demo:nullable', input: { subject: null } }],
      }),
    );
    await openTab(root, BUILDER.builderTab);
    await expect(
      root.locator('[data-step-kind="workflow"] .cinder-schema-form').first(),
    ).toBeVisible();
    await captureForDesignReviewWithPhone(page, {
      route: '/workflows/new (step cards)',
      state: 'step-input-with-nullable-fields',
      source: SOURCE,
      ready: async (current) => {
        await inView(
          current
            .locator(
              '[data-page="workflow-creator"] [data-step-kind="workflow"] .cinder-schema-form',
            )
            .first(),
        );
      },
    });
  });
});
