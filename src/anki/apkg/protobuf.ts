// SPDX-License-Identifier: AGPL-3.0-or-later
// A minimal protobuf wire-format reader, enough to decode the handful of
// Anki messages stored in schema-18 collections and new-style packages
// (field numbers from Anki's proto/anki/*.proto).

const utf8 = new TextDecoder();

type WireValue = { wire: 0; v: bigint } | { wire: 1; v: Uint8Array } | { wire: 2; v: Uint8Array } | { wire: 5; v: Uint8Array };

export class ProtoMessage {
  private readonly fields = new Map<number, WireValue[]>();

  constructor(bytes: Uint8Array | null | undefined) {
    if (!bytes) return;
    let p = 0;
    const readVarint = (): bigint => {
      let result = 0n;
      let shift = 0n;
      for (;;) {
        if (p >= bytes.length) throw new Error("Truncated protobuf data");
        const b = bytes[p++]!;
        result |= BigInt(b & 0x7f) << shift;
        if (!(b & 0x80)) return result;
        shift += 7n;
      }
    };
    while (p < bytes.length) {
      const key = Number(readVarint());
      const field = key >>> 3;
      const wire = key & 7;
      let value: WireValue;
      if (wire === 0) value = { wire, v: readVarint() };
      else if (wire === 1) {
        value = { wire, v: bytes.subarray(p, p + 8) };
        p += 8;
      } else if (wire === 2) {
        const len = Number(readVarint());
        value = { wire, v: bytes.subarray(p, p + len) };
        p += len;
      } else if (wire === 5) {
        value = { wire, v: bytes.subarray(p, p + 4) };
        p += 4;
      } else throw new Error(`Unsupported protobuf wire type ${wire}`);
      const list = this.fields.get(field);
      if (list) list.push(value);
      else this.fields.set(field, [value]);
    }
  }

  has(field: number): boolean {
    return this.fields.has(field);
  }

  private last(field: number): WireValue | undefined {
    const list = this.fields.get(field);
    return list?.[list.length - 1];
  }

  uint(field: number, fallback = 0): number {
    const v = this.last(field);
    return v?.wire === 0 ? Number(BigInt.asUintN(64, v.v)) : fallback;
  }

  int64(field: number, fallback = 0): number {
    const v = this.last(field);
    return v?.wire === 0 ? Number(BigInt.asIntN(64, v.v)) : fallback;
  }

  int64Big(field: number): bigint | null {
    const v = this.last(field);
    return v?.wire === 0 ? BigInt.asIntN(64, v.v) : null;
  }

  int32(field: number, fallback = 0): number {
    const v = this.last(field);
    return v?.wire === 0 ? Number(BigInt.asIntN(32, v.v)) : fallback;
  }

  sint32(field: number, fallback = 0): number {
    const v = this.last(field);
    if (v?.wire !== 0) return fallback;
    const n = Number(BigInt.asUintN(32, v.v));
    return (n >>> 1) ^ -(n & 1);
  }

  bool(field: number): boolean {
    return this.uint(field) !== 0;
  }

  float(field: number, fallback = 0): number {
    const v = this.last(field);
    if (v?.wire !== 5) return fallback;
    return new DataView(v.v.buffer, v.v.byteOffset, 4).getFloat32(0, true);
  }

  string(field: number, fallback = ""): string {
    const v = this.last(field);
    return v?.wire === 2 ? utf8.decode(v.v) : fallback;
  }

  bytes(field: number): Uint8Array | null {
    const v = this.last(field);
    return v?.wire === 2 ? v.v : null;
  }

  message(field: number): ProtoMessage | null {
    const b = this.bytes(field);
    return b ? new ProtoMessage(b) : null;
  }

  messages(field: number): ProtoMessage[] {
    return (this.fields.get(field) ?? []).filter((v) => v.wire === 2).map((v) => new ProtoMessage(v.v));
  }

  /** Repeated float, packed or unpacked. */
  floats(field: number): number[] {
    const out: number[] = [];
    for (const v of this.fields.get(field) ?? []) {
      if (v.wire === 5) out.push(new DataView(v.v.buffer, v.v.byteOffset, 4).getFloat32(0, true));
      else if (v.wire === 2) {
        const dv = new DataView(v.v.buffer, v.v.byteOffset, v.v.length);
        for (let i = 0; i + 4 <= v.v.length; i += 4) out.push(dv.getFloat32(i, true));
      }
    }
    return out;
  }

  /** Repeated varint, packed or unpacked. */
  uints(field: number): number[] {
    const out: number[] = [];
    for (const v of this.fields.get(field) ?? []) {
      if (v.wire === 0) out.push(Number(v.v));
      else if (v.wire === 2) {
        let p = 0;
        while (p < v.v.length) {
          let result = 0n;
          let shift = 0n;
          for (;;) {
            const b = v.v[p++]!;
            result |= BigInt(b & 0x7f) << shift;
            if (!(b & 0x80)) break;
            shift += 7n;
          }
          out.push(Number(result));
        }
      }
    }
    return out;
  }
}
