import { join } from "node:path";
import { readVelveteenTestEnvironment } from "../environment-configuration.ts";
import type { RuntimeBoundary } from "./runtime-fixture.ts";
export function actionFixtures(
  root: string,
  boundary: RuntimeBoundary,
): Record<string, string> {
  const errors =
    boundary === "reference"
      ? "@sveltejs/kit"
      : join(root, "src/data/errors.ts");
  const fail =
    boundary === "reference"
      ? "@sveltejs/kit"
      : join(root, "src/actions/server.ts");
  const enhance =
    boundary === "reference"
      ? `import {enhance} from '$app/forms';`
      : `import {getNavigation} from ${JSON.stringify(join(root, "src/client/navigation-context.ts"))}; const {enhance}=getNavigation();`;
  const extension = boundary === "reference" ? "js" : "ts";
  const transportValue = `import {TransportValue} from '../../lib/transport-value.${extension}';`;
  const status =
    boundary === "reference"
      ? `import {page} from '$app/state';const status=$derived(page.status);let {data,form}=$props();`
      : `let {data,form,status}=$props();`;
  const files = {
    "src/routes/actions/+page.server.ts": `${transportValue}import {fail} from ${JSON.stringify(fail)};import {redirect,error} from ${JSON.stringify(errors)};export const load=({cookies})=>({saved:cookies.get('saved')??'none'});export const actions={save:async({request,cookies})=>{const data=await request.formData();const name=String(data.get('name')??'');if(!name)return fail(422,{message:'Name required'});const file=data.get('file');cookies.set('saved',name,{path:'/'});return {message:'Saved '+name,file:file instanceof File?file.name+':'+await file.text():'none',submitter:data.get('operation'),custom:new TransportValue('Action '+name)};},redirect:()=>redirect(303,'/runtime/actions/default'),broken:()=>error(418,'Action teapot')};`,
    "src/routes/actions/+page.svelte": `<script lang="ts">${transportValue}${enhance}${status}let interaction=$state('');</script><h1>Actions</h1><p data-saved>{data.saved}</p><p data-result>{form?.message??'Empty'}</p><p data-file>{form?.file??'none'}</p><p data-submitter>{form?.submitter??'none'}</p><p data-custom-method>{form?.custom?.describe?.()??'none'}</p><p data-custom-instance>{String(form?.custom instanceof TransportValue)}</p><button type="button" data-custom-call onclick={()=>interaction=form.custom.describe()}>Use custom result</button><p data-custom-interaction>{interaction}</p><p data-status>{status}</p><form method="POST" action="?/save" enctype="multipart/form-data" use:enhance><input aria-label="Name" name="name"/><input aria-label="File" name="file" type="file"/><button name="operation" value="save">Save</button><button formaction="?/redirect">Redirect</button><button formaction="?/broken">Error</button></form>`,
    "src/routes/actions/native/+page.server.ts": `${transportValue.replace("../../lib", "../../../lib")}export const actions={default:async({request})=>({custom:new TransportValue('Action '+String((await request.formData()).get('name')??''))})};`,
    "src/routes/actions/native/+page.svelte": `<script lang="ts">${transportValue.replace("../../lib", "../../../lib")}let {form}=$props();let interaction=$state('');</script><h1>Native action submission</h1><p data-custom-method>{form?.custom?.describe?.()??'none'}</p><p data-custom-instance>{String(form?.custom instanceof TransportValue)}</p>{#if form?.custom}<button type="button" onclick={()=>interaction=form.custom.describe()}>Use custom result</button><p data-custom-interaction>{interaction}</p>{/if}<form method="POST"><input aria-label="Name" name="name"/><button>Native submit</button></form>`,
    "src/routes/actions/default/+page.server.ts": `export const actions={default:async({request})=>({message:'Default '+(await request.formData()).get('name')})};`,
    "src/routes/actions/default/+page.svelte": `<script>${enhance}let {form}=$props();</script><h1>Default action</h1><p data-result>{form?.message??'Empty'}</p><form method="POST" use:enhance><input aria-label="Name" name="name"/><button>Submit</button><button formaction="/runtime/actions?/save" name="operation" value="cross">Cross-page</button></form>`,
    "src/routes/actions/+server.ts": `export const POST=()=>new Response('Endpoint POST');`,
  };
  if (boundary === "candidate" && readVelveteenTestEnvironment().actionCorrupt)
    files["src/routes/actions/+page.server.ts"] = files[
      "src/routes/actions/+page.server.ts"
    ].replace("message:'Saved '", "message:'Wrong '");
  return files;
}
