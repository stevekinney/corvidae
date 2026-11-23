import { resolve } from "node:path";
const actionModule = JSON.stringify(
  resolve(import.meta.dir, "../../../src/actions/server.ts"),
);
/** Real application consumers; separate files keep each generated contract independently observable. */
export const consumerFixtures: Record<string, string> = {
  "app.d.ts": `declare global { interface VelveteenLocals { user?: { id: string; role: 'admin' | 'member' }; requestId: string; } } export {};`,
  "hooks.ts": `import type { RequestEvent, ServerHooks } from ${JSON.stringify(resolve(import.meta.dir, "../../../src/server/types.ts"))}; export const empty: RequestEvent['locals'] = {}; export const handle = (({event, resolve}) => { const user = event.locals.user; if (user) { const id: string = user.id; const role: 'admin' | 'member' = user.role; event.locals.requestId = id + role; } return resolve(event); }) satisfies NonNullable<ServerHooks['handle']>;`,
  "request-event.ts": `import { getRequestEvent } from ${JSON.stringify(resolve(import.meta.dir, "../../../src/server/context.ts"))}; export function requestIdentity() { const { locals } = getRequestEvent(); if (!locals.user) return undefined; const id: string = locals.user.id; return id; }`,
  "remote.ts": `import { defineRemote } from ${JSON.stringify(resolve(import.meta.dir, "../../../src/remote/server.ts"))}; export const remote = defineRemote({ kind: 'query', validate: (value: unknown) => value, handle: (_input, event) => event.locals.requestId });`,
  "actions/[id]/+page.server.ts": `import {fail} from ${actionModule};import type {Actions} from './$types';export const actions={save:async({params,request,cookies,locals})=>{cookies.set('session','value',{path:'/'});void locals.requestId;const data=await request.formData();if(!data.get('name'))return fail(422,{kind:'failure' as const,missing:'name' as const});return {kind:'success' as const,id:params.id};}} satisfies Actions;`,
  "actions/[id]/+page.svelte": `<script lang="ts">import type {PageProps} from './$types';let {form}:PageProps=$props();</script>{#if form?.kind==='failure'}<p>{form.missing}</p>{:else if form?.kind==='success'}<p>{form.id}</p>{/if}`,
  "actions/[id]/assert-actions.ts": `import type {ActionData} from './$types';export const failure:ActionData={kind:'failure',missing:'name'};export const success:ActionData={kind:'success',id:'id'};`,
  "+layout.server.ts": `import type { LayoutServerLoad } from './$types';
export const load = (() => ({ sessionId: 'session' as const, level: 1 as const })) satisfies LayoutServerLoad;`,
  "+layout.ts": `import type { LayoutLoad } from './$types';
export const load = (({ data, params }) => ({ ...data, root: 'root' as const, optionalSlug: params.slug?.toUpperCase() })) satisfies LayoutLoad;`,
  "+layout.svelte": `<script lang="ts">import type { LayoutProps } from './$types'; let { data, children }: LayoutProps = $props();</script><span>{data.root}{data.sessionId}</span>{@render children()}`,
  "+page.ts": `import type { PageLoad } from './$types'; export const load = (() => ({ title: 'title' as const })) satisfies PageLoad;`,
  "+page.svelte": `<script lang="ts">import type { PageProps } from './$types'; let { data }: PageProps = $props();</script><h1>{data.title}{data.sessionId}</h1>`,
  "blog/+layout.server.ts": `import type { LayoutServerLoad } from './$types';
export const load = (async ({ parent, request, url }) => { const inherited = await parent(); const exact: 1 = inherited.level; return { blog: 'blog' as const, level: 'blog' as const, serverParent: exact, method: request.method, path: url.pathname }; }) satisfies LayoutServerLoad;`,
  "blog/+layout.ts": `import type { LayoutLoad } from './$types';
export const load = (async ({ parent, data }) => { const inherited = await parent(); const root: 'root' = inherited.root; return { ...data, universalParent: root }; }) satisfies LayoutLoad;`,
  "blog/[slug]/+page.server.ts": `import type { PageServerLoad } from './$types';
export const load = (async ({ params, parent, cookies, depends, untrack, signal }) => { cookies.set("session", "value", {path:"/"}); depends("app:session"); untrack(()=>params.slug); signal.throwIfAborted(); const inherited = await parent(); const level: 'blog' = inherited.level; return { slug: params.slug, serverValue: 42 as const, serverParent: level }; }) satisfies PageServerLoad;`,
  "blog/[slug]/+page.ts": `import type { PageLoad } from './$types';
export const load = (async ({ params, data, parent, fetch, url, depends, untrack, signal }) => { depends("app:page"); untrack(()=>params.slug); signal.throwIfAborted(); const inherited = await parent(); const level: 'blog' = inherited.level; const value: 42 = data.serverValue; const network: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch; return { slug: params.slug, value, level, hasFetch: !!network, path: url.pathname }; }) satisfies PageLoad;`,
  "blog/[slug]/+page.svelte": `<script lang="ts">import type { PageProps } from './$types'; let { data, params }: PageProps = $props();</script><p>{data.slug}{params.slug}</p>`,
  "blog/[slug]/assert-data.ts": `import type { PageData } from './$types';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
export const level: Equal<PageData['level'], 'blog'> = true;
export const value: Equal<PageData['value'], 42> = true;
export const discardedServerValue: Equal<'serverValue' extends keyof PageData ? true : false, false> = true;`,
  "layout-only/+layout.server.ts": `import type { LayoutServerLoad } from './$types'; export const load = (() => ({ shell: 'shell' as const })) satisfies LayoutServerLoad;`,
  "layout-only/deep/+page.ts": `import type { PageLoad } from './$types'; export const load = (async ({parent}) => { const data = await parent(); const shell: 'shell' = data.shell; return { shell }; }) satisfies PageLoad;`,
  "reset/+layout.ts":
    "export const load = () => ({ skipped: 'skipped' as const });",
  "reset/leaf/+layout.ts":
    "export const load = () => ({ local: 'local' as const });",
  "reset/leaf/+page@.svelte": "<h1>Reset leaf</h1>",
  "reset/leaf/assert-inheritance.ts": `import type { LayoutParentData, PageData, PageLoad } from './$types';
export const retained: PageData['root'] = 'root';
export const layoutStillInherits: LayoutParentData['skipped'] = 'skipped';
export const load = (async ({ parent }) => { const root: 'root' = (await parent()).root; return { root }; }) satisfies PageLoad;`,
  "api/+page.server.ts": `import type { PageServerLoad } from './$types'; export const load = (() => ({ ownPage: 7 as const })) satisfies PageServerLoad;`,
  "api/+page.svelte": `<script lang="ts">import type { PageProps } from './$types'; let { data }: PageProps = $props();</script><p>{data.ownPage}</p>`,
  "api/+server.ts": `import type { RequestHandler } from './$types'; export const GET = (({request,url,locals}) => new Response(request.method + url.pathname + (locals.requestId ?? ''))) satisfies RequestHandler;`,
  "config/+page.ts": "export const prerender = true;",
  "config/+page.server.ts": `export const load = () => ({ fallback: 'retained' as const });`,
  "config/assert-data.ts": `import type { PageData } from './$types'; export const value: PageData['fallback'] = 'retained';`,
  "optional/[[lang]]/+page.ts": `import type { PageLoad } from './$types'; export const load = (({params}) => ({language: params.lang?.toUpperCase()})) satisfies PageLoad;`,
  "files/[...path]/+page.ts": `import type { PageLoad } from './$types'; export const load = (({params}) => ({file: params.path.toUpperCase()})) satisfies PageLoad;`,
  "escapes/a[x+23]b/[id]/+page.ts": `import type { PageLoad } from './$types'; export const load = (({ params, route }) => { const id: '/escapes/a[x+23]b/[id]' = route.id; return { route: id, value: params.id.toUpperCase() }; }) satisfies PageLoad;`,
  "assert-routes.ts": `import type { RouteId, RouteParams } from '../types/index';
export const route: RouteId = '/blog/[slug]';
export const params: RouteParams<'/blog/[slug]'> = {slug: 'hello'};
export const optional: RouteParams<'/optional/[[lang]]'> = {};
export const rest: RouteParams<'/files/[...path]'> = {path: ''};
export const escaped: RouteParams<'/escapes/a[x+23]b/[id]'> = {id: '[x+2f]'};`,
  "typed/+layout.ts": `import type { LayoutLoad } from './$types'; export const load = (({params}) => { const amount: string | number | undefined = params.amount; return { amount }; }) satisfies LayoutLoad;`,
  "typed/assert-params.ts": `import type { LayoutParams } from './$types';
export const numeric: LayoutParams['amount'] = 0;
export const fallback: LayoutParams['amount'] = 'other';`,
  "typed/[amount]/+page.ts": "export const load = () => ({});",
  "typed/[amount=integer]/+page.server.ts": `import type { PageServerLoad, Actions } from './$types';
export const load = (({params}) => ({ rounded: params.amount.toFixed(0) })) satisfies PageServerLoad;
export const actions = { default: ({params}) => ({ next: params.amount + 1 }) } satisfies Actions;`,
  "typed/[amount=integer]/+page.svelte": `<script lang="ts">import type {PageProps} from './$types';let {params}:PageProps=$props();</script><h1>{params.amount.toFixed(0)}</h1>`,
  "large/[id=large-id]/+server.ts": `import type { RequestHandler } from './$types'; export const GET = (({params}) => new Response(String(params.id + 1n))) satisfies RequestHandler;`,
  "flags/[value=flag]/+page.ts": `import type { PageLoad } from './$types'; export const load = (({params}) => { const value: boolean = params.value; return { value }; }) satisfies PageLoad;`,
  "assert-matched-routes.ts": `import type { RouteParams } from '../types/index'; export const exact: RouteParams<'/large/[id=large-id]'> = { id: 9007199254740993n };`,
  "manual/[[section=integer]]/[...path=path-size]/+page.ts": `import type { PageLoad } from './$types';
export const load = (({params}) => ({ section: params.section?.toFixed(), count: params.path.toFixed() })) satisfies PageLoad;`,
  "manual/[[section=integer]]/[...path=path-size]/assert-params.ts": `import type { RouteParams } from './$types';
export const empty: RouteParams = { path: 0 };
export const qualified: RouteParams = { section: 42, path: 2 };`,
};

