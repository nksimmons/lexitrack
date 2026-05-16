const basePath = location.pathname.substring(0, location.pathname.lastIndexOf('/') + 1);
let state = null;
let gameState = null;
let dictionary = null;
const rtcPeers = new Map(); // connectionId -> { conn, playerId }
let hostPeer = null;
let nextPlayerId = 1;
let timerInterval = null;

const ROUND_DURATION = 90;
const MAX_ROUNDS = 5;
const UNIQUE_BONUS = 2;

const DICE_4x4 = [
  'AAEEGN', 'ABBJOO', 'ACHOPS', 'AFFKPS',
  'AOOTTW', 'CIMOTU', 'DEILRX', 'DELRVY',
  'DISTTY', 'EEGHNW', 'EEINSU', 'EHRTVW',
  'EIOSST', 'ELRTTY', 'HIMNQU', 'HLNNRZ',
];

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
    const lower = String(word || '').toLowerCase().trim();
    if (!/^[a-z]{3,}$/.test(lower)) return;
    if (this.wordSet.has(lower)) return;

    this.wordSet.add(lower);
    let node = this.root;
    for (const ch of lower) {
      if (!node.children[ch]) node.children[ch] = new TrieNode();
      node = node.children[ch];
    }
    node.isWord = true;
  }

  isWord(word) {
    return this.wordSet.has(String(word || '').toLowerCase().trim());
  }

  hasPrefix(prefix) {
    let node = this.root;
    for (const ch of String(prefix || '').toLowerCase()) {
      if (!node.children[ch]) return false;
      node = node.children[ch];
    }
    return true;
  }
}

function createFreshState() {
  return {
    phase: 'lobby',
    players: new Map(),
    board: null,
    round: 0,
    maxRounds: MAX_ROUNDS,
    timerEnd: null,
    roundWords: new Map(),
    validWordsOnBoard: new Set(),
    hostPlayerId: null,
    scoringPhases: null,
    playerRoundScores: null,
  };
}

gameState = createFreshState();

