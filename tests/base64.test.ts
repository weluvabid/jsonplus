import { Buffer as NodeBuffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";
import { base64ByteLength, decodeBase64, encodeBase64 } from "../src/base64.js";
import { JSONPlusError } from "../src/errors.js";

describe("base64 binary codec", () => {
  it("round-trips payloads across padding and chunk boundaries", () => {
    const lengths = [0, 1, 2, 3, 4, 11, 12, 13, 12_287, 12_288, 12_289, 49_151, 49_152, 49_153];
    for (const length of lengths) {
      const source = new Uint8Array(length);
      for (let index = 0; index < source.length; index += 997) {
        source[index] = (index * 31) & 0xff;
      }

      const encoded = encodeBase64(source.buffer as ArrayBuffer);
      expect(encoded).toBe(NodeBuffer.from(source).toString("base64"));
      expect(base64ByteLength(encoded)).toBe(length);
      expect(new Uint8Array(decodeBase64(encoded))).toEqual(source);
    }
  });

  it("uses the Node-native codec independently of global btoa", () => {
    const source = new Uint8Array(24_579);
    for (let index = 0; index < source.length; index += 127) {
      source[index] = (index * 13) & 0xff;
    }

    vi.stubGlobal("btoa", undefined);
    try {
      const encoded = encodeBase64(source.buffer as ArrayBuffer);
      expect(encoded).toBe(NodeBuffer.from(source).toString("base64"));
      expect(new Uint8Array(decodeBase64(encoded))).toEqual(source);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses chunked browser APIs when Node Buffer and native typed-array Base64 APIs are absent", () => {
    const source = new Uint8Array(49_201);
    for (let index = 0; index < source.length; index += 127) {
      source[index] = (index * 17) & 0xff;
    }

    const originalToBase64 = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "toBase64");
    const originalFromBase64 = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
    vi.stubGlobal("Buffer", undefined);
    vi.stubGlobal("process", undefined);
    Object.defineProperty(Uint8Array.prototype, "toBase64", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(Uint8Array, "fromBase64", {
      configurable: true,
      value: undefined,
    });
    try {
      const encoded = encodeBase64(source.buffer as ArrayBuffer);
      expect(encoded).toBe(NodeBuffer.from(source).toString("base64"));
      expect(base64ByteLength(encoded)).toBe(source.byteLength);
      expect(new Uint8Array(decodeBase64(encoded))).toEqual(source);
      expect(() => decodeBase64("AB==")).toThrowError(JSONPlusError);

      const detached = new ArrayBuffer(8);
      structuredClone(detached, { transfer: [detached] });
      expect(() => encodeBase64(detached)).toThrowError(JSONPlusError);
    } finally {
      if (originalToBase64 === undefined) {
        Reflect.deleteProperty(Uint8Array.prototype, "toBase64");
      } else {
        Object.defineProperty(Uint8Array.prototype, "toBase64", originalToBase64);
      }
      if (originalFromBase64 === undefined) {
        Reflect.deleteProperty(Uint8Array, "fromBase64");
      } else {
        Object.defineProperty(Uint8Array, "fromBase64", originalFromBase64);
      }
      vi.unstubAllGlobals();
    }
  });

  it("uses native typed-array Base64 methods when available", () => {
    const source = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
    let encodeCalls = 0;
    let decodeCalls = 0;
    const originalToBase64 = Object.getOwnPropertyDescriptor(Uint8Array.prototype, "toBase64");
    const originalFromBase64 = Object.getOwnPropertyDescriptor(Uint8Array, "fromBase64");
    vi.stubGlobal("Buffer", undefined);
    vi.stubGlobal("process", undefined);
    Object.defineProperty(Uint8Array.prototype, "toBase64", {
      configurable: true,
      value(this: Uint8Array) {
        encodeCalls += 1;
        return NodeBuffer.from(this).toString("base64");
      },
    });
    Object.defineProperty(Uint8Array, "fromBase64", {
      configurable: true,
      value(value: string) {
        decodeCalls += 1;
        return new Uint8Array(NodeBuffer.from(value, "base64"));
      },
    });
    try {
      const encoded = encodeBase64(source.buffer as ArrayBuffer);
      expect(encoded).toBe(NodeBuffer.from(source).toString("base64"));
      expect(new Uint8Array(decodeBase64(encoded))).toEqual(source);
      expect(encodeCalls).toBe(1);
      expect(decodeCalls).toBe(1);
    } finally {
      if (originalToBase64 === undefined) {
        Reflect.deleteProperty(Uint8Array.prototype, "toBase64");
      } else {
        Object.defineProperty(Uint8Array.prototype, "toBase64", originalToBase64);
      }
      if (originalFromBase64 === undefined) {
        Reflect.deleteProperty(Uint8Array, "fromBase64");
      } else {
        Object.defineProperty(Uint8Array, "fromBase64", originalFromBase64);
      }
      vi.unstubAllGlobals();
    }
  });

  it("rejects detached ArrayBuffers", () => {
    const detached = new ArrayBuffer(8);
    structuredClone(detached, { transfer: [detached] });
    expect(() => encodeBase64(detached)).toThrowError(JSONPlusError);
  });

  it("rejects invalid characters, misplaced padding, and non-canonical payloads", () => {
    const invalidValues = ["%", "%%%", "A===", "AA=A", "AB==", "AAB=", "AAAA====", "!!!!"];
    for (const invalid of invalidValues) {
      expect(() => base64ByteLength(invalid)).toThrowError(JSONPlusError);
      expect(() => decodeBase64(invalid)).toThrowError(JSONPlusError);
    }
  });
});
