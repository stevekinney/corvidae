import { render } from "svelte/server";
import App from "./app.svelte";

export function renderPage() {
  return render(App);
}