function sanitize(str) {
  return String(str || '').replace(/[<>&"']/g, '');
}

function sanitizeAvatar(avatar) {
  const clean = {};
  if (avatar && avatar.bgColor) {
    clean.bgColor = sanitize(String(avatar.bgColor)).substring(0, 30);
  }
  if (avatar && avatar.drawing && typeof avatar.drawing === 'string') {
    if (avatar.drawing.startsWith('data:image/png;base64,') && avatar.drawing.length <= 15000) {
      clean.drawing = avatar.drawing;
    }
  }
  return clean;
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function generateBoard() {
  const shuffledDice = shuffle([...DICE_4x4]);
  const letters = shuffledDice.map((die) => {
    const face = die[Math.floor(Math.random() * die.length)];
    return face === 'Q' ? 'Qu' : face;
  });

  return [
    letters.slice(0, 4),
    letters.slice(4, 8),
    letters.slice(8, 12),
    letters.slice(12, 16),
  ];
}

function getNeighbors(row, col, gridSize) {
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

function findAllWords(board, dict) {
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
    if (!dict.hasPrefix(newWord)) return;

    if (newWord.length >= 3 && dict.isWord(newWord)) {
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

function getBaseScore(length) {
  if (length < 3) return 0;
  if (length <= 4) return 1;
  if (length === 5) return 2;
  if (length === 6) return 3;
  if (length === 7) return 5;
  return 11;
}

function getLengthBonus(length) {
  return length >= 8 ? 1 : 0;
}

function getScore(length) {
  return getBaseScore(length) + getLengthBonus(length);
}

function scoreRound(roundWords) {
  const allWords = new Map();
  for (const [pid, words] of roundWords) {
    for (const entry of words) {
      if (!entry.valid) continue;
      if (!allWords.has(entry.word)) allWords.set(entry.word, []);
      allWords.get(entry.word).push(pid);
    }
  }

  const commonItems = [];
  const commonScores = {};
  for (const [word, finders] of allWords) {
    if (finders.length < 2) continue;
    const total = getBaseScore(word.length) + getLengthBonus(word.length);
    commonItems.push({ word, score: total, playerIds: finders });
    for (const pid of finders) {
      commonScores[pid] = (commonScores[pid] || 0) + total;
    }
  }

  const uniqueItems = [];
  const uniqueScores = {};
  for (const [word, finders] of allWords) {
    if (finders.length !== 1) continue;
    const pid = finders[0];
    const base = getBaseScore(word.length);
    const lengthBonus = getLengthBonus(word.length);
    const total = base + lengthBonus + UNIQUE_BONUS;
    uniqueItems.push({
      playerId: pid,
      word,
      baseScore: base,
      lengthBonus,
      uniqueBonus: UNIQUE_BONUS,
      totalScore: total,
    });
    uniqueScores[pid] = (uniqueScores[pid] || 0) + total;
  }

  for (const [pid, words] of roundWords) {
    for (const entry of words) {
      if (!entry.valid) {
        entry.finalScore = 0;
        entry.reason = 'invalid';
        continue;
      }
      const finders = allWords.get(entry.word) || [];
      if (finders.length > 1) {
        entry.finalScore = getBaseScore(entry.word.length) + getLengthBonus(entry.word.length);
        entry.reason = 'common';
      } else {
        entry.finalScore = getBaseScore(entry.word.length) + getLengthBonus(entry.word.length) + UNIQUE_BONUS;
        entry.reason = 'unique';
      }
    }
  }

  const playerRoundScores = {};
  for (const [pid] of roundWords) {
    playerRoundScores[pid] = (commonScores[pid] || 0) + (uniqueScores[pid] || 0);
  }

  return {
    commonItems,
    uniqueItems,
    playerRoundScores,
  };
}

function sendToRtcPlayer(playerId, payload) {
  for (const [, peer] of rtcPeers) {
    if (peer.playerId !== playerId) continue;
    if (!peer.conn || !peer.conn.open) continue;
    peer.conn.send(payload);
  }
}

function broadcastToRtcPlayers(payload) {
  for (const [, peer] of rtcPeers) {
    if (!peer.playerId) continue;
    if (!peer.conn || !peer.conn.open) continue;
    peer.conn.send(payload);
  }
}

function getPlayerList() {
  return [...gameState.players.values()].map((p) => ({
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    totalScore: p.totalScore,
    connected: p.connected,
    roundWins: p.roundWins || 0,
    stats: null,
  }));
}

function getHostState() {
  const players = getPlayerList();
  const playerWordCounts = {};
  for (const [pid, words] of gameState.roundWords) {
    playerWordCounts[pid] = words.filter((w) => w.valid).length;
  }

  let roundResults = null;
  let scoringPhases = null;
  if (gameState.phase === 'roundEnd' || gameState.phase === 'gameOver') {
    roundResults = {};
    for (const [pid, words] of gameState.roundWords) {
      roundResults[pid] = words;
    }
    scoringPhases = gameState.scoringPhases || null;
  }

  return {
    phase: gameState.phase,
    board: gameState.board,
    round: gameState.round,
    maxRounds: gameState.maxRounds,
    players: players.sort((a, b) => b.totalScore - a.totalScore),
    playerWordCounts,
    roundResults,
    scoringPhases,
    timerEnd: gameState.timerEnd,
  };
}

function getPlayerState(playerId) {
  const myWords = gameState.roundWords.get(playerId) || [];
  const playerWordCounts = {};
  for (const [pid, words] of gameState.roundWords) {
    playerWordCounts[pid] = words.filter(w => w.valid).length;
  }
  return {
    phase: gameState.phase,
    board: gameState.board,
    round: gameState.round,
    maxRounds: gameState.maxRounds,
    myWords,
    players: getPlayerList().sort((a, b) => b.totalScore - a.totalScore),
    timerEnd: gameState.timerEnd,
    hostPlayerId: gameState.hostPlayerId,
    playerWordCounts,
    lastRoundWinnerId: gameState.lastRoundWinnerId || null,
    scoringPhases: (gameState.phase === 'roundEnd' || gameState.phase === 'gameOver') ? gameState.scoringPhases : null,
    playerRoundScores: (gameState.phase === 'roundEnd' || gameState.phase === 'gameOver') ? gameState.playerRoundScores : null,
    allBoardWords: (gameState.phase === 'roundEnd' || gameState.phase === 'gameOver') ? [...gameState.validWordsOnBoard].sort() : null,
  };
}

function renderWithState(nextState) {
  state = nextState;
  render();
}

function broadcastHostState() {
  renderWithState(getHostState());
}

function broadcastPlayerList() {
  const list = getPlayerList();
  broadcastToRtcPlayers({ type: 'players', players: list });
}

function broadcastAllPlayers() {
  for (const [id] of gameState.players) {
    sendToRtcPlayer(id, { type: 'state', data: getPlayerState(id) });
  }
}

function broadcastTimer(remaining) {
  updateTimer(remaining);
  broadcastToRtcPlayers({ type: 'timer', remaining });
}

function resetGame() {
  const players = gameState.players;
  const hostPlayerId = gameState.hostPlayerId;

  for (const [, p] of players) {
    p.totalScore = 0;
    p.roundScores = [];
    p.roundWins = 0;
  }

  gameState = {
    ...createFreshState(),
    players,
    hostPlayerId,
  };
}

function startRound() {
  gameState.round++;

  const MIN_LONG_WORDS = 8;
  const MAX_ATTEMPTS = 30;
  let board;
  let allWords;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    board = generateBoard();
    allWords = findAllWords(board, dictionary);
    const longWords = [...allWords].filter((w) => w.length >= 5);
    if (longWords.length >= MIN_LONG_WORDS) break;
  }

  if (!allWords) {
    allWords = findAllWords(board, dictionary);
  }

  gameState.board = board;
  gameState.validWordsOnBoard = allWords;
  gameState.phase = 'playing';
  gameState.roundWords = new Map();
  gameState.timerEnd = Date.now() + ROUND_DURATION * 1000;

  for (const [id] of gameState.players) {
    gameState.roundWords.set(id, []);
  }

  broadcastHostState();
  broadcastAllPlayers();

  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((gameState.timerEnd - Date.now()) / 1000));
    broadcastTimer(remaining);
    if (remaining <= 0) {
      clearInterval(timerInterval);
      endRound();
    }
  }, 1000);
}

function endRound() {
  gameState.phase = gameState.round >= gameState.maxRounds ? 'gameOver' : 'roundEnd';

  const scored = scoreRound(gameState.roundWords);

  for (const [pid] of gameState.roundWords) {
    const roundScore = scored.playerRoundScores[pid] || 0;
    const player = gameState.players.get(pid);
    if (player) {
      player.roundScores.push(roundScore);
      player.totalScore += roundScore;
    }
  }

  gameState.scoringPhases = [
    { phase: 'common', items: scored.commonItems },
    { phase: 'unique', items: scored.uniqueItems },
  ];
  gameState.playerRoundScores = scored.playerRoundScores;

  let bestScore = 0;
  let winnerId = null;
  for (const [pid] of gameState.roundWords) {
    const roundScore = scored.playerRoundScores[pid] || 0;
    if (roundScore > bestScore) {
      bestScore = roundScore;
      winnerId = pid;
    }
  }
  if (winnerId) {
    const winner = gameState.players.get(winnerId);
    if (winner) winner.roundWins++;
    gameState.lastRoundWinnerId = winnerId;
  } else {
    gameState.lastRoundWinnerId = null;
  }

  broadcastHostState();
  broadcastAllPlayers();
}

function handleWordSubmission(playerId, word) {
  if (word.length < 3) {
    sendToRtcPlayer(playerId, { type: 'word-result', word, valid: false, reason: 'too short' });
    return;
  }

  const playerWords = gameState.roundWords.get(playerId) || [];
  if (playerWords.some((w) => w.word === word)) {
    sendToRtcPlayer(playerId, { type: 'word-result', word, valid: false, reason: 'already submitted' });
    return;
  }

  const inDict = dictionary.isWord(word);
  const onBoard = inDict && gameState.validWordsOnBoard.has(word);
  const valid = inDict && onBoard;
  const score = valid ? getScore(word.length) : 0;

  const entry = { word, valid, score, reason: !inDict ? 'not a word' : !onBoard ? 'not on board' : 'ok' };
  playerWords.push(entry);
  gameState.roundWords.set(playerId, playerWords);

  sendToRtcPlayer(playerId, { type: 'word-result', word, valid, score, reason: entry.reason });
  broadcastHostState();
}

function handlePathSubmission(playerId, pathIndices) {
  if (!gameState.board) return;
  const gridSize = gameState.board.length;
  const totalTiles = gridSize * gridSize;

  const seen = new Set();
  let word = '';
  for (let i = 0; i < pathIndices.length; i++) {
    const idx = pathIndices[i];
    if (typeof idx !== 'number' || idx < 0 || idx >= totalTiles) return;
    if (seen.has(idx)) return;

    if (i > 0) {
      const prevIdx = pathIndices[i - 1];
      const pr = Math.floor(prevIdx / gridSize);
      const pc = prevIdx % gridSize;
      const cr = Math.floor(idx / gridSize);
      const cc = idx % gridSize;
      if (Math.abs(pr - cr) > 1 || Math.abs(pc - cc) > 1) return;
    }

    seen.add(idx);
    const r = Math.floor(idx / gridSize);
    const c = idx % gridSize;
    word += gameState.board[r][c];
  }

  handleWordSubmission(playerId, word.toLowerCase());
}

function handlePlayerAction(playerId, action) {
  if (!playerId || !action || typeof action !== 'object') return;

  switch (action.type) {
    case 'start-game':
      if (playerId !== gameState.hostPlayerId) return;
      if (gameState.players.size === 0) return;
      if (gameState.phase !== 'lobby' && gameState.phase !== 'gameOver') return;
      resetGame();
      startRound();
      return;
    case 'next-round':
      if (playerId !== gameState.hostPlayerId) return;
      if (gameState.phase !== 'roundEnd') return;
      startRound();
      return;
    case 'restart':
      if (playerId !== gameState.hostPlayerId) return;
      resetGame();
      gameState.phase = 'lobby';
      broadcastHostState();
      broadcastAllPlayers();
      return;
    case 'submit-word':
      if (gameState.phase !== 'playing') return;
      handleWordSubmission(playerId, sanitize(action.word || '').toLowerCase().trim());
      return;
    case 'submit-path':
      if (gameState.phase !== 'playing' || !Array.isArray(action.path)) return;
      handlePathSubmission(playerId, action.path);
      return;
  }
}

function buildPlayerUrl(peerId) {
  const url = new URL('player.html', location.href);
  url.search = '?room=' + encodeURIComponent(peerId);
  return url.toString();
}

function showQrCode(url) {
  const img = document.getElementById('qr-img');
  if (!img || typeof qrcode === 'undefined') return;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    img.src = qr.createDataURL(4, 4);
  } catch (e) { console.warn('QR generation failed:', e); }
}

async function initPeerHost() {
  // Load dictionary
  const dictPath = new URL('csw19.txt', location.href).href;
  const res = await fetch(dictPath);
  if (!res.ok) throw new Error(`Failed to load dictionary (${res.status})`);
  dictionary = new Dictionary();
  const text = await res.text();
  for (const raw of text.split(/\r?\n/)) dictionary.insert(raw);

  // Host control buttons (wired up regardless of connection mode)
  document.getElementById('btn-host-start')?.addEventListener('click', () => {
    if (!gameState.players.size || (gameState.phase !== 'lobby' && gameState.phase !== 'gameOver')) return;
    resetGame();
    startRound();
  });
  document.getElementById('btn-host-next')?.addEventListener('click', () => {
    if (gameState.phase !== 'roundEnd') return;
    startRound();
  });
  document.getElementById('btn-host-restart')?.addEventListener('click', () => {
    resetGame();
    gameState.phase = 'lobby';
    broadcastHostState();
    broadcastAllPlayers();
  });

  // Trystero signaling (BitTorrent trackers — no server needed)
  hostPeer = new TrysteroHostPeer('nksimmons-lexitrack');

  hostPeer.on('open', (id) => {
    const playerUrl = buildPlayerUrl(id);
    showQrCode(playerUrl);
    const urlEl = document.getElementById('join-url');
    if (urlEl) urlEl.textContent = playerUrl;
  });

  hostPeer.on('connection', (conn) => {
    const connectionId = Math.random().toString(36).slice(2, 8).toUpperCase();
    rtcPeers.set(connectionId, { conn, playerId: null });

    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'player-join') {
        const name = sanitize(msg.name || 'Player').substring(0, 20);
        const avatar = sanitizeAvatar(msg.avatar || {});
        const deviceId = sanitize(msg.deviceId || '').substring(0, 64);
        const existing = [...gameState.players.values()].find(p => p.deviceId && deviceId && p.deviceId === deviceId);
        let pid;
        if (existing) {
          pid = existing.id;
          existing.connected = true;
          rtcPeers.get(connectionId).playerId = pid;
          conn.send({ type: 'reconnected', playerId: pid, data: getPlayerState(pid) });
        } else {
          pid = String(nextPlayerId++);
          gameState.players.set(pid, { id: pid, name, avatar, deviceId, totalScore: 0, roundScores: [], roundWins: 0, connected: true });
          if (!gameState.hostPlayerId) gameState.hostPlayerId = pid;
          rtcPeers.get(connectionId).playerId = pid;
          conn.send({ type: 'joined', playerId: pid, data: getPlayerState(pid), profile: null });
        }
        broadcastHostState();
        broadcastPlayerList();
        broadcastAllPlayers();
        return;
      }

      if (msg.type === 'reconnect') {
        const devId = sanitize(msg.deviceId || '').substring(0, 64);
        const existing = [...gameState.players.values()].find(p => p.deviceId === devId);
        if (existing) {
          existing.connected = true;
          rtcPeers.get(connectionId).playerId = existing.id;
          conn.send({ type: 'reconnected', playerId: existing.id, data: getPlayerState(existing.id) });
          broadcastHostState();
          broadcastPlayerList();
        } else {
          conn.send({ type: 'unknown-device' });
        }
        return;
      }

      if (['submit-word', 'submit-path', 'start-game', 'next-round', 'restart'].includes(msg.type)) {
        const peer = rtcPeers.get(connectionId);
        handlePlayerAction(peer?.playerId, msg);
        return;
      }
    });

    conn.on('close', () => {
      const peer = rtcPeers.get(connectionId);
      if (peer?.playerId && gameState.players.has(peer.playerId)) {
        gameState.players.get(peer.playerId).connected = false;
        broadcastHostState();
        broadcastPlayerList();
      }
      rtcPeers.delete(connectionId);
    });
  });

  hostPeer.on('error', err => console.error('[PeerJS] error:', err));
  renderWithState(getHostState());
}

