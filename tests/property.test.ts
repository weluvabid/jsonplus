import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { decode, encode } from "../src/index.js";

const scalar = fc.oneof(
  fc.string({ maxLength: 24 }),
  fc.boolean(),
  fc.integer({ min: -1_000_000, max: 1_000_000 }),
  fc.double({ noNaN: true, noDefaultInfinity: true }),
  fc.bigInt({ min: -(1n << 80n), max: 1n << 80n }),
  fc.constant(null),
  fc.constant(undefined),
  fc.constant(Number.NaN),
  fc.constant(Number.POSITIVE_INFINITY),
  fc.constant(Number.NEGATIVE_INFINITY),
  fc.constant(-0),
);

const valueArbitrary = fc.letrec((tie) => ({
  value: fc.oneof(
    scalar,
    fc.array(tie("value"), { maxLength: 6 }),
    fc.dictionary(fc.string({ maxLength: 12 }), tie("value"), { maxKeys: 6 }),
  ),
}))["value"]!;

const graphArbitrary = fc.array(fc.array(fc.nat(), { maxLength: 5 }), {
  minLength: 1,
  maxLength: 8,
});

describe("property-based round trips", () => {
  it("round-trips generated acyclic values", () => {
    fc.assert(
      fc.property(valueArbitrary, (value) => {
        const restored = decode(encode(value));
        expect(restored).toEqual(value);
        if (typeof value === "number" && Object.is(value, -0)) {
          expect(Object.is(restored, -0)).toBe(true);
        }
        if (typeof value === "number" && Number.isNaN(value)) {
          expect(Number.isNaN(restored)).toBe(true);
        }
        return true;
      }),
      { numRuns: 250, endOnFailure: true },
    );
  });

  it("round-trips generated cyclic graphs with shared references across objects, Maps, and Sets", () => {
    fc.assert(
      fc.property(graphArbitrary, (adjacency) => {
        const nodes = adjacency.map((_, id) => ({
          id,
          edges: [] as Array<Record<string, unknown>>,
          map: new Map<unknown, unknown>(),
          set: new Set<unknown>(),
        }));

        for (let sourceIndex = 0; sourceIndex < nodes.length; sourceIndex += 1) {
          const source = nodes[sourceIndex]!;
          source.edges = adjacency[sourceIndex]!.map(
            (targetIndex) => nodes[targetIndex % nodes.length]!,
          );
          source.map.set(source, source);
          source.set.add(source);
          for (const target of source.edges) {
            source.map.set(target, target);
            source.set.add(target);
          }
        }

        const restored = decode(encode({ nodes, entry: nodes[0] })) as {
          nodes: typeof nodes;
          entry: (typeof nodes)[number];
        };

        expect(restored.entry).toBe(restored.nodes[0]);
        for (let sourceIndex = 0; sourceIndex < nodes.length; sourceIndex += 1) {
          const restoredNode = restored.nodes[sourceIndex]!;
          const expectedTargets = adjacency[sourceIndex]!.map(
            (targetIndex) => restored.nodes[targetIndex % nodes.length]!,
          );

          expect(restoredNode.edges).toHaveLength(expectedTargets.length);
          for (let edgeIndex = 0; edgeIndex < expectedTargets.length; edgeIndex += 1) {
            expect(restoredNode.edges[edgeIndex]).toBe(expectedTargets[edgeIndex]);
          }
          expect(restoredNode.map.get(restoredNode)).toBe(restoredNode);
          expect(restoredNode.set.has(restoredNode)).toBe(true);
          for (const target of expectedTargets) {
            expect(restoredNode.map.get(target)).toBe(target);
            expect(restoredNode.set.has(target)).toBe(true);
          }
        }
      }),
      { numRuns: 300, endOnFailure: true },
    );
  });

  it("turns malformed arbitrary text into a JSONPlusError rather than a native failure", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), (input) => {
        try {
          decode(input);
        } catch (error) {
          expect(error).toMatchObject({ name: "JSONPlusError", code: expect.any(String) });
        }
        return true;
      }),
      { numRuns: 250, endOnFailure: true },
    );
  });
});
