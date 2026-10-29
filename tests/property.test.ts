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