initPeerHost().catch(err => {
  const joinEl = document.getElementById('join-url');
  if (joinEl) joinEl.textContent = `Failed to initialize host: ${err.message}`;
  console.error(err);
});

function render() {
  if (!state) return;

  // Show correct screen
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screenId = `screen-${state.phase}`;
  const screen = document.getElementById(screenId);
  if (screen) screen.classList.add('active');

  // Reset animation tracking if we've moved past roundEnd
  if (state.phase !== 'roundEnd' && state.phase !== 'gameOver') {
    scoringAnimationActive = false;
    scoringAnimationDoneForRound = -1;
  }

  switch (state.phase) {
    case 'lobby': renderLobby(); break;
    case 'playing': renderPlaying(); break;
    case 'roundEnd':
      if (!scoringAnimationActive && scoringAnimationDoneForRound !== state.round) renderRoundEnd();
      break;
    case 'gameOver': renderGameOver(); break;
  }
}

// --- LOBBY ---
function renderLobby() {
  const container = document.getElementById('lobby-players');
  container.innerHTML = state.players.map(p => `
    <div class="player-card">
      <div class="avatar" style="background:${p.avatar.bgColor || '#4a3a6e'}">${renderAvatarContent(p.avatar, p.roundWins)}</div>
      <div class="player-name">${esc(p.name)}</div>
    </div>
  `).join('');
}