export const invalidConsumers = [
  {
    file: "invalid-locals-missing.ts",
    code: `import { getRequestEvent } from ${JSON.stringify(resolve(import.meta.dir, "../../../src/server/context.ts"))}; export function early() { const { requestId } = getRequestEvent().locals; return requestId.toUpperCase(); }`,
    diagnostic: "TS18048",
    detail: "requestId",
  },
  {
    file: "blog/[slug]/invalid-locals.ts",
    code: `import type { PageServerLoad } from './$types'; export const load = (({locals}) => { locals.user = {id: 42, role: 'admin'}; return {}; }) satisfies PageServerLoad;`,
    diagnostic: "TS2322",
    detail: "number",
  },
  {
    file: "blog/[slug]/invalid-optional-locals.ts",
    code: `import type { PageServerLoad } from './$types'; export const load = (({locals}) => ({id: locals.user.id})) satisfies PageServerLoad;`,
    diagnostic: "TS18048",
    detail: "possibly 'undefined'",
  },
  {
    file: "escapes/a[x+23]b/[id]/invalid-escape.ts",
    code: `import type { PageLoad } from './$types'; export const load = (({params}) => params['x+23']) satisfies PageLoad;`,
    diagnostic: "TS7053",
    detail: "x+23",
  },
  {
    file: "manual/[[section=integer]]/[...path=path-size]/invalid-section.ts",
    code: `import type { PageLoad } from './$types'; export const load = (({params}) => ({ section: params.section.toFixed() })) satisfies PageLoad;`,
    diagnostic: "TS18048",
    detail: "possibly 'undefined'",
  },
  {
    file: "manual/[[section=integer]]/[...path=path-size]/invalid-rest.ts",
    code: `import type { RouteParams } from './$types'; export const invalid: RouteParams = { section: 42 };`,
    diagnostic: "TS2741",
    detail: "path",
  },
  {
    file: "typed/[amount=integer]/invalid-amount.ts",
    code: `import type { RouteParams } from './$types'; export const invalid: RouteParams = { amount: '42' };`,
    diagnostic: "TS2322",
    detail: "number",
  },
  {
    file: "reset/leaf/invalid-skipped.ts",
    code: `import type { PageLoad } from './$types'; export const load = (async ({ parent }) => ({ skipped: (await parent()).skipped })) satisfies PageLoad;`,
    diagnostic: "TS2339",
    detail: "skipped",
  },
  {
    file: "reset/leaf/invalid-local-layout.ts",
    code: `import type { PageData } from './$types'; export const local: PageData['local'] = 'local';`,
    diagnostic: "TS2339",
    detail: "local",
  },
  {
    file: "actions/[id]/invalid-action.ts",
    code: `import type {Actions} from './$types';export const actions={save:({params})=>({id:params.missing})} satisfies Actions;`,
    diagnostic: "TS2339",
    detail: "missing",
  },
  {
    file: "actions/[id]/invalid-result.ts",
    code: `import type {ActionData} from './$types';export const result:ActionData={kind:'failure',missing:42};`,
    diagnostic: "TS2322",
    detail: "number",
  },
  {
    file: "blog/[slug]/invalid-cookie.ts",
    code: `import type { PageServerLoad } from './$types'; export const load = (({cookies})=>{ cookies.set('name','value',{}); return {}; }) satisfies PageServerLoad;`,
    diagnostic: "TS2345",
    detail: "path",
  },
  {
    file: "blog/[slug]/invalid-universal-cookie.ts",
    code: `import type { PageLoad } from './$types'; export const load = ((event)=>({value:event.cookies})) satisfies PageLoad;`,
    diagnostic: "TS2339",
    detail: "cookies",
  },
  {
    file: "invalid-id.ts",
    code: `import type { RouteId } from '../types/index'; const route: RouteId = '/does-not-exist';`,
    diagnostic: "TS2322",
    detail: "/does-not-exist",
  },
  {
    file: "blog/[slug]/invalid-params.ts",
    code: `import type { RouteParams } from './$types'; const params: RouteParams = {};`,
    diagnostic: "TS2741",
    detail: "slug",
  },
  {
    file: "blog/[slug]/invalid-data.ts",
    code: `import type { PageData } from './$types'; const slug: PageData['slug'] = 1;`,
    diagnostic: "TS2322",
    detail: "number",
  },
  {
    file: "api/invalid-handler.ts",
    code: `import type { RequestHandler } from './$types'; const handler: RequestHandler = () => 'not a response';`,
    diagnostic: "TS2322",
    detail: "Response",
  },
  {
    file: "optional/[[lang]]/invalid-optional.ts",
    code: `import type { PageLoad } from './$types'; export const load = (({params}) => ({value: params.lang.toUpperCase()})) satisfies PageLoad;`,
    diagnostic: "TS18048",
    detail: "possibly 'undefined'",
  },
  {
    file: "files/[...path]/invalid-rest.ts",
    code: `import type { RouteParams } from './$types'; const params: RouteParams = {};`,
    diagnostic: "TS2741",
    detail: "path",
  },
  {
    file: "blog/invalid-parent.ts",
    code: `import type { LayoutServerLoad } from './$types'; export const load = (async ({parent}) => {const data = await parent(); return {root: data.root};}) satisfies LayoutServerLoad;`,
    diagnostic: "TS2339",
    detail: "root",
  },
] as const;
