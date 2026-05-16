// Processes the bundled ENABLE (Enhanced North American Benchmark Lexicon) dictionary
const fs = require('fs');
const path = require('path');

const INPUT = path.join(__dirname, 'enable1.txt');
const OUTPUT = path.join(__dirname, 'data', 'words.txt');

function main() {
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  const raw = fs.readFileSync(INPUT, 'utf-8').split('\n');
  const filtered = raw
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length >= 3 && /^[a-z]+$/.test(w));

  fs.writeFileSync(OUTPUT, filtered.join('\n'));
  console.log(`Saved ${filtered.length} words to ${OUTPUT}`);
}

main();