// --- PLAYING ---
function renderPlaying() {
  document.getElementById('round-num').textContent = state.round;
  document.getElementById('max-rounds').textContent = state.maxRounds;
  renderBoard();
  renderScoreboard(document.getElementById('scoreboard'));
}

function renderBoard() {
  const container = document.getElementById('board');
  if (!state.board) return;
  container.innerHTML = state.board.flat().map(letter => `
    <div class="tile">${letter}</div>
  `).join('');
}

let previousWordCounts = {};

function renderScoreboard(container) {
  const leader = state.players[0];
  container.innerHTML = state.players.map(p => {
    const wordCount = state.playerWordCounts ? (state.playerWordCounts[p.id] || 0) : '';
    const isLeader = p === leader && p.totalScore > 0;
    const prevCount = previousWordCounts[p.id] || 0;
    const isNew = wordCount !== '' && wordCount > prevCount;
    return `
      <div class="player-card ${isLeader ? 'leader' : ''}" ${!p.connected ? 'style="opacity:0.4"' : ''} id="host-player-${p.id}">
        <div class="avatar" style="background:${p.avatar.bgColor || '#4a3a6e'}">${renderAvatarContent(p.avatar, p.roundWins)}</div>
        <div class="player-name">${esc(p.name)}</div>
        <div class="player-score">${p.totalScore}</div>
        ${wordCount !== '' ? `<div class="player-words-count ${isNew ? 'word-count-bump' : ''}">${wordCount} words</div>` : ''}
      </div>
    `;
  }).join('');

  // Track counts for next render
  if (state.playerWordCounts) {
    previousWordCounts = { ...state.playerWordCounts };
  }
}

