import { describe, expect, it } from "vitest";
import { decode, encode } from "../src/index.js";

describe("object graph semantics", () => {
  it("emits version 2 with flattened property, array, and Map pair buffers", () => {
    const encoded = encode({ value: 1, list: ["x"], map: new Map([["k", "v"]]) });
    const document = JSON.parse(encoded) as {
      version: number;
      nodes: Array<Record<string, unknown>>;
    };

    expect(document.version).toBe(2);
    expect(document.nodes[0]?.["properties"]).toEqual([
      "value",
      1,
      "list",
      { $ref: 1 },
      "map",
      { $ref: 2 },
    ]);
    expect(document.nodes[1]?.["entries"]).toEqual([0, "x"]);
    expect(document.nodes[2]?.["entries"]).toEqual(["k", "v"]);
  });

  it("continues to decode version 1 documents", () => {
    const input = JSON.stringify({
      format: "jsonplus",
      version: 1,
      root: { $ref: 0 },
      nodes: [
        {
          type: "object",
          prototype: "object",
          properties: [
            ["list", { $ref: 1 }],
            ["map", { $ref: 2 }],
            ["self", { $ref: 0 }],
          ],
        },
        {
          type: "array",
          length: 3,
          entries: [
            [1, { $type: "undefined" }],
            [2, { $ref: 0 }],
          ],
        },
        {
          type: "map",
          entries: [
            [{ $ref: 0 }, "root"],
            ["list", { $ref: 1 }],
          ],
          properties: [],
        },
      ],
    });
    const restored = decode(input) as {
      list: unknown[];
      map: Map<unknown, unknown>;
      self: unknown;
    };
    expect(restored.self).toBe(restored);
    expect(0 in restored.list).toBe(false);
    expect(1 in restored.list).toBe(true);
    expect(restored.list[1]).toBeUndefined();
    expect(restored.list[2]).toBe(restored);
    expect(restored.map.get(restored)).toBe("root");
    expect(restored.map.get("list")).toBe(restored.list);
  });

  it("preserves self-references, mutual cycles, and shared descendants", () => {
    const root: Record<string, unknown> = {};
    const shared = { value: 42 };
    const left: Record<string, unknown> = { child: shared };
    const right: Record<string, unknown> = { child: shared };
    const peer: Record<string, unknown> = {};

    root["self"] = root;
    root["left"] = left;
    root["right"] = right;
    root["peer"] = peer;
    peer["peer"] = root;

    const restored = decode(encode(root)) as Record<string, unknown>;
    const restoredLeft = restored["left"] as Record<string, unknown>;
    const restoredRight = restored["right"] as Record<string, unknown>;
    const restoredPeer = restored["peer"] as Record<string, unknown>;

    expect(restored["self"]).toBe(restored);
    expect(restoredPeer["peer"]).toBe(restored);
    expect(restoredLeft["child"]).toBe(restoredRight["child"]);
    expect((restoredLeft["child"] as { value: number }).value).toBe(42);
  });

  it("preserves distinct objects with equal contents as distinct identities", () => {
    const restored = decode(encode({ a: { value: 1 }, b: { value: 1 } })) as {
      a: object;
      b: object;
    };
    expect(restored.a).not.toBe(restored.b);
  });

  it("preserves references shared between object properties, Map keys, and Set values", () => {
    const key = { id: 1 };
    const source = {
      key,
      map: new Map<unknown, unknown>([[key, key]]),
      set: new Set<unknown>([key]),
    };
    const restored = decode(encode(source)) as typeof source;

    expect(restored.map.get(restored.key)).toBe(restored.key);
    expect(restored.set.has(restored.key)).toBe(true);
    expect([...restored.set][0]).toBe(restored.key);
  });

  it("handles deep graphs iteratively without recursive traversal", () => {
    const root: { next?: unknown } = {};
    let current = root;
    const depth = 20_000;
    for (let index = 0; index < depth; index += 1) {
      const next: { next?: unknown } = {};
      current.next = next;
      current = next;
    }

    const restored = decode(encode(root)) as { next?: unknown };
    let cursor = restored;
    for (let index = 0; index < depth; index += 1) {
      cursor = cursor.next as { next?: unknown };
    }
    expect(cursor.next).toBeUndefined();
  });

  it("creates an independent snapshot while preserving internal sharing", () => {
    const shared = { count: 1 };
    const source = { a: shared, b: shared };
    const encoded = encode(source);
    shared.count = 2;

    const restored = decode(encoded) as typeof source;
    expect(restored.a.count).toBe(1);
    expect(restored.a).toBe(restored.b);
    restored.a.count = 3;
    expect(shared.count).toBe(2);
  });
});
