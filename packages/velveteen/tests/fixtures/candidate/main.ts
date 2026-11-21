import { hydrate, mount } from "svelte";
import App from "./app.svelte";

const target = document.querySelector("#app")!;
if (target.hasChildNodes()) hydrate(App, { target, recover: false });
else mount(App, { target });
document.documentElement.dataset.hydrated = "true";
