// SPDX-License-Identifier: AGPL-3.0-or-later
import { render } from "preact";
import "./theme/tokens.flashi.css";
import "./theme/base.css";
import { App } from "./app/App";
import { AppController } from "./app/controller";

async function start(): Promise<void> {
  const root = document.getElementById("app")!;
  if (__FLASHI_GOLDEN__ && new URLSearchParams(location.search).get("theme") === "golden") {
    await import("./theme/tokens.golden.css");
    document.documentElement.dataset.theme = "golden";
  }
  try {
    const app = await AppController.boot();
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

void start();
