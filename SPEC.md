# JSON+ Version 1 Specification

## 1. Goals and non-goals

JSON+ serializes a bounded subset of JavaScript values while preserving graph topology: supported reference identities, edges, cycles, and shared references. It is a snapshot format, not a live connection to the source graph.

The format does not encode functions, closures, runtime behavior, schemas, remote calls, or arbitrary JavaScript object instances. Version 1 does not support `SharedArrayBuffer`, resizable `ArrayBuffer`, weak collections, promises, DOM nodes, symbols, cross-realm objects, or arbitrary class instances.

## 2. Envelope

A document is a JSON object with exactly these fields:

```json
{
  "format": "jsonplus",
  "version": 1,
  "root": { "$ref": 0 },
  "nodes": []
}
```

`root` is an encoded value. `nodes` is an array of node records. Node identity is the zero-based index of a node in this array. All nodes must be reachable from `root`; unreachable records are invalid.

The exact set of fields is version-specific. Version 1 rejects unknown envelope fields, node fields, node types, and value tags. A decoder must not reinterpret an unknown tag as an ordinary object.

## 3. Encoded values

Values are represented as follows:

| Value                          | Encoding                                                |
| ------------------------------ | ------------------------------------------------------- |
| `null`, booleans, strings      | JSON primitive                                          |
| Finite numbers other than `-0` | JSON number                                             |
| `undefined`                    | `{ "$type": "undefined" }`                              |
| `BigInt`                       | `{ "$type": "bigint", "value": "<canonical decimal>" }` |
| `NaN`                          | `{ "$type": "number", "value": "nan" }`                 |
| Positive infinity              | `{ "$type": "number", "value": "infinity" }`            |
| Negative infinity              | `{ "$type": "number", "value": "-infinity" }`           |
| Negative zero                  | `{ "$type": "number", "value": "-0" }`                  |
| Referenceable object           | `{ "$ref": <node index> }`                              |

A reference tag contains exactly one `$ref` field, with a non-negative safe integer that indexes `nodes`. BigInt decimal strings use canonical base-10 notation: `0`, a nonzero positive decimal without leading zeroes, or a negative nonzero decimal without leading zeroes. `-0` is not a valid BigInt encoding.

Raw JSON numbers must be finite and must not be negative zero. Special numeric values require the explicit tags above.

## 4. Node schema

All fields shown below are required; no additional fields are allowed in version 1. `properties` is an ordered array of `[string key, encoded value]` pairs. Property keys must be unique within a node.

### Object

```json
{ "type": "object", "prototype": "object", "properties": [] }
```

`prototype` is `object` for an ordinary object whose prototype is `Object.prototype`, or `null` for a null-prototype object.

### Array

```json
{ "type": "array", "length": 3, "entries": [[1, { "$type": "undefined" }]] }
```

`entries` is an ordered array of `[index, encoded value]` pairs. Indexes must be unique, non-negative integers smaller than `length`, and at most `2^32 - 2`. Missing indexes are holes. `length` may be at most `2^32 - 1`, subject to configured resource limits. Custom array properties, symbol keys, and non-enumerable/accessor indexed properties are unsupported.

### Date

```json
{ "type": "date", "time": 0, "properties": [] }
```

`time` is an integral millisecond timestamp within the JavaScript Date range, or `null` for an invalid Date.

### RegExp

```json
{
  "type": "regexp",
  "source": "item",
  "flags": "g",
  "lastIndex": 5,
  "properties": []
}
```

`source` and `flags` are native RegExp source and canonical flags. Flags must be unique and in canonical order (`d`, `g`, `i`, `m`, `s`, `u` or `v`, `y`). `u` and `v` cannot both appear. `lastIndex` is an encoded value and may therefore participate in the graph.

### Map and Set

```json
{ "type": "map", "entries": [["key", "value"]], "properties": [] }
{ "type": "set", "values": ["value"], "properties": [] }
```

Map entries and Set values preserve insertion order. Keys and values participate in the same graph as the root. Duplicate Map keys and duplicate Set values in a document are invalid.

### ArrayBuffer

```json
{ "type": "array-buffer", "bytes": "AAECAw==", "properties": [] }
```

`bytes` is canonical padded standard base64 representing the complete ArrayBuffer contents. Total binary data across distinct buffers is subject to `maxBinaryBytes`.

### Typed array

```json
{
  "type": "typed-array",
  "constructor": "Uint16Array",
  "buffer": { "$ref": 0 },
  "byteOffset": 2,
  "length": 4,
  "properties": []
}
```

