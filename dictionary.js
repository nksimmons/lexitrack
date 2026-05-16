const fs = require('fs');
const path = require('path');

class TrieNode {
  constructor() {
    this.children = {};
    this.isWord = false;
  }
}

class Dictionary {
  constructor() {
    this.root = new TrieNode();
    this.wordSet = new Set();
  }

  insert(word) {
    const lower = word.toLowerCase().trim();
    if (lower.length < 3) return;
    this.wordSet.add(lower);
    let node = this.root;
    for (const ch of lower) {
      if (!node.children[ch]) node.children[ch] = new TrieNode();
      node = node.children[ch];
    }
    node.isWord = true;
  }

  isWord(word) {
    return this.wordSet.has(word.toLowerCase().trim());
  }

  hasPrefix(prefix) {
    let node = this.root;
    for (const ch of prefix.toLowerCase()) {
      if (!node.children[ch]) return false;
      node = node.children[ch];
    }
    return true;
  }

  get size() {
    return this.wordSet.size;
  }
}

function loadDictionary() {
  const dict = new Dictionary();
  const dictPath = path.join(__dirname, 'data', 'words.txt');

  if (!fs.existsSync(dictPath)) {
    console.error(`Dictionary not found at ${dictPath}`);
    console.error('Attempting to use system dictionary...');

    // Try common system dictionary locations
    const systemPaths = [
      '/usr/share/dict/words',
      '/usr/share/dict/american-english',
    ];
    for (const sp of systemPaths) {
      if (fs.existsSync(sp)) {
        console.log(`Loading system dictionary from ${sp}`);
        const words = fs.readFileSync(sp, 'utf-8').split('\n');
        for (const w of words) {
          const clean = w.trim().toLowerCase();
          // Only include words with basic letters, no proper nouns
          if (clean.length >= 3 && /^[a-z]+$/.test(clean) && clean[0] === clean[0].toLowerCase()) {
            dict.insert(clean);
          }
        }
        console.log(`Loaded ${dict.size} words from system dictionary`);
        return dict;
      }
    }

    console.error('No dictionary found! Run: node download-dictionary.js');
    process.exit(1);
  }

  const words = fs.readFileSync(dictPath, 'utf-8').split('\n');
  for (const w of words) {
    const clean = w.trim().toLowerCase();
    if (clean.length >= 3 && /^[a-z]+$/.test(clean)) {
      dict.insert(clean);
    }
  }
  console.log(`Loaded ${dict.size} words`);
  return dict;
}

module.exports = { Dictionary, loadDictionary };