function updateTimer(remaining) {
  const el = document.getElementById('timer');
  if (!el) return;
  el.textContent = remaining;
  el.className = 'timer';
  if (remaining <= 10) el.classList.add('danger');
  else if (remaining <= 30) el.classList.add('warning');
}

// --- ROUND END (animated scoring) ---
let scoringAnimationActive = false;
let scoringAnimationDoneForRound = -1;

function renderRoundEnd() {
  document.getElementById('round-end-num').textContent = state.round;
  const container = document.getElementById('round-results');
  const standingsCard = document.getElementById('standings').closest('.card') || document.getElementById('standings').parentElement;

  // Hide standings during animation
  if (standingsCard) standingsCard.style.display = 'none';

  // Build the scoring animation area
  container.innerHTML = `
    <div id="scoring-animation">
      <div id="scoring-players" class="scoring-players"></div>
      <div id="scoring-phase-label" class="scoring-phase-label"></div>
      <div id="scoring-words" class="scoring-words"></div>
    </div>
  `;

  // Render player score cards for animation
  const playersEl = document.getElementById('scoring-players');
  playersEl.innerHTML = state.players.map(p => `
    <div class="scoring-player-card" id="scoring-player-${p.id}">
      <div class="avatar" style="background:${p.avatar.bgColor || '#4a3a6e'}">${renderAvatarContent(p.avatar, p.roundWins)}</div>
      <div class="player-name">${esc(p.name)}</div>
      <div class="scoring-player-score" id="score-display-${p.id}">${p.totalScore - getRoundScore(p.id)}</div>
      <div class="score-float-container" id="float-${p.id}"></div>
    </div>
  `).join('');

  if (state.scoringPhases) {
    scoringAnimationActive = true;
    animateScoring(state.scoringPhases, () => {
      scoringAnimationActive = false;
      scoringAnimationDoneForRound = state.round;
      // Update to final scores
      state.players.forEach(p => {
        const el = document.getElementById(`score-display-${p.id}`);
        if (el) el.textContent = p.totalScore;
      });
      // Show standings
      if (standingsCard) standingsCard.style.display = '';
      renderScoreboard(document.getElementById('standings'));
    });
  } else {
    renderScoreboard(document.getElementById('standings'));
    if (standingsCard) standingsCard.style.display = '';
  }
}