Supported constructors are `Int8Array`, `Uint8Array`, `Uint8ClampedArray`, `Int16Array`, `Uint16Array`, `Int32Array`, `Uint32Array`, `Float32Array`, `Float64Array`, `BigInt64Array`, and `BigUint64Array`. The buffer must reference an ArrayBuffer node. Offsets must be aligned to the element width and the view must fit within the backing buffer. Indexed values are represented by the backing bytes, not by separate JSON numbers. Custom numeric-index properties are unsupported; other enumerable own string-keyed data properties are represented by `properties`.

### DataView

```json
{
  "type": "data-view",
  "buffer": { "$ref": 0 },
  "byteOffset": 0,
  "byteLength": 4,
  "properties": []
}
```

The buffer must reference an ArrayBuffer node and the requested byte range must fit within it.

## 5. Graph semantics

1. Every distinct supported referenceable source object corresponds to exactly one node.
2. Repeated references to one source object encode references to the same node. Distinct objects remain distinct even if their contents are equal.
3. The encoder registers a node identity before traversing its outgoing edges. Self-references, mutual cycles, and arbitrary supported cycles are valid.
4. A reference may point to a node whose record appears later in `nodes`. Wire order does not constrain graph topology.
5. The decoder validates the whole node table, allocates all objects and backing buffers, allocates views, and then populates node edges. Reconstruction does not recursively expand references.
6. Map keys, Map values, Set members, RegExp `lastIndex`, custom built-in data properties, and view-to-buffer relationships are graph edges.
7. `encode` captures a synchronous snapshot. `decode` returns a newly allocated graph independent of the source graph; internal aliasing is preserved but external references and later source mutations are not.
8. The format preserves specified data and identity, not property descriptors, extensibility, inherited behavior, or arbitrary object behavior.

## 6. Supported own properties

For ordinary and null-prototype objects, only enumerable own string-keyed data properties are encoded. Inherited and non-enumerable properties are omitted. Enumerable accessors and enumerable symbol-keyed properties are rejected. Accessors are never invoked intentionally. Properties are restored as enumerable, writable, configurable data properties, using property definition rather than assignment so `__proto__` is an ordinary key.

Supported built-ins preserve their documented intrinsic state plus enumerable own string-keyed data properties where their node schema includes `properties`. Built-in accessors are not serialized as custom properties. The RegExp `lastIndex` built-in property is represented by its dedicated node field. Array custom properties are rejected. Typed-array indexed elements are represented only by backing-buffer bytes.

## 7. Versioning and validation

- Duplicate JSON object member names are rejected before graph reconstruction. Key strings are compared after JSON string escape decoding, so equivalent spellings such as `"version"` and `"\u0076ersion"` are duplicates.
- `format` must equal `jsonplus`.
- `version` must be a positive safe integer. Unknown versions produce `UNSUPPORTED_VERSION`.
- All fields and value tags must exactly match the version-1 schema.
- References must be in range and view buffers must reference ArrayBuffer nodes.
- All nodes must be reachable from the root.
- Binary payloads must be canonical base64. View offsets, lengths, and alignment are validated before allocation.
- Unknown nodes, malformed tags, duplicate property keys, duplicate Map keys, duplicate Set values, and invalid references are rejected deterministically.
- JSON+ cannot guarantee that reflecting on a Proxy has no side effects. Proxies are outside the supported semantic contract, and reflection failures are wrapped as JSONPlusError.

## 8. Resource limits

The public options are `maxNodes`, `maxEdges`, `maxBinaryBytes`, `maxStringLength`, `maxCollectionEntries`, `maxInputChars`, and `maxOutputChars`. They must be non-negative safe integers. Limits are applied during encoding or before graph allocation during decoding where possible. `maxInputChars` and `maxOutputChars` count UTF-16 code units, not UTF-8 bytes. Limits bound input/work but do not represent an exact heap budget.

## 9. Error codes

Every library-generated operational failure throws `JSONPlusError` with a stable `code`:

- `INVALID_OPTIONS`
- `UNSUPPORTED_TYPE`
- `UNSUPPORTED_PROPERTY`
- `INVALID_INPUT`
- `INVALID_ENVELOPE`
- `UNSUPPORTED_VERSION`
- `INVALID_TAG`
- `INVALID_REFERENCE`
- `INVALID_NODE`
- `INVALID_BINARY`
- `RESOURCE_LIMIT_EXCEEDED`
- `UNREACHABLE_NODE`
