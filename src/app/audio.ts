// SPDX-License-Identifier: AGPL-3.0-or-later
// Plays card audio in the app frame (not the sandboxed card frame), where taps
// on the card or answer buttons count as user activation for autoplay.

import type { AvTag } from "../anki/template/render";
import type { MediaStore } from "../storage/media";

const MIME: Record<string, string> = {
  mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg",
  wav: "audio/wav", flac: "audio/flac", webm: "audio/webm", mp4: "video/mp4", spx: "audio/ogg",
};

export class AudioPlayer {
  private current: HTMLAudioElement | null = null;
  private url: string | null = null;
  private generation = 0;

  constructor(private readonly media: MediaStore) {}

  stop(): void {
    this.generation++;
    if (this.current) {
      this.current.pause();
      this.current = null;
    }
    if (this.url) {
      URL.revokeObjectURL(this.url);
      this.url = null;
    }
    try {
      speechSynthesis?.cancel();
    } catch {
      // not supported
    }
  }

  /** Play tags in order (autoplay), or a single tag (replay button). */
  async play(tags: readonly AvTag[]): Promise<void> {
    this.stop();
    const gen = this.generation;
    for (const tag of tags) {
      if (gen !== this.generation) return;
      try {
        if (tag.kind === "tts") await this.speak(tag.text, tag.lang, gen);
        else await this.playFile(tag.filename, gen);
      } catch {
        // Missing or undecodable media: skip to the next tag.
      }
    }
  }

  private async playFile(filename: string, gen: number): Promise<void> {
    const blob = await this.media.get(filename);
    if (!blob || gen !== this.generation) return;
    const ext = filename.split(".").pop()?.toLowerCase() ?? "";
    const typed = blob.type ? blob : new Blob([blob], { type: MIME[ext] ?? "" });
    const url = URL.createObjectURL(typed);
    this.url = url;
    const audio = new Audio(url);
    this.current = audio;
    await new Promise<void>((resolve) => {
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
      audio.play().catch(() => resolve());
    });
  }

  private speak(text: string, lang: string, gen: number): Promise<void> {
    return new Promise((resolve) => {
      if (typeof speechSynthesis === "undefined" || gen !== this.generation) return resolve();
      const plain = text.replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ");
      const u = new SpeechSynthesisUtterance(plain);
      const tag = lang.split(/\s+/)[0]?.replace("_", "-");
      if (tag) u.lang = tag;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      speechSynthesis.speak(u);
    });
  }
}
