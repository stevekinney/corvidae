import assert from 'node:assert/strict';
import { request } from 'node:https';
import { test } from 'node:test';

import { hostContract } from './host-contract.ts';
import { serve } from './index.ts';

hostContract('Node host', serve);

void test('Node host gives exact and parameter routes precedence over wildcards', async () => {
  const host = serve({
    port: 0,
    fetch: () => new Response('fallback'),
    routes: {
      '/reports/*': () => new Response('wildcard'),
      '/reports/:id': (request) => new Response(`parameter:${request.params['id']}`),
      '/reports/top': new Response('exact'),
      '/uploads': { POST: new Response('created', { status: 201 }) },
    },
  });
  try {
    await host.ready;
    const exact = await fetch(new URL('/reports/top', host.url));
    assert.equal(await exact.text(), 'exact');
    const parameter = await fetch(new URL('/reports/Q%201', host.url));
    assert.equal(await parameter.text(), 'parameter:Q 1');
    const wildcard = await fetch(new URL('/reports/with/slash', host.url));
    assert.equal(await wildcard.text(), 'wildcard');
    const created = await fetch(new URL('/uploads', host.url), { method: 'POST' });
    assert.equal(created.status, 201);
    const fallback = await fetch(new URL('/uploads', host.url));
    assert.equal(await fallback.text(), 'fallback');
  } finally {
    host.stop(true);
  }
});

