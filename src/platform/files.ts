// SPDX-License-Identifier: AGPL-3.0-or-later
// Saving files. Inside a claude.ai artifact, downloads go through the
// `downloads` capability (the sandbox blocks <a download>), whose allowlist
// has no .apkg, so artifact exports are .zip files, which Anki desktop's
// importer accepts as packages. Everywhere else, a plain <a download> link.

interface DownloadsCapability {
  save(req: { filename: string; data: Blob }): Promise<{ status: string }>;
}

interface ClaudeRuntime {
  use(name: string): Promise<unknown>;
}

function claudeRuntime(): ClaudeRuntime | null {
  const c = (globalThis as { claude?: ClaudeRuntime }).claude;
  return c && typeof c.use === "function" ? c : null;
}

let downloadsPromise: Promise<DownloadsCapability | null> | null = null;

function downloads(): Promise<DownloadsCapability | null> {
  downloadsPromise ??= (async () => {
    const runtime = claudeRuntime();
    if (!runtime) return null;
    try {
      return ((await runtime.use("downloads")) as DownloadsCapability | null) ?? null;
    } catch {
      return null;
    }
  })();
  return downloadsPromise;
}

export function backupFilename(date = new Date()): string {
  const stamp = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  return `Flashi backup ${stamp}`;
}

export type SaveOutcome = "saved" | "declined" | "unavailable";

/** Offer `blob` to the user as a file. `baseName` has no extension. */
export async function saveFile(blob: Blob, baseName: string): Promise<{ outcome: SaveOutcome; filename: string }> {
  const capability = await downloads();
  if (capability) {
    const filename = `${baseName}.zip`;
    try {
      await capability.save({ filename, data: blob });
      return { outcome: "saved", filename };
    } catch (e) {
      const code = (e as { code?: string })?.code;
      return { outcome: code === "declined" ? "declined" : "unavailable", filename };
    }
  }
  const filename = `${baseName}.apkg`;
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return { outcome: "saved", filename };
  } catch {
    return { outcome: "unavailable", filename };
  }
}
