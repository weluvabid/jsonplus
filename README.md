# JSON+

A versioned, graph-aware serialization format for JavaScript values that ordinary JSON cannot faithfully represent.

JSON+ preserves supported JavaScript values **and the object-identity relationships between them**. Cycles and shared references are first-class parts of the format, not special cases hidden in a replacer function.

## Example

```ts
import { decode, encode } from "@weluvabid/jsonplus";

const shared = { count: 1n };
const value: {
  first: typeof shared;
  second: typeof shared;
  missing: undefined;
  score: number;
  createdAt: Date;
  self?: unknown;
} = {
  first: shared,
  second: shared,
  missing: undefined,
  score: Number.NaN,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};
value.self = value;

const restored = decode(encode(value)) as typeof value;

restored.first === restored.second; // true
restored.self === restored; // true
restored.missing; // undefined
restored.score; // NaN
restored.first.count; // 1n
```

## Development

Requires Node.js 22 or newer and npm 10 or newer.

```sh
npm ci
npm run check
```

Useful commands:

```sh
npm test
npm run test:watch
npm run test:hardening
npm run typecheck
npm run lint
npm run format:check
npm run build
npm run benchmark
```

## Contract at a glance

- The wire envelope declares `format: "jsonplus"` and `version: 1`. Pair collections use flat alternating buffers to avoid per-entry tuple allocations. This is the first and only supported wire schema.
- A node table represents the graph. References point to node indexes, so forward references, cycles, and shared identity are supported.
- The decoder allocates nodes before populating edges and uses iterative graph processing.
- Plain objects preserve enumerable own string-keyed data properties and the distinction between `Object.prototype` and a null prototype.
- Arrays preserve length, sparse holes, explicit `undefined`, and shared references. Custom array properties are rejected.
- Maps and Sets preserve insertion order and participate in the same graph as the root value.
- ArrayBuffers and views preserve bytes, view type, offsets, lengths, and shared backing-buffer identity.
- Accessors, functions, symbols, unsupported prototypes, and unsupported built-ins are rejected instead of being silently coerced.
- Decode and encode accept configurable resource limits. Unknown versions and malformed documents produce `JSONPlusError` instances with stable `code` values.

The decoder treats input as untrusted and validates the envelope, node schemas, references, reachability, collection sizes, typed-array bounds, base64 payloads, and configured limits before returning a graph.

## API

```ts
encode(value: unknown, options?: JSONPlusOptions): string

decode(input: string, options?: JSONPlusOptions): unknown
```

Both functions are synchronous and dependency-free at runtime. `encode` returns a JSON string. `decode` reconstructs the value represented by that string.

`JSONPlusOptions` exposes these non-negative integer limits:

| Option                 |                 Default | Meaning                                                                         |
| ---------------------- | ----------------------: | ------------------------------------------------------------------------------- |
| `maxNodes`             |               1,000,000 | Maximum distinct referenceable nodes                                            |
| `maxEdges`             |               5,000,000 | Maximum encoded value slots across node state                                   |
| `maxBinaryBytes`       |                  32 MiB | Maximum total bytes across distinct ArrayBuffers                                |
| `maxStringLength`      | 16 Mi UTF-16 code units | Maximum individual string, property key, regex source, or BigInt decimal length |
| `maxCollectionEntries` |               1,000,000 | Maximum entries per collection, array length, or typed-array length             |
| `maxInputChars`        | 64 Mi UTF-16 code units | Maximum input document length accepted by `decode`                              |
| `maxOutputChars`       | 64 Mi UTF-16 code units | Maximum encoded document length returned by `encode`                            |

Exceeding a limit raises `JSONPlusError` with code `RESOURCE_LIMIT_EXCEEDED`. The limits are safety bounds, not estimates of exact heap consumption.

## Scope and limitations

JSON+ is a data serializer, not a JavaScript runtime snapshot, schema system, or RPC protocol. It does not preserve property descriptors, object extensibility, arbitrary prototype chains, closures, weak collection state, or external references. Restored enumerable data properties are writable and configurable. The initial implementation supports same-realm plain objects and built-ins; cross-realm objects and custom subclasses are rejected.

Proxy behavior cannot be reliably detected from JavaScript. Reflection over a proxy may execute its traps; JSON+ wraps inspection failures, but cannot guarantee that inspecting a hostile proxy has no side effects. Resizable ArrayBuffers and SharedArrayBuffers remain unsupported.

The wire schema, graph semantics, and error contract are in [SPEC.md](./SPEC.md).
