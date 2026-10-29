import { describe, expect, it } from "vitest";
import { decode, encode } from "../src/index.js";

describe("object graph semantics", () => {
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
