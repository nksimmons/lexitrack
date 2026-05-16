const { performance } = require('perf_hooks');
const { loadDictionary } = require('../dictionary');
const { generateBoard, findAllWords } = require('../game');

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor((p / 100) * sortedValues.length)));
  return sortedValues[index];
}

function runBench(rounds = 40) {
  const dictionary = loadDictionary();
  const durationsMs = [];
  let totalWords = 0;

  console.log(`Benchmarking board search for ${rounds} rounds...`);
  const startedAt = performance.now();

  for (let i = 0; i < rounds; i += 1) {
    const board = generateBoard(4);
    const t0 = performance.now();
    const words = findAllWords(board, dictionary);
    const t1 = performance.now();

    durationsMs.push(t1 - t0);
    totalWords += words.size;
  }

  const endedAt = performance.now();
  durationsMs.sort((a, b) => a - b);

  const sum = durationsMs.reduce((acc, value) => acc + value, 0);
  const avg = durationsMs.length ? sum / durationsMs.length : 0;

  console.log('--- Results ---');
  console.log(`Dictionary size: ${dictionary.size.toLocaleString()} words`);
  console.log(`Total runtime: ${(endedAt - startedAt).toFixed(2)} ms`);
  console.log(`Average words/board: ${(totalWords / rounds).toFixed(1)}`);
  console.log(`Search time avg: ${avg.toFixed(2)} ms`);
  console.log(`Search time p50: ${percentile(durationsMs, 50).toFixed(2)} ms`);
  console.log(`Search time p90: ${percentile(durationsMs, 90).toFixed(2)} ms`);
  console.log(`Search time p99: ${percentile(durationsMs, 99).toFixed(2)} ms`);
}

const roundsArg = Number.parseInt(process.argv[2] || '40', 10);
const rounds = Number.isNaN(roundsArg) || roundsArg <= 0 ? 40 : roundsArg;
runBench(rounds);
