import { describe, expect, it } from "vitest";
import { decode, encode, JSONPlusError } from "../src/index.js";

function roundTrip<T>(value: T): T {
  return decode(encode(value)) as T;
}

describe("primitive values", () => {
  it("preserves undefined, BigInt, special numbers, and negative zero", () => {
    const restored = roundTrip({
      missing: undefined,
      positive: 987654321098765432109876543210n,
      negative: -987654321098765432109876543210n,
      nan: Number.NaN,
      positiveInfinity: Number.POSITIVE_INFINITY,
      negativeInfinity: Number.NEGATIVE_INFINITY,
      negativeZero: -0,
      finite: 1.25,
    });

    expect(Object.hasOwn(restored, "missing")).toBe(true);
    expect(restored.missing).toBeUndefined();
    expect(restored.positive).toBe(987654321098765432109876543210n);
    expect(restored.negative).toBe(-987654321098765432109876543210n);
    expect(Number.isNaN(restored.nan)).toBe(true);
    expect(restored.positiveInfinity).toBe(Number.POSITIVE_INFINITY);
    expect(restored.negativeInfinity).toBe(Number.NEGATIVE_INFINITY);
    expect(Object.is(restored.negativeZero, -0)).toBe(true);
    expect(restored.finite).toBe(1.25);
  });

  it("round-trips a primitive root", () => {
    expect(roundTrip(null)).toBeNull();
    expect(roundTrip(false)).toBe(false);
    expect(roundTrip("hello JSON+")).toBe("hello JSON+");
    expect(roundTrip(42)).toBe(42);
    expect(roundTrip(12345678901234567890n)).toBe(12345678901234567890n);
    expect(roundTrip(undefined)).toBeUndefined();
  });

  it("preserves Date timestamps and invalid dates", () => {
    const restored = roundTrip({
      valid: new Date("2025-02-03T04:05:06.789Z"),
      invalid: new Date(Number.NaN),
    });

    expect(restored.valid).toBeInstanceOf(Date);
    expect(restored.valid.getTime()).toBe(Date.parse("2025-02-03T04:05:06.789Z"));
    expect(restored.invalid).toBeInstanceOf(Date);
    expect(Number.isNaN(restored.invalid.getTime())).toBe(true);
  });

  it("preserves RegExp source, flags, lastIndex, and custom data properties", () => {
    const expression = /a+b/dgimsuy as RegExp & { metadata: { state: string } };
    expression.lastIndex = 7;
    Object.defineProperty(expression, "metadata", {
      value: { state: "ready" },
      enumerable: true,
    });

    const restored = roundTrip(expression);
    expect(restored).toBeInstanceOf(RegExp);
    expect(restored.source).toBe(expression.source);
    expect(restored.flags).toBe(expression.flags);
    expect(restored.lastIndex).toBe(7);
    expect(restored.metadata).toEqual({ state: "ready" });
  });

  it("preserves Map and Set order and identity-aware contents", () => {
    const key = { key: 1 };
    const map = new Map<unknown, unknown>([
      [key, "value"],
      ["tail", key],
    ]);
    const set = new Set<unknown>([key, "value", 1]);
    const restored = roundTrip({ key, map, set });

    expect(restored.map).toBeInstanceOf(Map);
    expect([...restored.map.keys()]).toEqual([restored.key, "tail"]);
    expect(restored.map.get(restored.key)).toBe("value");
    expect(restored.map.get("tail")).toBe(restored.key);
    expect([...restored.set]).toEqual([restored.key, "value", 1]);
  });

  it("preserves plain and null-prototype objects and enumerable data properties", () => {
    const ordinary = Object.create(Object.prototype) as Record<string, unknown>;
    const dictionary = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(ordinary, "readonly", {
      value: 4,
      enumerable: true,
      configurable: false,
      writable: false,
    });
    Object.defineProperty(ordinary, "hidden", { value: 9, enumerable: false });
    dictionary["answer"] = 42;

    const restored = roundTrip({ ordinary, dictionary });
    expect(Object.getPrototypeOf(restored.ordinary)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(restored.dictionary)).toBeNull();
    expect(restored.ordinary["readonly"]).toBe(4);
    expect(Object.hasOwn(restored.ordinary, "hidden")).toBe(false);
    expect(restored.dictionary["answer"]).toBe(42);
    expect(Object.getOwnPropertyDescriptor(restored.ordinary, "readonly")).toMatchObject({
      enumerable: true,
      configurable: true,
      writable: true,
    });
  });

  it("preserves sparse arrays and distinguishes holes from explicit undefined", () => {
    const source = new Array<unknown>(4);
    source[1] = undefined;
    source[3] = "last";
    const restored = roundTrip(source);

    expect(restored.length).toBe(4);
    expect(0 in restored).toBe(false);
    expect(1 in restored).toBe(true);
    expect(restored[1]).toBeUndefined();
    expect(2 in restored).toBe(false);
    expect(restored[3]).toBe("last");
  });

  it("preserves extra enumerable data properties on supported built-ins", () => {
    const date = new Date(0) as Date & { note?: unknown };
    date.note = { owner: date };
    const restored = roundTrip(date);
    expect(restored.getTime()).toBe(0);
    expect(restored.note).toEqual({ owner: restored });
    expect((restored.note as { owner: unknown }).owner).toBe(restored);
  });
});

