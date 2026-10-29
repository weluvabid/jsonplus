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
      expect(encoded).toBe(Buffer.from(source).toString("base64"));
      expect(base64ByteLength(encoded)).toBe(length);
      expect(new Uint8Array(decodeBase64(encoded))).toEqual(source);
    }
  });

  it("uses the portable encoder when native btoa is unavailable", () => {
    const source = new Uint8Array(24_579);
    for (let index = 0; index < source.length; index += 127) {
      source[index] = (index * 13) & 0xff;
    }

    vi.stubGlobal("btoa", undefined);
    try {
      const encoded = encodeBase64(source.buffer as ArrayBuffer);
      expect(encoded).toBe(Buffer.from(source).toString("base64"));
      expect(new Uint8Array(decodeBase64(encoded))).toEqual(source);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects invalid characters, misplaced padding, and non-canonical payloads", () => {
    const invalidValues = ["%", "%%%", "A===", "AA=A", "AB==", "AAB=", "AAAA====", "!!!!"];
    for (const invalid of invalidValues) {
      expect(() => base64ByteLength(invalid)).toThrowError(JSONPlusError);
      expect(() => decodeBase64(invalid)).toThrowError(JSONPlusError);
    }
  });
});
