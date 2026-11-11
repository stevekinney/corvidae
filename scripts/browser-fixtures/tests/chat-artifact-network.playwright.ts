/**
 * COR-2255: a static HTML or SVG artifact preview makes no network request and cannot navigate.
 *
 * Every vector is proved by counting intercepted requests, never by inspecting markup. A request
 * is "intercepted" when it reaches Playwright's network interception, which is to say it would
 * have left the browser. Chromium reports a request its Content-Security-Policy refuses (an
 * `@import`, a CSS `url()`, a font) as an attempt that then fails with `csp`, before any network
 * interception; those are asserted as refusals, not counted as traffic. The chat
 * fixture exposes `corvidaeChatHarnessOpenArtifactPreview`, which mounts the production
 * `ArtifactViewer` (the same sandboxed `srcdoc` frame the transcript panel uses) with whatever
 * untrusted source a test supplies. A control frame built without the policy proves the
 * interceptor would see a request if one were made.
 */
import { expect, test, type FrameLocator, type Page } from '@playwright/test';
import { PNG } from 'pngjs';
import { fixtureRoute } from './editor-fixture.ts';

type PreviewType = 'html' | 'svg';

const PROBE_PATH = '__artifact-probe';
const CROSS_ORIGIN_HOST = 'artifact-probe.invalid';
const PREVIEW = '[data-testid="artifact-preview-probe"] iframe';

type ProbePage = {
  /** Requests that reached the network layer, where the interceptor answers them. Must stay empty. */
  requests: string[];
  /** Requests the page started, including those the browser refused before the network. */
  attempts: string[];
  /** How each failed attempt failed, by URL. */
  failures: Map<string, string>;
  origin: string;
};

const isProbeUrl = (url: string) => url.includes(PROBE_PATH) || url.includes(CROSS_ORIGIN_HOST);

/** Opens the chat fixture and answers every probe URL locally. Nothing leaves the machine. */
async function openProbePage(page: Page): Promise<ProbePage> {
  const probe: ProbePage = { requests: [], attempts: [], failures: new Map(), origin: '' };
  await page.route(new RegExp(`${PROBE_PATH}|${CROSS_ORIGIN_HOST}`), (route) => {
    probe.requests.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/plain', body: '' });
  });
  page.on('request', (request) => {
    if (isProbeUrl(request.url())) probe.attempts.push(request.url());
  });
  page.on('requestfailed', (request) => {
    if (isProbeUrl(request.url())) {
      probe.failures.set(request.url(), request.failure()?.errorText ?? '');
    }
  });
  await page.goto(fixtureRoute('chat'), { waitUntil: 'load' });
  await page.waitForFunction(
    () =>
      typeof (window as { corvidaeChatHarnessOpenArtifactPreview?: unknown })
        .corvidaeChatHarnessOpenArtifactPreview === 'function',
  );
  probe.origin = new URL(page.url()).origin;
  return probe;
}

/** The preview made no request that reached the network; anything it tried, the policy refused. */
function expectInert(probe: ProbePage, exempt = ''): void {
  const counted = (urls: string[]) => urls.filter((url) => exempt === '' || !url.includes(exempt));
  expect(counted(probe.requests)).toEqual([]);
  for (const url of counted(probe.attempts)) {
    expect(probe.failures.get(url), `${url} must be refused by the policy`).toBe('csp');
  }
}

async function openPreview(page: Page, type: PreviewType, content: string): Promise<FrameLocator> {
  await page.evaluate(
    ([nextType, nextContent]) => {
      const harnessWindow = window as unknown as {
        corvidaeChatHarnessOpenArtifactPreview: (type: string, content: string) => void;
      };
      harnessWindow.corvidaeChatHarnessOpenArtifactPreview(nextType!, nextContent!);
    },
    [type, content],
  );
  return page.frameLocator(PREVIEW);
}