void test('Node host cancels a streamed response when its client disconnects', async () => {
  const cancelled = Promise.withResolvers<unknown>();
  const host = serve({
    port: 0,
    fetch: () =>
      new Response(
        new ReadableStream({
          cancel(reason) {
            cancelled.resolve(reason);
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      ),
  });
  try {
    await host.ready;
    const controller = new AbortController();
    const response = await fetch(host.url, { signal: controller.signal });
    assert.equal(response.status, 200);
    controller.abort();
    await cancelled.promise;
  } finally {
    host.stop(true);
  }
});

const certificate = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUOeqL3GYucCk2iEe3Fno8/vu093QwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MTEyNjEwNTk1MVoXDTI2MTEy
NzEwNTk1MVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAmpdYotPjNigsJGsyFXOmNz9XoLhXhpezLH5037o4R9+7
s57ey+cG+9ab8HyCOVA9i5GBrTjPe9I6OGyGBgg5l8l8wnNtIQHwn7NPEhVDNXMF
MCYap1uAQTUaxKewibli3XuOjLIn/3ztxDuoH9lnG9rFkLmz+GoWR+CCOoES2kmH
Ivko27l8uQIp5XE2LRrs9OD8fLNfuGMlpC9Ug0o8Oz4nbmUsRIVzFJ9uzaQekFcQ
JoOxDZ/R7fJSSCC4jH1rPqRR9P1v80uN24rWKtbkAALCKMI0H8oYi/cCmC9FmWlb
0WlC4FeZcenGpzXR4EIQv5raOpiy1Je4ybiEtIqzPQIDAQABo1MwUTAdBgNVHQ4E
FgQU+X5JjLH71kUwyXnrWHanS288OS4wHwYDVR0jBBgwFoAU+X5JjLH71kUwyXnr
WHanS288OS4wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAQZeL
jt8MqWO26/Mgr7dKq9p7Y0KHTY9NEsdK0PsnOTk8yjWX3G/u20NZPQk+o8whsjai
GHCHR/UP8EpHLN24PGIU2ucJF8QK20up7dgo1w/f11fsfd4ZBTD75iLC5nC3fkxi
ds1Xay2D7sTCPSyDWZ9Z6DuCGWW2xULfxPTpq4xRCjPWzl4gcTCSWNAtJ6wP36T2
tQ/gmTX1N9AgMPBGyRLsO66N7vaJjmWnE3l20cUh+dKSqDxX5znX9raGYJIiRdfF
oAZfcF/Fij9Gujmq5lrofZHWehMi6dIo6mkzSzp++Ue/QZbvJZJ28GHM0EIqYf2D
e13cSlnStnn9ASuNkg==
-----END CERTIFICATE-----`;

const privateKey = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCal1ii0+M2KCwk
azIVc6Y3P1eguFeGl7MsfnTfujhH37uznt7L5wb71pvwfII5UD2LkYGtOM970jo4
bIYGCDmXyXzCc20hAfCfs08SFUM1cwUwJhqnW4BBNRrEp7CJuWLde46Msif/fO3E
O6gf2Wcb2sWQubP4ahZH4II6gRLaSYci+SjbuXy5AinlcTYtGuz04Px8s1+4YyWk
L1SDSjw7PiduZSxEhXMUn27NpB6QVxAmg7ENn9Ht8lJIILiMfWs+pFH0/W/zS43b
itYq1uQAAsIowjQfyhiL9wKYL0WZaVvRaULgV5lx6canNdHgQhC/mto6mLLUl7jJ
uIS0irM9AgMBAAECggEAAtvSNkfPyrRJRXuIx6lfUf2exU75w16yLM9b1VIWvb5P
GyrqOMzZYRyei2U206nk5Kjr3ap2xikX8+vB0+iHOoQHbBS0i5wDEv9YWRL0+4Il
S7bwq3AyoEIQo1rsfBqzAtOvMHF2i6/Un8Cj3I7phec9dW5ee+hn6BIocyRO5Ao/
q+bIcr8tU84qvL8thQ8qKr6U2bO10zA3WvfwL0Vx4OvAaPrloJzD89E4vRwSn+GL
C/edVyFVhNzUr5O6XWVwpYfyvsR/DX8/sJYIzHgeCjZJqsyQnR2xT3sF4oY1KlR7
6kZN2WGKdo/yt6rpbErIAGGzke2tLCMazDrm3htCGwKBgQDSBOAaIZuvL6IJkxPB
AI8TPRvqR8XuDbfM2371LgNzU2dEL/FWbp8zav7eqhjpPcThSDE4Bg17FpzpGjPH
UC07H3nqPZLuPvn3LmcSdTBmjoTlC88ihEdlEK3NW2SodrOLkKQViejJR5Iw7Cfi
K1DnUCK2QEze+IO8iSBhqiG4WwKBgQC8b9tYIEmDeugnphjKhxYfJmgFiTLqKE4p
BrBXDPEzlpyfHOKbcn33t+mTjeZki0ufoBl1N8Kz1D0xU4XplWmiF08Ejsk+LD0P
GJd2ixqAE91pSzQ2SFLOx35ntqgUGOCPAplBbfeJ3VJ6KSVSi2P4qxSH2FG4kJYU
bonrx2ZWRwKBgQCKEQJyq1150cqomLQH0aI9d5L+dai9Uu9eEX5pGJLUIiRlQ09Z
DuhCGTjskM5Hp3/iyl7xAamjHb6Rz9PyV9ckYxD22Pva/DPAOBUyoS/sfA0JtrW5
b1SwMELSGh8WUNLAEZqNPlh22kJVPysJGIjbSGdJgQQIIUAZldxf2ETKuQKBgEy8
QFZiz4z7QA7lVLMkz51fxnx6ooE4aJvMXYMVgiO/8YfZ+23R8fouqq+r2WaYUvNt
/u/9BQy2ITU1DhNRBPM9CrCQdOMcoMDFAukDPIdrj36RYXG5gf8yvgb+GvQULV4P
cNl0Lpm1xyB4IPq8SLm68WFgdeby+irX2NJrIQGBAoGAbtOrJGsIul/izaTvDrNF
VwzEaYPsZ1LxjOKdb9hFJpNezWf3GKuq8LD5X4vJU9eCy8aNCpJ3sYtTrWkVyVJ0
a1StCpd9x5Iiz3OUEpNDRoPTfHg/mo1B3cMrJ/dj2eDpxLrKd+G3u51FBJ/QyudC
mEvPyJg55MNiZ/V46LQvxKQ=
-----END PRIVATE KEY-----`;

void test('Node host sends HTTPS Request URLs to fetch handlers', async () => {
  let seen = '';
  const host = serve({
    port: 0,
    tls: { cert: certificate, key: privateKey },
    fetch(request) {
      seen = request.url;
      return new Response('secure');
    },
  });
  try {
    await host.ready;
    await new Promise<void>((resolve, reject) => {
      const client = request(host.url, { rejectUnauthorized: false }, (response) => {
        response.resume();
        response.once('end', resolve);
      });
      client.once('error', reject);
      client.end();
    });
    assert.equal(new URL(seen).protocol, 'https:');
  } finally {
    host.stop(true);
  }
});
