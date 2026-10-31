// SPDX-License-Identifier: AGPL-3.0-or-later
// SHA-1 is an Anki media identity checksum, never a security primitive.
// The fallback keeps local HTTP/LAN imports working without Web Crypto.
export async function sha1Hex(blob: Blob): Promise<string> {
  const input = new Uint8Array(await blob.arrayBuffer());
  if (globalThis.crypto?.subtle) {
    const digest = await crypto.subtle.digest('SHA-1', input);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return sha1Fallback(input);
}
export function sha1Fallback(input: Uint8Array): string {
  const bytes = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64);
  bytes.set(input); bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(bytes.length - 8, Math.floor(input.length / 0x20000000));
  view.setUint32(bytes.length - 4, (input.length * 8) >>> 0);
  const words = new Int32Array(80);
  const hash = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const rotate = (n: number, bits: number) => (n << bits) | (n >>> (32 - bits));
  for (let block = 0; block < bytes.length; block += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getInt32(block + i * 4);
    for (let i = 16; i < 80; i++) words[i] = rotate(words[i - 3]! ^ words[i - 8]! ^ words[i - 14]! ^ words[i - 16]!, 1);
    let [a, b, c, d, e] = hash as [number, number, number, number, number];
    for (let i = 0; i < 80; i++) {
      const f = i < 20 ? (b & c) | (~b & d) : i < 40 ? b ^ c ^ d : i < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = i < 20 ? 0x5a827999 : i < 40 ? 0x6ed9eba1 : i < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const temp = (rotate(a, 5) + f + e + k + words[i]!) | 0;
      e = d; d = c; c = rotate(b, 30); b = a; a = temp;
    }
    [a, b, c, d, e].forEach((value, i) => { hash[i] = (hash[i]! + value) | 0; });
  }
  return hash.map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('');
}