/** Resolves once the preview document, its fonts and every subresource it asked for have settled. */
async function settled(page: Page, token: string): Promise<FrameLocator> {
  const frame = page.frameLocator(PREVIEW);
  await expect(frame.locator('#ready')).toHaveText(token);
  const contentFrame = await page
    .locator(PREVIEW)
    .elementHandle()
    .then((h) => h?.contentFrame());
  if (contentFrame === null || contentFrame === undefined) throw new Error('No preview frame.');
  await contentFrame.waitForLoadState('load');
  await contentFrame.evaluate(() => document.fonts.ready.then(() => undefined));
  return frame;
}

/**
 * A frame with no policy at all, built like the production one. If the interceptor works, this
 * frame is seen requesting; it is the control every zero below is measured against. Scripts are
 * allowed in a refresh control, because Chromium refuses a meta refresh in a frame that has none.
 */
async function requestsFromUnprotectedFrame(
  page: Page,
  probe: ProbePage,
  markup: string,
  marker: string,
  sandbox = '',
): Promise<void> {
  await page.evaluate(
    ([srcdoc, sandboxFlags]) => {
      const frame = document.createElement('iframe');
      frame.setAttribute('sandbox', sandboxFlags!);
      frame.srcdoc = srcdoc!;
      document.body.append(frame);
    },
    [markup, sandbox],
  );
  await expect
    .poll(() => probe.requests.filter((url) => url.includes(marker)).length)
    .toBeGreaterThan(0);
}

type Vector = { kind: string; html: (url: string) => string; svg: (url: string) => string };

const VECTORS: Vector[] = [
  {
    kind: 'image',
    html: (url) => `<img src="${url}" alt="remote image"><p>x</p>`,
    svg: (url) => `<image href="${url}" width="10" height="10"/>`,
  },
  {
    kind: 'css-import',
    html: (url) => `<style>@import url("${url}");</style><p>x</p>`,
    svg: (url) => `<style>@import url("${url}");</style><rect width="4" height="4"/>`,
  },
  {
    kind: 'css-background',
    html: (url) => `<p style="background:url('${url}');width:4rem;height:2rem">x</p>`,
    svg: (url) => `<rect width="4" height="4" style="fill:url('${url}')"/>`,
  },
  {
    kind: 'font',
    html: (url) =>
      `<style>@font-face{font-family:probe;src:url("${url}")}body{font-family:probe}</style><p>x</p>`,
    svg: (url) =>
      `<style>@font-face{font-family:probe;src:url("${url}")}text{font-family:probe}</style><text y="10">x</text>`,
  },
  {
    kind: 'svg-image',
    html: (url) => `<svg width="10" height="10"><image href="${url}"/></svg><p>x</p>`,
    svg: (url) => `<use href="${url}#shape"/><image xlink:href="${url}"/>`,
  },
  {
    kind: 'nested-frame',
    html: (url) =>
      `<iframe src="${url}"></iframe><object data="${url}"></object><embed src="${url}"><p>x</p>`,
    svg: (url) =>
      `<foreignObject width="10" height="10"><iframe xmlns="http://www.w3.org/1999/xhtml" src="${url}"></iframe></foreignObject>`,
  },
];

function documentFor(type: PreviewType, body: string, token: string): string {
  return type === 'html'
    ? `<!DOCTYPE html><html><head><title>probe</title></head><body>${body}<p id="ready">${token}</p></body></html>`
    : `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="40" height="40">${body}<text id="ready" x="0" y="30">${token}</text></svg>`;
}