describe("binary views", () => {
  it("preserves all supported typed-array view constructors", () => {
    const values: ArrayBufferView[] = [
      new Int8Array([-1, 2]),
      new Uint8Array([1, 2]),
      new Uint8ClampedArray([0, 128, 255]),
      new Int16Array([-2, 3]),
      new Uint16Array([2, 65535]),
      new Int32Array([-3, 4]),
      new Uint32Array([3, 4294967295]),
      new Float32Array([Math.PI, Number.NaN]),
      new Float64Array([Math.E, Number.POSITIVE_INFINITY]),
      new BigInt64Array([-2n, 3n]),
      new BigUint64Array([2n, 3n]),
    ];

    for (const source of values) {
      const restored = roundTrip(source) as ArrayBufferView;
      expect(Object.getPrototypeOf(restored)).toBe(Object.getPrototypeOf(source));
      expect(restored.byteLength).toBe(source.byteLength);
      expect(restored.byteOffset).toBe(source.byteOffset);
      expect([
        ...new Uint8Array(restored.buffer, restored.byteOffset, restored.byteLength),
      ]).toEqual([...new Uint8Array(source.buffer, source.byteOffset, source.byteLength)]);
    }
  });

  it("allocates views whose backing buffer appears later in the node table", () => {
    const encoded = JSON.stringify({
      format: "jsonplus",
      version: 1,
      root: { $ref: 0 },
      nodes: [
        {
          type: "object",
          prototype: "object",
          properties: ["bytes", { $ref: 1 }, "view", { $ref: 2 }, "buffer", { $ref: 3 }],
        },
        {
          type: "typed-array",
          constructor: "Uint8Array",
          buffer: { $ref: 3 },
          byteOffset: 0,
          length: 4,
          properties: [],
        },
        {
          type: "data-view",
          buffer: { $ref: 3 },
          byteOffset: 1,
          byteLength: 2,
          properties: [],
        },
        { type: "array-buffer", bytes: "AQIDBA==", properties: [] },
      ],
    });

    const restored = decode(encoded) as {
      bytes: Uint8Array;
      view: DataView;
      buffer: ArrayBuffer;
    };

    expect(restored.buffer).toBeInstanceOf(ArrayBuffer);
    expect(restored.bytes.buffer).toBe(restored.buffer);
    expect(restored.view.buffer).toBe(restored.buffer);
    expect([...restored.bytes]).toEqual([1, 2, 3, 4]);
    expect(restored.view.getUint8(0)).toBe(2);
    expect(restored.view.getUint8(1)).toBe(3);
  });

  it("preserves shared backing-buffer identity, offsets, and overlapping writes", () => {
    const buffer = new ArrayBuffer(16);
    const bytes = new Uint8Array(buffer, 0, 12);
    const words = new Uint16Array(buffer, 2, 4);
    const view = new DataView(buffer, 4, 8);
    bytes.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

    const restored = roundTrip({ buffer, bytes, words, view });
    expect(restored.bytes.buffer).toBe(restored.buffer);
    expect(restored.words.buffer).toBe(restored.buffer);
    expect(restored.view.buffer).toBe(restored.buffer);
    expect(restored.bytes.byteOffset).toBe(0);
    expect(restored.words.byteOffset).toBe(2);
    expect(restored.view.byteOffset).toBe(4);
    expect(restored.view.byteLength).toBe(8);

    restored.bytes[4] = 200;
    expect(restored.view.getUint8(0)).toBe(200);
  });

  it("preserves DataView with a zero-length region", () => {
    const buffer = new ArrayBuffer(4);
    const restored = roundTrip(new DataView(buffer, 4, 0));
    expect(restored).toBeInstanceOf(DataView);
    expect(restored.byteOffset).toBe(4);
    expect(restored.byteLength).toBe(0);
  });
});

describe("unsupported values", () => {
  it("rejects functions, symbols, custom prototypes, and enumerable symbol keys", () => {
    expect(() => encode(() => 1)).toThrow(JSONPlusError);
    expect(() => encode(Symbol("id"))).toThrow(JSONPlusError);
    expect(() => encode(Object.create({ inherited: true }))).toThrow(JSONPlusError);
    expect(() => encode({ [Symbol("key")]: 1 })).toThrow(JSONPlusError);
  });

  it("rejects enumerable accessors without invoking them", () => {
    let calls = 0;
    const input = Object.defineProperty({}, "danger", {
      enumerable: true,
      get() {
        calls += 1;
        return 1;
      },
    });

    expect(() => encode(input)).toThrow(JSONPlusError);
    expect(calls).toBe(0);
  });

  it("rejects arrays with custom properties and non-enumerable indexed values", () => {
    const withCustom = [1] as number[] & { extra?: boolean };
    withCustom.extra = true;
    expect(() => encode(withCustom)).toThrow(JSONPlusError);

    const hiddenElement: unknown[] = [];
    Object.defineProperty(hiddenElement, "0", { value: 1, enumerable: false });
    expect(() => encode(hiddenElement)).toThrow(JSONPlusError);
  });

  it("rejects unsupported RegExp state accessors before calling them", () => {
    let calls = 0;
    const expression = /x/;
    Object.defineProperty(expression, "metadata", {
      enumerable: true,
      get() {
        calls += 1;
        return true;
      },
    });
    expect(() => encode(expression)).toThrow(JSONPlusError);
    expect(calls).toBe(0);
  });
});
