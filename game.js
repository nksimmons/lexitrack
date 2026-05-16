// Classic 4×4 letter dice
const DICE_4x4 = [
  'AAEEGN', 'ABBJOO', 'ACHOPS', 'AFFKPS',
  'AOOTTW', 'CIMOTU', 'DEILRX', 'DELRVY',
  'DISTTY', 'EEGHNW', 'EEINSU', 'EHRTVW',
  'EIOSST', 'ELRTTY', 'HIMNQU', 'HLNNRZ',
];

// 5×5 extended letter dice
const DICE_5x5 = [
  'AAAFRS', 'AAEEEE', 'AAFIRS', 'ADENNN', 'AEEEEM',
  'AEEGMU', 'AEGMNN', 'AFIRSY', 'BJKQXZ', 'CCENST',
  'CEIILT', 'CEILPT', 'CEIPST', 'DDHNOT', 'DHHLOR',
  'DHLNOR', 'DHLNOR', 'EIIITT', 'EMOTTT', 'ENSSSU',
  'FIPRSY', 'GORRVW', 'IPRRRY', 'NOOTUW', 'OOOTTU',
];

// For grids larger than 5x5 we generate random dice from letter frequencies
const LETTER_FREQ = 'EEEEEEEEEEEEAAAAAAAAAIIIIIIIIIOOOOOOOONNNNNNRRRRRRTTTTTTLLLLSSSSUUUUDDDDGGGBBCCMMPPFFHHVVWWYYKJXQZ';

const DEFAULT_GRID_SIZE = 4;

// Scoring: 3-letter = 1pt, each additional letter = +1pt (4=2, 5=3, 6=4, etc.)
// Unique words (not shared) = double points
function getScore(wordLength) {
  if (wordLength < 3) return 0;
  return wordLength - 2;
}

// Shuffle array in place (Fisher-Yates)
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// Generate a board of gridSize x gridSize
function generateBoard(gridSize) {
  gridSize = gridSize || DEFAULT_GRID_SIZE;
  const totalTiles = gridSize * gridSize;
  let letters;

  if (gridSize === 4) {
    const shuffledDice = shuffle([...DICE_4x4]);
    letters = shuffledDice.map(die => {
      const face = die[Math.floor(Math.random() * 6)];
      return face === 'Q' ? 'Qu' : face;
    });
  } else if (gridSize === 5) {
    const shuffledDice = shuffle([...DICE_5x5]);
    letters = shuffledDice.map(die => {
      const face = die[Math.floor(Math.random() * 6)];
      return face === 'Q' ? 'Qu' : face;
    });
  } else {
    // For 6x6 and larger, pick random letters weighted by frequency
    letters = [];
    for (let i = 0; i < totalTiles; i++) {
      const ch = LETTER_FREQ[Math.floor(Math.random() * LETTER_FREQ.length)];
      letters.push(ch === 'Q' ? 'Qu' : ch);
    }
  }

  const board = [];
  for (let r = 0; r < gridSize; r++) {
    board.push(letters.slice(r * gridSize, r * gridSize + gridSize));
  }
  return board;
}

// Get adjacent positions for a cell in an NxN grid
function getNeighbors(row, col, gridSize) {
  gridSize = gridSize || DEFAULT_GRID_SIZE;
  const neighbors = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = row + dr;
      const nc = col + dc;
      if (nr >= 0 && nr < gridSize && nc >= 0 && nc < gridSize) {
        neighbors.push([nr, nc]);
      }
    }
  }
  return neighbors;
}

// Check if a word can be formed on the board via adjacent path (no reuse)
function isWordOnBoard(board, word) {
  const gridSize = board.length;
  const totalTiles = gridSize * gridSize;
  const upper = word.toUpperCase();
  const flatBoard = [];
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      flatBoard.push(board[r][c].toUpperCase());
    }
  }

  function dfs(pos, charIdx, visited) {
    const r = Math.floor(pos / gridSize);
    const c = pos % gridSize;
    const cell = flatBoard[pos];

    if (cell === 'QU') {
      if (upper.substring(charIdx, charIdx + 2) !== 'QU') return false;
      charIdx += 2;
    } else {
      if (upper[charIdx] !== cell) return false;
      charIdx += 1;
    }

    if (charIdx === upper.length) return true;

    visited.add(pos);
    const neighbors = getNeighbors(r, c, gridSize);
    for (const [nr, nc] of neighbors) {
      const npos = nr * gridSize + nc;
      if (!visited.has(npos)) {
        if (dfs(npos, charIdx, new Set(visited))) return true;
      }
    }
    return false;
  }

  for (let pos = 0; pos < totalTiles; pos++) {
    if (dfs(pos, 0, new Set())) return true;
  }
  return false;
}

// Find ALL valid words on the board (uses Trie prefix pruning for speed)
function findAllWords(board, dictionary) {
  const gridSize = board.length;
  const totalTiles = gridSize * gridSize;
  const maxWordLen = totalTiles;
  const found = new Set();
  const flatBoard = [];
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      flatBoard.push(board[r][c].toLowerCase());
    }
  }

  function dfs(pos, word, visited) {
    const cell = flatBoard[pos];
    const newWord = word + cell;

    if (newWord.length > maxWordLen) return;

    if (!dictionary.hasPrefix(newWord)) return;

    if (newWord.length >= 3 && dictionary.isWord(newWord)) {
      found.add(newWord);
    }

    const r = Math.floor(pos / gridSize);
    const c = pos % gridSize;
    const neighbors = getNeighbors(r, c, gridSize);
    for (const [nr, nc] of neighbors) {
      const npos = nr * gridSize + nc;
      if (!visited.has(npos)) {
        visited.add(npos);
        dfs(npos, newWord, visited);
        visited.delete(npos);
      }
    }
  }

  for (let pos = 0; pos < totalTiles; pos++) {
    const visited = new Set([pos]);
    dfs(pos, '', visited);
  }

  return found;
}

// Find all tile positions that participate in at least one valid word
function findUsedTiles(board, dictionary) {
  const gridSize = board.length;
  const totalTiles = gridSize * gridSize;
  const maxWordLen = totalTiles;
  const usedTiles = new Set();
  const flatBoard = [];
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      flatBoard.push(board[r][c].toLowerCase());
    }
  }

  function dfs(pos, word, visited) {
    const cell = flatBoard[pos];
    const newWord = word + cell;
    if (newWord.length > maxWordLen) return;
    if (!dictionary.hasPrefix(newWord)) return;

    if (newWord.length >= 3 && dictionary.isWord(newWord)) {
      for (const t of visited) usedTiles.add(t);
    }

    if (usedTiles.size === totalTiles) return;

    const r = Math.floor(pos / gridSize);
    const c = pos % gridSize;
    const neighbors = getNeighbors(r, c, gridSize);
    for (const [nr, nc] of neighbors) {
      const npos = nr * gridSize + nc;
      if (!visited.has(npos)) {
        visited.add(npos);
        dfs(npos, newWord, visited);
        visited.delete(npos);
        if (usedTiles.size === totalTiles) return;
      }
    }
  }

  for (let pos = 0; pos < totalTiles; pos++) {
    if (usedTiles.has(pos)) continue;
    const visited = new Set([pos]);
    dfs(pos, '', visited);
  }

  return usedTiles;
}

module.exports = {
  DEFAULT_GRID_SIZE,
  getScore,
  generateBoard,
  isWordOnBoard,
  findAllWords,
  findUsedTiles,
  shuffle,
};