test.describe('static artifact previews are network-inert', () => {
  test('a control frame without the policy is seen requesting, so a zero is meaningful', async ({
    page,
  }) => {
    const probe = await openProbePage(page);
    const { origin } = probe;
    await requestsFromUnprotectedFrame(
      page,
      probe,
      `<img src="${origin}/${PROBE_PATH}/control-image">`,
      'control-image',
    );
    await requestsFromUnprotectedFrame(
      page,
      probe,
      `<iframe src="https://${CROSS_ORIGIN_HOST}/control-frame"></iframe>`,
      'control-frame',
    );
    await requestsFromUnprotectedFrame(
      page,
      probe,
      `<style>@import url("${PROBE_PATH}/control-import");</style>`,
      'control-import',
    );
  });

  test('image, CSS, font, SVG image and nested frame make zero requests from HTML and SVG over every origin kind', async ({
    page,
  }) => {
    const probe = await openProbePage(page);
    const { origin } = probe;
    const targets = [
      ['cross-origin', `https://${CROSS_ORIGIN_HOST}/${PROBE_PATH}/`],
      ['same-origin', `${origin}/${PROBE_PATH}/`],
      ['relative', `${PROBE_PATH}/`],
      ['root-relative', `/${PROBE_PATH}/`],
      ['protocol-relative', `//${CROSS_ORIGIN_HOST}/${PROBE_PATH}/`],
    ] as const;
    let combination = 0;
    for (const type of ['html', 'svg'] as const) {
      for (const vector of VECTORS) {
        for (const [originKind, prefix] of targets) {
          combination += 1;
          const token = `combination-${combination}`;
          const url = `${prefix}${type}-${vector.kind}-${originKind}`;
          await openPreview(page, type, documentFor(type, vector[type](url), token));
          await settled(page, token);
        }
      }
    }
    expect(combination).toBe(2 * VECTORS.length * targets.length);
    expectInert(probe);
  });

  test('data: and blob: subresources are refused', async ({ page }) => {
    const probe = await openProbePage(page);
    const refusals: string[] = [];
    page.on('console', (message) => {
      const text = message.text();
      if (text.includes('Content Security Policy') || text.includes('Not allowed to load local')) {
        refusals.push(text);
      }
    });
    const shape = `<svg xmlns='http://www.w3.org/2000/svg' width='4' height='4'><rect width='4' height='4'/></svg>`;
    const blobUrl = await page.evaluate(
      (svg) => URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' })),
      shape,
    );
    const dataUrl = `data:image/svg+xml,${encodeURIComponent(shape)}`;
    for (const [index, url] of [dataUrl, blobUrl].entries()) {
      const label = url.slice(0, url.indexOf(':'));
      const html = `<img src="${url}"><iframe src="${url}"></iframe><svg><image href="${url}"/></svg><style>@import url("${url}");p{background:url("${url}")}@font-face{font-family:p;src:url("${url}")}</style><p style="font-family:p">x</p>`;
      const token = `${label}-html-${index}`;
      await openPreview(page, 'html', documentFor('html', html, token));
      const frame = await settled(page, token);
      // The elements that exist only to load a subresource are gone; nothing rendered one.
      await expect(frame.locator('img, iframe, image')).toHaveCount(0);
      await openPreview(
        page,
        'svg',
        documentFor(
          'svg',
          `<image href="${url}"/><style>@import url("${url}");</style>`,
          `${label}-svg-${index}`,
        ),
      );
      await settled(page, `${label}-svg-${index}`);
    }
    // The CSS paths are refused: data: by the policy, and blob: by the browser, which will not
    // hand another origin's blob to a sandboxed frame (the policy would refuse it as well).
    expect(
      refusals.some((text) => text.includes('Content Security Policy') && text.includes("'data:")),
    ).toBe(true);
    expect(refusals.some((text) => text.includes('blob:'))).toBe(true);
    expectInert(probe);
  });

  test('local SVG fragment references, inline styles and static text still render; scripts stay off', async ({
    page,
  }) => {
    await openProbePage(page);
    const html = `<!DOCTYPE html><html><head><style>.fancy{color:rgb(200,0,0)}</style></head><body>
      <h1 class="fancy">Static heading</h1>
      <p style="font-weight:700">Inline styled text</p>
      <svg width="60" height="20" viewBox="0 0 60 20">
        <defs><rect id="shape" width="20" height="20" fill="rgb(0,0,200)"/></defs>
        <use id="copy" href="#shape" x="30"/>
        <path d="M0 0L10 10" stroke="black"/>
      </svg>
      <script>document.body.dataset.scriptRan = 'yes'; document.getElementById('ready').textContent = 'script';</script>
      <p id="ready">rendered</p></body></html>`;
    const frame = await openPreview(page, 'html', html);
    await settled(page, 'rendered');
    await expect(frame.getByRole('heading', { name: 'Static heading' })).toHaveCSS(
      'color',
      'rgb(200, 0, 0)',
    );
    await expect(frame.getByText('Inline styled text')).toHaveCSS('font-weight', '700');
    const copy = await frame.locator('#copy').boundingBox();
    expect(copy?.width).toBeGreaterThan(0);
    await expect(frame.locator('body')).not.toHaveAttribute('data-script-ran', /.*/);
    await expect(page.locator(PREVIEW)).toHaveAttribute('sandbox', '');

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><defs><circle id="dot" cx="10" cy="10" r="8" fill="rgb(0,128,0)"/></defs><use id="copy" href="#dot" x="40"/><text id="ready" x="0" y="38">vector</text></svg>`;
    const svgFrame = await openPreview(page, 'svg', svg);
    await settled(page, 'vector');
    const vectorCopy = await svgFrame.locator('#copy').boundingBox();
    expect(vectorCopy?.width).toBeGreaterThan(0);
  });

  test('paint servers, clips and filters that reference the same document still render, without a request', async ({
    page,
  }) => {
    const probe = await openProbePage(page);
    const fromPreview: string[] = [];
    const policyMessages: string[] = [];
    page.on('request', (request) => {
      if (request.frame().url() === 'about:srcdoc') fromPreview.push(request.url());
    });
    page.on('console', (message) => {
      if (message.text().includes('Content Security Policy')) policyMessages.push(message.text());
    });
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="40">
      <defs>
        <linearGradient id="gradient"><stop offset="0" stop-color="rgb(255,0,0)"/><stop offset="1" stop-color="rgb(0,0,255)"/></linearGradient>
        <clipPath id="clip"><rect width="100" height="40"/></clipPath>
        <filter id="shade"><feOffset dx="0" dy="0"/></filter>
      </defs>
      <rect id="paint" width="100" height="40" fill="url(#gradient)" clip-path="url(#clip)" filter="url(#shade)"/>
      <text id="ready" x="2" y="12">paint</text></svg>`;
    const frame = await openPreview(page, 'svg', svg);
    await settled(page, 'paint');
    await page.locator(PREVIEW).scrollIntoViewIfNeeded();
    const box = await frame.locator('#paint').boundingBox();
    if (box === null) throw new Error('The painted rectangle has no box.');
    const image = PNG.sync.read(await page.screenshot({ clip: box }));
    const pixel = (x: number, y: number) => {
      const offset = (image.width * y + x) * 4;
      return { red: image.data[offset]!, blue: image.data[offset + 2]! };
    };
    expect(pixel(3, 30).red).toBeGreaterThan(200);
    expect(pixel(image.width - 4, 30).blue).toBeGreaterThan(200);
    expect(fromPreview).toEqual([]);
    expect(policyMessages).toEqual([]);
    expectInert(probe);
  });

  test('authored links keep their text but are inert, and refresh directives are ignored', async ({
    page,
  }) => {
    const probe = await openProbePage(page);
    const { origin } = probe;
    const popups: string[] = [];
    page.context().on('page', (popup) => popups.push(popup.url()));
    const notices = page.locator('[role="status"], [role="alert"], [role="dialog"]');
    const noticesBefore = await notices.count();

    const links = [
      ['cross-origin', `https://${CROSS_ORIGIN_HOST}/${PROBE_PATH}/link-cross`],
      ['same-origin', `${origin}/${PROBE_PATH}/link-same`],
      ['relative', `${PROBE_PATH}/link-relative`],
    ] as const;
    // Each origin kind twice: with a new-tab target, and with none, which would navigate the frame.
    const anchors = links
      .flatMap(([name, url]) => [
        `<a id="${name}-tab" href="${url}-tab" target="_blank">${name} tab link</a>`,
        `<a id="${name}-frame" href="${url}-frame">${name} frame link</a>`,
      ])
      .join(' ');
    const html = `<!DOCTYPE html><html><head>
      <meta http-equiv="refresh" content="0;url=${origin}/${PROBE_PATH}/refresh-now">
      <meta http-equiv="Refresh" content="1;url=${PROBE_PATH}/refresh-later">
      </head><body>${anchors}<svg width="80" height="20"><a id="vector" href="https://${CROSS_ORIGIN_HOST}/${PROBE_PATH}/link-vector"><text id="vector-text" y="12">vector link</text></a></svg>
      <p id="ready">links</p></body></html>`;
    const frame = await openPreview(page, 'html', html);
    await settled(page, 'links');
    const previewFrame = async () =>
      page
        .locator(PREVIEW)
        .elementHandle()
        .then((handle) => handle?.contentFrame());

    // Activate every authored link. Clicks are real: Playwright waits for any navigation they start.
    for (const [name] of links) {
      for (const kind of ['tab', 'frame']) {
        await frame.locator(`#${name}-${kind}`).click();
      }
    }
    await frame.locator('#vector-text').click();

    // Control: the same anchor in a frame with no policy navigates, and the interceptor sees it.
    await page.evaluate((srcdoc) => {
      const control = document.createElement('iframe');
      control.id = 'link-control';
      control.setAttribute('sandbox', '');
      control.srcdoc = srcdoc;
      document.body.append(control);
    }, `<a id="go" href="${PROBE_PATH}/control-link">Go</a>`);
    await page.frameLocator('#link-control').locator('#go').click();
    await expect
      .poll(() => probe.requests.filter((url) => url.includes('control-link')).length)
      .toBeGreaterThan(0);

    // The control's one-second refresh fires after the preview's would have, so once the control
    // has requested, the preview has had every chance to follow its own refresh and did not.
    await requestsFromUnprotectedFrame(
      page,
      probe,
      `<meta http-equiv="refresh" content="1;url=${PROBE_PATH}/control-refresh">`,
      'control-refresh',
      'allow-scripts',
    );
    expectInert(probe, 'control-');
    const currentFrame = await previewFrame();
    expect(currentFrame?.url()).toBe('about:srcdoc');
    expect(popups).toEqual([]);
    expect(await notices.count()).toBe(noticesBefore);
    expect(new URL(page.url()).origin).toBe(origin);

    // The links still read, and none of them carries a target.
    for (const [name] of links) {
      for (const kind of ['tab', 'frame']) {
        await expect(frame.locator(`#${name}-${kind}`)).toHaveText(`${name} ${kind} link`);
        await expect(frame.locator(`#${name}-${kind}`)).not.toHaveAttribute('href', /.*/);
      }
    }
    await expect(frame.getByText('vector link')).toBeVisible();
  });

  test('markup inside the artifact cannot relax the policy with its own policy, base or refresh', async ({
    page,
  }) => {
    const probe = await openProbePage(page);
    const { origin } = probe;
    const html = `<!DOCTYPE html><html><head>
      <meta http-equiv="Content-Security-Policy" content="default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; img-src *; frame-src *; font-src *; style-src * 'unsafe-inline'">
      <base href="https://${CROSS_ORIGIN_HOST}/${PROBE_PATH}/base/" target="_blank">
      <meta http-equiv="refresh" content="0;url=https://${CROSS_ORIGIN_HOST}/${PROBE_PATH}/adversarial-refresh">
      <link rel="stylesheet" href="${PROBE_PATH}/adversarial.css">
      <style>@import url("${PROBE_PATH}/adversarial-import.css");@font-face{font-family:a;src:url("${PROBE_PATH}/adversarial.woff2")}body{font-family:a}</style>
      </head><body>
      <img src="${PROBE_PATH}/adversarial.png"><iframe src="${PROBE_PATH}/adversarial-frame.html"></iframe>
      <img src="${origin}/${PROBE_PATH}/adversarial-same.png">
      <meta http-equiv="Content-Security-Policy" content="default-src *">
      <a id="link" href="${PROBE_PATH}/adversarial-link">Adversarial link</a>
      <p id="ready">adversarial</p></body></html>`;
    const frame = await openPreview(page, 'html', html);
    await settled(page, 'adversarial');
    await frame.locator('#link').click();
    await requestsFromUnprotectedFrame(
      page,
      probe,
      `<meta http-equiv="refresh" content="1;url=${PROBE_PATH}/control-adversarial">`,
      'control-adversarial',
      'allow-scripts',
    );
    expectInert(probe, 'control-adversarial');
  });
});
