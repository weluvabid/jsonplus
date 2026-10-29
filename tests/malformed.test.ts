import { describe, expect, it } from "vitest";
import { decode, encode, JSONPlusError } from "../src/index.js";

function envelope(root: unknown, nodes: unknown[] = []): string {
  return JSON.stringify({ format: "jsonplus", version: 1, root, nodes });
}

function expectCode(input: string, code: JSONPlusError["code"]): void {
  try {
    decode(input);
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(JSONPlusError);
    expect((error as JSONPlusError).code).toBe(code);
  }
}

describe("malformed input", () => {
  it("rejects invalid JSON and malformed envelopes", () => {
    expectCode("{", "INVALID_INPUT");
    expectCode(
      '{"format":"jsonplus","version":1,"\\u0076ersion":1,"root":null,"nodes":[]}',
      "INVALID_INPUT",
    );
    expectCode(
      JSON.stringify({ format: "other", version: 1, root: null, nodes: [] }),
      "INVALID_ENVELOPE",
    );
    expectCode(
      JSON.stringify({ format: "jsonplus", version: 2, root: null, nodes: [] }),
      "UNSUPPORTED_VERSION",
    );
    expectCode(
      JSON.stringify({ format: "jsonplus", version: 3, root: null, nodes: [] }),
      "UNSUPPORTED_VERSION",
    );
    expectCode(
      JSON.stringify({ format: "jsonplus", version: 1, root: null, nodes: [], surprise: true }),
      "INVALID_ENVELOPE",
    );
  });

  it("rejects malformed and out-of-range references", () => {
    expectCode(envelope({ $ref: 0 }), "INVALID_REFERENCE");
    expectCode(
      envelope({ $ref: 1 }, [{ type: "object", prototype: "object", properties: [] }]),
      "INVALID_REFERENCE",
    );
    expectCode(
      envelope({ $ref: 0, extra: true }, [{ type: "object", prototype: "object", properties: [] }]),
      "INVALID_REFERENCE",
    );
  });

  it("rejects malformed flat pair buffers", () => {
    const flatEnvelope = (root: unknown, nodes: unknown[] = []): string =>
      JSON.stringify({ format: "jsonplus", version: 1, root, nodes });

    expectCode(
      flatEnvelope({ $ref: 0 }, [{ type: "object", prototype: "object", properties: ["key"] }]),
      "INVALID_NODE",
    );
    expectCode(
      flatEnvelope({ $ref: 0 }, [{ type: "array", length: 1, entries: [0] }]),
      "INVALID_NODE",
    );
    expectCode(
      flatEnvelope({ $ref: 0 }, [{ type: "map", entries: ["key"], properties: [] }]),
      "INVALID_NODE",
    );
    expectCode(
      flatEnvelope({ $ref: 0 }, [
        { type: "object", prototype: "object", properties: ["x", 1, "x", 2] },
      ]),
      "INVALID_NODE",
    );
  });

  it("rejects unknown tags and non-canonical primitive representations", () => {
    expectCode(envelope({ $type: "custom" }), "INVALID_TAG");
    expectCode(envelope({ $type: "number", value: "NaN" }), "INVALID_TAG");
    expectCode(envelope({ $type: "bigint", value: "01" }), "INVALID_TAG");
    expectCode(envelope({ $type: "bigint", value: "-0" }), "INVALID_TAG");
    expectCode('{"format":"jsonplus","version":1,"root":1e999,"nodes":[]}', "INVALID_TAG");
    expectCode('{"format":"jsonplus","version":1,"root":-0,"nodes":[]}', "INVALID_TAG");
  });

  it("rejects unknown node types, fields, duplicate properties, and unreachable nodes", () => {
    expectCode(envelope({ $ref: 0 }, [{ type: "mystery" }]), "INVALID_NODE");
    expectCode(
      envelope({ $ref: 0 }, [{ type: "object", prototype: "object", properties: [], extra: true }]),
      "INVALID_NODE",
    );
    expectCode(
      envelope({ $ref: 0 }, [
        {
          type: "object",
          prototype: "object",
          properties: ["x", 1, "x", 2],
        },
      ]),
      "INVALID_NODE",
    );
    expectCode(
      envelope(1, [{ type: "object", prototype: "object", properties: [] }]),
      "UNREACHABLE_NODE",
    );
  });

  it("rejects invalid binary payloads and invalid views", () => {
    for (const bytes of ["%%%", "A===", "AA=A", "AB==", "AAB=", "AAAA===="]) {
      expectCode(
        envelope({ $ref: 0 }, [{ type: "array-buffer", bytes, properties: [] }]),
        "INVALID_BINARY",
      );
    }
    expectCode(
      envelope({ $ref: 0 }, [
        {
          type: "typed-array",
          constructor: "Uint8Array",
          buffer: { $ref: 1 },
          byteOffset: 0,
          length: 1,
          properties: [],
        },
        { type: "object", prototype: "object", properties: [] },
      ]),
      "INVALID_REFERENCE",
    );
    expectCode(
      envelope({ $ref: 0 }, [
        {
          type: "typed-array",
          constructor: "Uint16Array",
          buffer: { $ref: 1 },
          byteOffset: 1,
          length: 1,
          properties: [],
        },
        { type: "array-buffer", bytes: "AAAAAA==", properties: [] },
      ]),
      "INVALID_NODE",
    );
  });

  it("rejects non-canonical RegExp source strings", () => {
    expectCode(
      envelope({ $ref: 0 }, [
        { type: "regexp", source: "", flags: "", lastIndex: 0, properties: [] },
      ]),
      "INVALID_NODE",
    );
  });

  it("rejects invalid duplicate Map keys and Set elements", () => {
    expectCode(
      envelope({ $ref: 0 }, [
        {
          type: "map",
          entries: [
            [1, "a"],
            [1, "b"],
          ],
          properties: [],
        },
      ]),
      "INVALID_NODE",
    );
    expectCode(
      envelope({ $ref: 0 }, [{ type: "set", values: [1, 1], properties: [] }]),
      "INVALID_NODE",
    );
  });

  it("rejects configured resource-limit violations", () => {
    expect(() => encode({ a: 1 }, { maxNodes: 0 })).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }),
    );
    expect(() => decode(encode("long"), { maxInputChars: 2 })).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }),
    );
    expect(() => encode("long", { maxStringLength: 2 })).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }),
    );
    expect(() => encode({ a: 1 }, { typoLimit: 1 } as never)).toThrowError(
      expect.objectContaining({ code: "INVALID_OPTIONS" }),
    );
  });
});
