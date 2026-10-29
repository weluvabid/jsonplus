import { decode, encode } from "../dist/index.js";

const WARMUP_RUNS = 3;
const MEASURED_RUNS = 9;

function statistics(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)],
  };
}

function measure(name, run, iterations = MEASURED_RUNS) {
  for (let iteration = 0; iteration < WARMUP_RUNS; iteration += 1) run();

  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }

  const result = statistics(samples);
  const summary = `${name}: median ${result.median.toFixed(2)} ms; p95 ${result.p95.toFixed(2)} ms`;
  console.log(`${summary} over ${iterations} runs`);
}

function kibibytes(characters) {
  return `${(characters / 1024).toFixed(1)} KiB`;
}

console.log(`Node ${process.version}; ${WARMUP_RUNS} warmups per measurement`);

// Plain tree: both formats receive the exact same supported data. This shows JSON+'s overhead
// when graph-specific semantics are not needed; it is not a claim that the formats are equivalent.
const plain = Array.from({ length: 20_000 }, (_, index) => ({ index, label: `item-${index}` }));
const plainJSON = JSON.stringify(plain);
const plainJSONPlus = encode(plain);
console.log("\nPlain object tree (same logical data)");
console.log(`JSON size: ${kibibytes(plainJSON.length)}`);
console.log(`JSON+ size: ${kibibytes(plainJSONPlus.length)}`);
measure("JSON.stringify", () => JSON.stringify(plain));
measure("JSON.parse", () => JSON.parse(plainJSON));
measure("JSON+ encode", () => encode(plain));
measure("JSON+ decode", () => decode(plainJSONPlus));

// Graph workload: JSON.stringify cannot preserve the aliases/cycle and BigInt in this graph.
const graph = { items: plain, marker: 7n };
graph.self = graph;
graph.alias = plain;
const graphJSONPlus = encode(graph);
const graphRoundTrip = decode(graphJSONPlus);
if (graphRoundTrip.self !== graphRoundTrip || graphRoundTrip.items !== graphRoundTrip.alias) {
  throw new Error("Graph benchmark failed its identity checks.");
}
console.log("\nAliased cyclic graph (JSON+ only; different semantics from a plain JSON tree)");
console.log(`JSON+ size: ${kibibytes(graphJSONPlus.length)}`);
measure("JSON+ graph encode", () => encode(graph));
measure("JSON+ graph decode", () => decode(graphJSONPlus));

// Binary workload: several views share one backing buffer. The benchmark intentionally times
// the full graph operation, including base64 transport encoding/decoding.
const buffer = new ArrayBuffer(2 * 1024 * 1024);
const bufferBytes = new Uint8Array(buffer);
for (let index = 0; index < bufferBytes.length; index += 4096) {
  bufferBytes[index] = index & 0xff;
}
const views = Array.from({ length: 64 }, (_, index) => new Uint8Array(buffer, index * 16, 1024));
const binaryGraph = { buffer, views, view: new DataView(buffer, 128, 2048) };
const binaryJSONPlus = encode(binaryGraph);
const binaryRoundTrip = decode(binaryJSONPlus);
if (
  binaryRoundTrip.buffer !== binaryRoundTrip.views[0]?.buffer ||
  binaryRoundTrip.buffer !== binaryRoundTrip.view.buffer
) {
  throw new Error("Binary benchmark failed its backing-buffer identity checks.");
}
console.log("\n2 MiB ArrayBuffer shared by 65 views");
console.log(`JSON+ size: ${kibibytes(binaryJSONPlus.length)}`);
measure("JSON+ binary encode", () => encode(binaryGraph), 7);
measure("JSON+ binary decode", () => decode(binaryJSONPlus), 7);
