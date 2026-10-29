import { decode, encode } from "../dist/index.js";

function measure(name, run, iterations = 5) {
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  const median = samples[Math.floor(samples.length / 2)];
  console.log(`${name}: median ${median.toFixed(2)} ms over ${iterations} runs`);
}

const plain = Array.from({ length: 20_000 }, (_, index) => ({ index, label: `item-${index}` }));
const graph = { items: plain, marker: 7n };
graph.self = graph;
graph.alias = plain;

const json = JSON.stringify(plain);
const encoded = encode(graph);

console.log(`Plain JSON input: ${(json.length / 1024).toFixed(1)} KiB`);
console.log(`JSON+ graph input: ${(encoded.length / 1024).toFixed(1)} KiB`);
measure("JSON.stringify plain tree", () => JSON.stringify(plain));
measure("JSON+ encode graph", () => encode(graph));
measure("JSON+ decode graph", () => decode(encoded));
