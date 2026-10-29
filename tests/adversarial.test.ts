import { describe, expect, it } from "vitest";
import { decode, encode, JSONPlusError } from "../src/index.js";

describe("adversarial graph behavior", () => {
  it("does not invoke toJSON when serializing values", () => {
    let calls = 0;
    const value = { x: 1 } as { x: number; toJSON?: () => unknown };
    Object.defineProperty(value, "toJSON", {
      value: () => {
        calls += 1;
        return { corrupt: true };
      },
      enumerable: false,
    });

    const restored = decode(encode(value)) as { x: number };
    expect(restored).toEqual({ x: 1 });
    expect(calls).toBe(0);
  });

  it("handles large alias fan-out without duplicating shared nodes", () => {
    const shared = { marker: true };
    const source: Record<string, unknown> = {};
    for (let index = 0; index < 5_000; index += 1) source[`key${index}`] = shared;

    const encoded = encode(source);
    const parsed = JSON.parse(encoded) as { nodes: unknown[] };
    expect(parsed.nodes).toHaveLength(2);
    const restored = decode(encoded) as Record<string, unknown>;
    expect(restored["key0"]).toBe(restored["key4999"]);
  });

  it("rejects proxies whose reflection fails with a stable library error", () => {
    const value = new Proxy(
      { x: 1 },
      {
        ownKeys() {
          throw new Error("trap failure");
        },
      },
    );
    expect(() => encode(value)).toThrow(JSONPlusError);
  });

  it("does not invoke an array proxy get trap to read its length", () => {
    let getCalls = 0;
    const value = new Proxy([1, 2], {
      get() {
        getCalls += 1;
        throw new Error("get trap failure");
      },
    });
    expect(decode(encode(value))).toEqual([1, 2]);
    expect(getCalls).toBe(0);
  });

  it("preserves cycles through built-in custom properties and collection entries", () => {
    const map = new Map<unknown, unknown>();
    const set = new Set<unknown>();
    const buffer = new ArrayBuffer(4) as ArrayBuffer & { owner?: unknown };
    const root = { map, set, buffer };
    map.set(root, set);
    set.add(map);
    buffer.owner = root;

    const restored = decode(encode(root)) as typeof root;
    expect(restored.map.get(restored)).toBe(restored.set);
    expect(restored.set.has(restored.map)).toBe(true);
    expect((restored.buffer as ArrayBuffer & { owner?: unknown }).owner).toBe(restored);
  });

  it("rejects resource exhaustion before creating unbounded node tables", () => {
    const source = { a: {}, b: {}, c: {} };
    expect(() => encode(source, { maxNodes: 2 })).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }),
    );
    expect(() => encode({ items: [1, 2, 3] }, { maxEdges: 2 })).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT_EXCEEDED" }),
    );
  });
});
