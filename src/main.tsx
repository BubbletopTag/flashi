// SPDX-License-Identifier: AGPL-3.0-or-later
import { render } from "preact";
import "@fontsource/roboto/latin-400.css";
import "@fontsource/roboto/latin-500.css";
import "@fontsource/roboto/latin-700.css";
import "./theme/tokens.flashi.css";
import "./theme/tokens.dark.css";
import "./theme/base.css";
import { App } from "./app/App";
import { AppController } from "./app/controller";
import { applyAppearance } from "./theme/appearance";

applyAppearance("system");

async function start(): Promise<void> {
  const root = document.getElementById("app")!;
  if (__FLASHI_GOLDEN__ && new URLSearchParams(location.search).get("theme") === "golden") {
    await import("./theme/tokens.golden.css");
    document.documentElement.dataset.theme = "golden";
  }
  try {
    const app = __FLASHI_GOLDEN__ && new URLSearchParams(location.search).get("fixture") === "golden"
      ? await (await import("./app/golden")).goldenApp()
      : await AppController.boot();
    const updateAppearance = () => applyAppearance(app.prefs().appearance);
    updateAppearance();
    app.subscribe(updateAppearance);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { updateAppearance(); app.notify(); });
    root.textContent = "";
    render(<App app={app} />, root);
  } catch (e) {
    root.innerHTML = "";
    const p = document.createElement("p");
    p.className = "loading";
    p.textContent = `Flashi couldn't start: ${e instanceof Error ? e.message : String(e)}`;
    root.appendChild(p);
  }
}

// The SAH pool and the in-memory study queues each have one writer per origin.
// Keep a Web Lock for this page's lifetime so a second tab cannot overwrite work.
if (navigator.locks) {
  void navigator.locks.request("flashi-collection-writer", { ifAvailable: true }, async (lock) => {
    if (!lock) {
      document.querySelector("#app")!.textContent = "Flashi is already open in another tab. Close that tab, then reload here to study.";
      return;
    }
    await start();
    await new Promise<void>(() => {});
  });
} else void start();