function getRoundScore(playerId) {
  if (!state.roundResults) return 0;
  const words = state.roundResults[playerId] || [];
  return words.reduce((s, w) => s + (w.finalScore || 0), 0);
}

function animateScoring(phases, onComplete) {
  const commonPhase = phases.find(p => p.phase === 'common');
  const uniquePhase = phases.find(p => p.phase === 'unique');

  const runningScores = {};
  state.players.forEach(p => {
    runningScores[p.id] = p.totalScore - getRoundScore(p.id);
  });

  const phaseLabel = document.getElementById('scoring-phase-label');
  const wordsEl = document.getElementById('scoring-words');

  // Phase 1: Common words
  phaseLabel.textContent = '🤝 Common Words';
  phaseLabel.className = 'scoring-phase-label fade-in';
  wordsEl.innerHTML = '';

  let delay = 600;

  if (commonPhase && commonPhase.items.length > 0) {
    // Show common words one by one
    commonPhase.items.forEach((item, i) => {
      setTimeout(() => {
        const tag = document.createElement('span');
        tag.className = 'word-tag common pop-in';
        tag.innerHTML = `${esc(item.word.toUpperCase())} <span class="score">+${item.score}</span>`;
        wordsEl.appendChild(tag);

        // Float score to each player who found it
        item.playerIds.forEach(pid => {
          runningScores[pid] += item.score;
          floatScore(pid, `+${item.score}`, runningScores[pid]);
        });
      }, delay + i * 400);
    });
    delay += commonPhase.items.length * 400 + 1200;
  } else {
    setTimeout(() => {
      wordsEl.innerHTML = '<div style="color:var(--text-dim);text-align:center;padding:1rem">No common words this round!</div>';
    }, delay);
    delay += 1500;
  }

  // Phase 2: Unique words
  setTimeout(() => {
    phaseLabel.textContent = '⭐ Unique Words (+' + UNIQUE_BONUS + ' bonus each)';
    phaseLabel.className = 'scoring-phase-label fade-in';
    wordsEl.innerHTML = '';

    if (uniquePhase && uniquePhase.items.length > 0) {
      uniquePhase.items.forEach((item, i) => {
        setTimeout(() => {
          const playerName = state.players.find(p => p.id === item.playerId);
          const tag = document.createElement('span');
          tag.className = 'word-tag valid pop-in';
          const bonusText = item.lengthBonus > 0 ? ` (${item.baseScore}+${item.lengthBonus}+${item.uniqueBonus})` : '';
          tag.innerHTML = `${esc(item.word.toUpperCase())} <span class="score">+${item.totalScore}${bonusText}</span>`;
          wordsEl.appendChild(tag);

          runningScores[item.playerId] += item.totalScore;
          floatScore(item.playerId, `+${item.totalScore}`, runningScores[item.playerId]);
        }, i * 350);
      });

      setTimeout(onComplete, uniquePhase.items.length * 350 + 1500);
    } else {
      wordsEl.innerHTML = '<div style="color:var(--text-dim);text-align:center;padding:1rem">No unique words this round!</div>';
      setTimeout(onComplete, 1500);
    }
  }, delay);
}

function floatScore(playerId, text, newTotal) {
  const container = document.getElementById(`float-${playerId}`);
  const scoreEl = document.getElementById(`score-display-${playerId}`);
  if (!container) return;

  const float = document.createElement('div');
  float.className = 'score-float';
  float.textContent = text;
  container.appendChild(float);
  setTimeout(() => float.remove(), 1200);

  // Update displayed score
  if (scoreEl) {
    setTimeout(() => { scoreEl.textContent = newTotal; }, 400);
  }
}

function renderResults(container) {
  if (!state.roundResults) return;
  container.innerHTML = state.players.map(p => {
    const words = state.roundResults[p.id] || [];
    const roundScore = words.reduce((s, w) => s + (w.finalScore || 0), 0);
    return `
      <div class="result-card">
        <div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:0.5rem">
          <div class="avatar" style="background:${p.avatar.bgColor || '#4a3a6e'};width:40px;height:40px;font-size:1.2rem">${renderAvatarContent(p.avatar, p.roundWins)}</div>
          <div class="name">${esc(p.name)}</div>
          <div class="round-score" style="margin-left:auto">+${roundScore}</div>
        </div>
        <ul class="word-list">
          ${words.map(w => {
            let cls = 'invalid';
            if (w.reason === 'unique') cls = 'valid';
            else if (w.reason === 'common') cls = 'common';
            return `<li class="word-tag ${cls}">${esc(w.word)}${w.finalScore ? `<span class="score">+${w.finalScore}</span>` : ''}</li>`;
          }).join('')}
        </ul>
      </div>
    `;
  }).join('');
}

// --- GAME OVER ---
function renderGameOver() {
  const sorted = [...state.players].sort((a, b) => b.totalScore - a.totalScore);
  const podium = document.getElementById('podium');

  const places = [
    { cls: 'first', rank: '🥇', label: 'gold' },
    { cls: 'second', rank: '🥈', label: 'silver' },
    { cls: 'third', rank: '🥉', label: 'bronze' },
  ];

  podium.innerHTML = sorted.slice(0, 3).map((p, i) => `
    <div class="podium-place ${places[i].cls}">
      <div class="avatar avatar-large" style="background:${p.avatar.bgColor || '#4a3a6e'}">${renderAvatarContent(p.avatar, p.roundWins)}</div>
      <div class="podium-rank ${places[i].label}">${places[i].rank}</div>
      <div class="player-name">${esc(p.name)}</div>
      <div class="player-score">${p.totalScore}</div>
    </div>
  `).join('');

  renderScoreboard(document.getElementById('final-scores'));
  renderResults(document.getElementById('final-round-results'));
}

// --- UTILS ---
function renderAvatarContent(avatar, roundWins) {
  const crown = roundWins > 0 ? '<span class="avatar-crown">👑</span>' : '';
  if (avatar.drawing) {
    return crown + `<img src="${avatar.drawing}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  }
  return crown + '🎲';
}

function esc(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}
