// combined.js — self-contained host+player for GitHub Pages (no server needed)
// Loads AFTER PeerJS and QRCode CDN scripts. Does NOT depend on player.js or host.js.

// ─── Constants ────────────────────────────────────────────────────────────────
const BG_COLORS = ['#e63946','#457b9d','#2a9d8f','#e9c46a','#f4a261','#264653','#6a4c93','#1982c4','#8ac926','#ff595e','#ff924c','#c77dff'];
const DRAW_COLORS = ['#ffffff','#ff4444','#ff8800','#ffdd00','#44cc44','#2299ff','#aa44ff','#ff66cc','#88ccff','#aaaaaa'];
const DICE_4x4 = [
  'AAEEGN', 'ABBJOO', 'ACHOPS', 'AFFKPS',
  'AOOTTW', 'CIMOTU', 'DEILRX', 'DELRVY',
  'DISTTY', 'EEGHNW', 'EEINSU', 'EHRTVW',
  'EIOSST', 'ELRTTY', 'HIMNQU', 'HLNNRZ',
];
const DICE_5x5 = [
  'AAAFRS', 'AAEEEE', 'AAFIRS', 'ADENNN', 'AEEEEM',
  'AEEGMU', 'AEGMNN', 'AFIRSY', 'BJKQXZ', 'CCENST',
  'CEIILT', 'CEILPT', 'CEIPST', 'DDHNOT', 'DHHLOR',
  'DHLNOR', 'DHLNOR', 'EIIITT', 'EMOTTT', 'ENSSSU',
  'FIPRSY', 'GORRVW', 'IPRRRY', 'NOOTUW', 'OOOTTU',
];
const LETTER_FREQ = 'EEEEEEEEEEEEAAAAAAAAAIIIIIIIIIOOOOOOOONNNNNNRRRRRRTTTTTTLLLLSSSSUUUUDDDDGGGBBCCMMPPFFHHVVWWYYKJXQZ';
const DEFAULT_ROUND_DURATION = 90;
const DEFAULT_MAX_ROUNDS = 5;
const DEFAULT_GRID_SIZE = 4;

// ─── Dictionary ───────────────────────────────────────────────────────────────
class TrieNode { constructor() { this.children = {}; this.isWord = false; } }

class Dictionary {
  constructor() { this.root = new TrieNode(); this.wordSet = new Set(); }
  insert(word) {
    const w = String(word || '').toLowerCase().trim();
    if (!/^[a-z]{3,}$/.test(w) || this.wordSet.has(w)) return;
    this.wordSet.add(w);
    let n = this.root;
    for (const ch of w) { if (!n.children[ch]) n.children[ch] = new TrieNode(); n = n.children[ch]; }
    n.isWord = true;
  }
  isWord(w) { return this.wordSet.has(String(w || '').toLowerCase().trim()); }
  hasPrefix(p) {
    let n = this.root;
    for (const ch of String(p || '').toLowerCase()) { if (!n.children[ch]) return false; n = n.children[ch]; }
    return true;
  }
}

// ─── State ────────────────────────────────────────────────────────────────────
let dictionary = null;
let myPlayerId = null;
let myState = null;
let timerInterval = null;
let nextPlayerId = 1;
let hostPeer = null;
const rtcPeers = new Map(); // connId -> { conn, playerId }
let gameState = null;

// Player UI state
let selectedPath = [];
let isDragging = false;
let avatarChoice = { drawing: null, bgColor: BG_COLORS[0] };
let drawCtx, drawCanvas;
let drawStrokes = [];
let currentStroke = null;
let drawColor = DRAW_COLORS[0];
let isDrawing = false;
let audioCtx = null;

// ─── Identity ─────────────────────────────────────────────────────────────────
function getDeviceId() {
  let id = localStorage.getItem('lexitrack-device-id');
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2));
    localStorage.setItem('lexitrack-device-id', id);
  }
  return id;
}
function saveProfile(name, avatar) {
  localStorage.setItem('lexitrack-name', name);
  localStorage.setItem('lexitrack-avatar', JSON.stringify(avatar));
}
function loadProfile() {
  const name = localStorage.getItem('lexitrack-name');
  let avatar = null;
  try { avatar = JSON.parse(localStorage.getItem('lexitrack-avatar') || 'null'); } catch {}
  return { name, avatar };
}
const deviceId = getDeviceId();

// ─── Sanitization ─────────────────────────────────────────────────────────────
function sanitize(str) { return String(str || '').replace(/[<>&"']/g, ''); }
function esc(str) { const el = document.createElement('span'); el.textContent = str; return el.innerHTML; }
function sanitizeAvatar(av) {
  const c = {};
  if (av && av.bgColor) c.bgColor = sanitize(String(av.bgColor)).substring(0, 30);
  if (av && av.drawing && typeof av.drawing === 'string' && av.drawing.startsWith('data:image/png;base64,') && av.drawing.length <= 15000) c.drawing = av.drawing;
  return c;
}

// ─── Game State ───────────────────────────────────────────────────────────────
function createFreshState() {
  return { phase: 'lobby', players: new Map(), board: null, round: 0, maxRounds: DEFAULT_MAX_ROUNDS, timerEnd: null, roundWords: new Map(), validWordsOnBoard: new Set(), hostPlayerId: null, scoringPhases: null, gridSize: DEFAULT_GRID_SIZE, roundDuration: DEFAULT_ROUND_DURATION };
}
gameState = createFreshState();

function resetGame() {
  const players = gameState.players;
  const hostPlayerId = gameState.hostPlayerId;
  for (const [, p] of players) { p.totalScore = 0; p.roundScores = []; p.roundWins = 0; }
  gameState = { ...createFreshState(), players, hostPlayerId };
}

// ─── Board ────────────────────────────────────────────────────────────────────
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr;
}
function generateBoard(gridSize) {
  gridSize = gridSize || 4;
  const totalTiles = gridSize * gridSize;
  let letters;
  if (gridSize === 4) {
    const sd = shuffle([...DICE_4x4]);
    letters = sd.map(d => { const f = d[Math.floor(Math.random() * d.length)]; return f === 'Q' ? 'Qu' : f; });
  } else if (gridSize === 5) {
    const sd = shuffle([...DICE_5x5]);
    letters = sd.map(d => { const f = d[Math.floor(Math.random() * d.length)]; return f === 'Q' ? 'Qu' : f; });
  } else {
    letters = [];
    for (let i = 0; i < totalTiles; i++) {
      const ch = LETTER_FREQ[Math.floor(Math.random() * LETTER_FREQ.length)];
      letters.push(ch === 'Q' ? 'Qu' : ch);
    }
  }
  const board = [];
  for (let r = 0; r < gridSize; r++) board.push(letters.slice(r * gridSize, r * gridSize + gridSize));
  return board;
}
function getNeighbors4(row, col, g) {
  const n = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (dr === 0 && dc === 0) continue;
    const nr = row + dr, nc = col + dc;
    if (nr >= 0 && nr < g && nc >= 0 && nc < g) n.push([nr, nc]);
  }
  return n;
}
function findAllWords(board, dict) {
  const g = board.length, total = g * g;
  const found = new Set();
  const flat = board.flat().map(c => c.toLowerCase());
  function dfs(pos, word, vis) {
    const nw = word + flat[pos];
    if (nw.length > total || !dict.hasPrefix(nw)) return;
    if (nw.length >= 3 && dict.isWord(nw)) found.add(nw);
    const r = Math.floor(pos / g), c = pos % g;
    for (const [nr, nc] of getNeighbors4(r, c, g)) {
      const np = nr * g + nc;
      if (!vis.has(np)) { vis.add(np); dfs(np, nw, vis); vis.delete(np); }
    }
  }
  for (let pos = 0; pos < total; pos++) { const v = new Set([pos]); dfs(pos, '', v); }
  return found;
}

// ─── Scoring ──────────────────────────────────────────────────────────────────
function getBaseScore(len) { if (len < 3) return 0; if (len <= 4) return 1; if (len === 5) return 2; if (len === 6) return 3; if (len === 7) return 5; return 11; }
function getLengthBonus(len) { return len >= 8 ? 1 : 0; }
function getScore(len) { return getBaseScore(len) + getLengthBonus(len); }
function scoreRound(roundWords) {
  const allWords = new Map();
  for (const [pid, words] of roundWords) for (const e of words) { if (!e.valid) continue; if (!allWords.has(e.word)) allWords.set(e.word, []); allWords.get(e.word).push(pid); }
  const commonItems = [], commonScores = {};
  for (const [word, finders] of allWords) {
    if (finders.length < 2) continue;
    const sc = getBaseScore(word.length) + getLengthBonus(word.length);
    commonItems.push({ word, score: sc, playerIds: finders });
    for (const pid of finders) commonScores[pid] = (commonScores[pid] || 0) + sc;
  }
  const uniqueItems = [], uniqueScores = {};
  for (const [word, finders] of allWords) {
    if (finders.length !== 1) continue;
    const pid = finders[0], base = getBaseScore(word.length), lb = getLengthBonus(word.length), total = base + lb + UNIQUE_BONUS;
    uniqueItems.push({ playerId: pid, word, baseScore: base, lengthBonus: lb, uniqueBonus: UNIQUE_BONUS, totalScore: total });
    uniqueScores[pid] = (uniqueScores[pid] || 0) + total;
  }
  for (const [, words] of roundWords) for (const e of words) {
    if (!e.valid) { e.finalScore = 0; e.reason = 'invalid'; continue; }
    const finders = allWords.get(e.word) || [];
    if (finders.length > 1) { e.finalScore = getBaseScore(e.word.length) + getLengthBonus(e.word.length); e.reason = 'common'; }
    else { e.finalScore = getBaseScore(e.word.length) + getLengthBonus(e.word.length) + UNIQUE_BONUS; e.reason = 'unique'; }
  }
  const playerRoundScores = {};
  for (const [pid] of roundWords) playerRoundScores[pid] = (commonScores[pid] || 0) + (uniqueScores[pid] || 0);
  return { commonItems, uniqueItems, playerRoundScores };
}

// ─── Comms ────────────────────────────────────────────────────────────────────
function sendToRtcPlayer(playerId, payload) {
  if (playerId === myPlayerId) { handleSelfMessage(payload); return; }
  for (const [, peer] of rtcPeers) {
    if (peer.playerId !== playerId || !peer.conn || !peer.conn.open) continue;
    peer.conn.send(payload);
  }
}
function broadcastToRtcPlayers(payload) {
  handleSelfMessage(payload);
  for (const [, peer] of rtcPeers) { if (!peer.playerId || !peer.conn || !peer.conn.open) continue; peer.conn.send(payload); }
}
function handleSelfMessage(msg) {
  switch (msg.type) {
    case 'state': myState = msg.data; renderGameScreens(); break;
    case 'players': if (myState) { myState.players = msg.players; renderMiniScoreboard(); } break;
    case 'word-counts': if (myState) { myState.playerWordCounts = msg.counts; renderMiniScoreboard(); } break;
    case 'timer': updateTimer(msg.remaining); break;
    case 'word-result': handleWordResult(msg); break;
  }
}
function getPlayerList() {
  return [...gameState.players.values()].map(p => ({ id: p.id, name: p.name, avatar: p.avatar, totalScore: p.totalScore, connected: p.connected, roundWins: p.roundWins || 0, stats: null }));
}
function getPlayerState(playerId) {
  const myWords = gameState.roundWords.get(playerId) || [];
  const playerWordCounts = {};
  for (const [pid, words] of gameState.roundWords) playerWordCounts[pid] = words.filter(w => w.valid).length;
  return { phase: gameState.phase, board: gameState.board, round: gameState.round, maxRounds: gameState.maxRounds, myWords, players: getPlayerList().sort((a, b) => b.totalScore - a.totalScore), timerEnd: gameState.timerEnd, hostPlayerId: gameState.hostPlayerId, playerWordCounts, scoringPhases: gameState.scoringPhases || null, lastRoundWinnerId: gameState.lastRoundWinnerId || null, gridSize: gameState.gridSize || DEFAULT_GRID_SIZE, roundDuration: gameState.roundDuration || DEFAULT_ROUND_DURATION };
}
function broadcastHostState() { myState = getPlayerState(myPlayerId); renderGameScreens(); }
function broadcastPlayerList() { broadcastToRtcPlayers({ type: 'players', players: getPlayerList() }); }
function broadcastAllPlayers() {
  for (const [pid] of gameState.players) {
    if (pid === myPlayerId) continue;
    sendToRtcPlayer(pid, { type: 'state', data: getPlayerState(pid) });
  }
  myState = getPlayerState(myPlayerId);
  renderGameScreens();
}
function broadcastTimer(remaining) {
  updateTimer(remaining);
  for (const [, peer] of rtcPeers) { if (!peer.playerId || !peer.conn || !peer.conn.open) continue; peer.conn.send({ type: 'timer', remaining }); }
}
function broadcastWordCounts() {
  if (gameState.phase !== 'playing') return;
  const counts = {};
  for (const [pid, words] of gameState.roundWords) counts[pid] = words.filter(w => w.valid).length;
  if (myState) myState.playerWordCounts = counts;
  broadcastToRtcPlayers({ type: 'word-counts', counts });
  renderMiniScoreboard();
}

// ─── Game Flow ────────────────────────────────────────────────────────────────
function startRound() {
  gameState.round++;
  const gs = gameState.gridSize || 4;
  const MIN_LONG = gs === 4 ? 8 : gs === 5 ? 15 : gs === 6 ? 25 : 40;
  const MAX_ATTEMPTS = 30;
  let board, allWords;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    board = generateBoard(gs); allWords = findAllWords(board, dictionary);
    if ([...allWords].filter(w => w.length >= 5).length >= MIN_LONG) break;
  }
  if (!allWords) allWords = findAllWords(board, dictionary);
  gameState.board = board; gameState.validWordsOnBoard = allWords;
  gameState.phase = 'playing'; gameState.roundWords = new Map();
  gameState.timerEnd = Date.now() + (gameState.roundDuration || DEFAULT_ROUND_DURATION) * 1000;
  gameState.scoringPhases = null; gameState.lastRoundWinnerId = null;
  scoringAnimationActive = false;
  for (const [id] of gameState.players) gameState.roundWords.set(id, []);
  selectedPath = [];
  broadcastAllPlayers();
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((gameState.timerEnd - Date.now()) / 1000));
    broadcastTimer(remaining);
    if (remaining <= 0) { clearInterval(timerInterval); endRound(); }
  }, 1000);
}
function endRound() {
  gameState.phase = gameState.round >= gameState.maxRounds ? 'gameOver' : 'roundEnd';
  const scored = scoreRound(gameState.roundWords);
  for (const [pid] of gameState.roundWords) {
    const rs = scored.playerRoundScores[pid] || 0;
    const p = gameState.players.get(pid);
    if (p) { p.roundScores.push(rs); p.totalScore += rs; }
  }
  let best = 0, winnerId = null;
  for (const [pid] of gameState.roundWords) { const rs = scored.playerRoundScores[pid] || 0; if (rs > best) { best = rs; winnerId = pid; } }
  if (winnerId) { const w = gameState.players.get(winnerId); if (w) w.roundWins++; }
  gameState.scoringPhases = [
    { phase: 'common', items: scored.commonItems },
    { phase: 'unique', items: scored.uniqueItems },
  ];
  gameState.lastRoundWinnerId = winnerId;
  broadcastAllPlayers();
}
function handleWordSubmission(playerId, word) {
  if (word.length < 3) { sendToRtcPlayer(playerId, { type: 'word-result', word, valid: false, reason: 'too short', score: 0 }); return; }
  const pw = gameState.roundWords.get(playerId) || [];
  if (pw.some(w => w.word === word)) { sendToRtcPlayer(playerId, { type: 'word-result', word, valid: false, reason: 'already submitted', score: 0 }); return; }
  const inDict = dictionary && dictionary.isWord(word), onBoard = inDict && gameState.validWordsOnBoard.has(word), valid = inDict && onBoard;
  const score = valid ? getScore(word.length) : 0;
  const entry = { word, valid, score, reason: !inDict ? 'not a word' : !onBoard ? 'not on board' : 'ok' };
  pw.push(entry); gameState.roundWords.set(playerId, pw);
  sendToRtcPlayer(playerId, { type: 'word-result', word, valid, score, reason: entry.reason });
  broadcastHostState();
  broadcastWordCounts();
}
function handlePathSubmission(playerId, pathIndices) {
  if (!gameState.board) return;
  const g = gameState.board.length, total = g * g;
  const seen = new Set(); let word = '';
  for (let i = 0; i < pathIndices.length; i++) {
    const idx = pathIndices[i];
    if (typeof idx !== 'number' || idx < 0 || idx >= total || seen.has(idx)) return;
    if (i > 0) { const p = pathIndices[i - 1]; if (Math.abs(Math.floor(p / g) - Math.floor(idx / g)) > 1 || Math.abs((p % g) - (idx % g)) > 1) return; }
    seen.add(idx); word += gameState.board[Math.floor(idx / g)][idx % g];
  }
  handleWordSubmission(playerId, word.toLowerCase());
}
function handlePlayerAction(playerId, action) {
  if (!playerId || !action || typeof action !== 'object') return;
  switch (action.type) {
    case 'start-game':
      if (playerId !== gameState.hostPlayerId || !gameState.players.size) return;
      if (gameState.phase !== 'lobby' && gameState.phase !== 'gameOver') return;
      resetGame(); startRound(); return;
    case 'next-round':
      if (playerId !== gameState.hostPlayerId || gameState.phase !== 'roundEnd') return;
      startRound(); return;
    case 'restart':
      if (playerId !== gameState.hostPlayerId) return;
      resetGame(); gameState.phase = 'lobby'; broadcastAllPlayers(); return;
    case 'set-config':
      if (playerId !== gameState.hostPlayerId || gameState.phase !== 'lobby') return;
      { const gs = parseInt(action.gridSize); if (gs >= 4 && gs <= 7) gameState.gridSize = gs; }
      { const mr = parseInt(action.maxRounds); if (mr >= 1 && mr <= 20) gameState.maxRounds = mr; }
      { const rd = parseInt(action.roundDuration); if (rd >= 30 && rd <= 300) gameState.roundDuration = rd; }
      broadcastAllPlayers(); return;
    case 'submit-word':
      if (gameState.phase !== 'playing') return;
      handleWordSubmission(playerId, sanitize(action.word || '').toLowerCase().trim()); return;
    case 'submit-path':
      if (gameState.phase !== 'playing' || !Array.isArray(action.path)) return;
      handlePathSubmission(playerId, action.path); return;
  }
}

// ─── Trystero Host ───────────────────────────────────────────────────────────
function buildPlayerUrl(roomCode) {
  const url = new URL('player.html', location.href);
  url.search = '?room=' + encodeURIComponent(roomCode);
  return url.toString();
}
function showQrCode(url) {
  const img = document.getElementById('combined-qr-img');
  if (!img || typeof qrcode === 'undefined') return;
  try {
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    img.src = qr.createDataURL(4, 4);
  } catch (e) { console.warn('QR generation failed:', e); }
}
function initPeerHost() {
  hostPeer = new TrysteroHostPeer('nksimmons-lexitrack');
  hostPeer.on('open', (id) => {
    const playerUrl = buildPlayerUrl(id);
    showQrCode(playerUrl);
    const urlEl = document.getElementById('combined-join-url');
    if (urlEl) urlEl.textContent = playerUrl;
  });
  hostPeer.on('connection', (conn) => {
    const connId = Math.random().toString(36).slice(2, 8).toUpperCase();
    rtcPeers.set(connId, { conn, playerId: null });
    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.type === 'player-join') {
        const name = sanitize(msg.name || 'Player').substring(0, 20);
        const avatar = sanitizeAvatar(msg.avatar || {});
        const dId = sanitize(msg.deviceId || '').substring(0, 64);
        const existing = [...gameState.players.values()].find(p => p.deviceId && dId && p.deviceId === dId);
        let pid;
        if (existing) {
          pid = existing.id; existing.connected = true;
          rtcPeers.get(connId).playerId = pid;
          conn.send({ type: 'reconnected', playerId: pid, data: getPlayerState(pid) });
        } else {
          pid = String(nextPlayerId++);
          gameState.players.set(pid, { id: pid, name, avatar, deviceId: dId, totalScore: 0, roundScores: [], roundWins: 0, connected: true });
          rtcPeers.get(connId).playerId = pid;
          conn.send({ type: 'joined', playerId: pid, data: getPlayerState(pid), profile: null });
        }
        broadcastHostState(); broadcastPlayerList(); broadcastAllPlayers();
        return;
      }
      if (msg.type === 'reconnect') {
        const dId = sanitize(msg.deviceId || '').substring(0, 64);
        const existing = [...gameState.players.values()].find(p => p.deviceId === dId);
        if (existing) {
          existing.connected = true; rtcPeers.get(connId).playerId = existing.id;
          conn.send({ type: 'reconnected', playerId: existing.id, data: getPlayerState(existing.id) });
          broadcastHostState(); broadcastPlayerList();
        } else { conn.send({ type: 'unknown-device' }); }
        return;
      }
      const actionTypes = ['submit-word', 'submit-path', 'start-game', 'next-round', 'restart'];
      if (actionTypes.includes(msg.type)) {
        const peer = rtcPeers.get(connId);
        handlePlayerAction(peer && peer.playerId, msg); return;
      }
    });
    conn.on('close', () => {
      const peer = rtcPeers.get(connId);
      if (peer && peer.playerId && gameState.players.has(peer.playerId)) {
        gameState.players.get(peer.playerId).connected = false;
        broadcastHostState(); broadcastPlayerList();
      }
      rtcPeers.delete(connId);
    });
  });
  hostPeer.on('error', err => console.error('[PeerJS]', err));
}

// ─── Avatar Builder ───────────────────────────────────────────────────────────
function initAvatarBuilder() {
  drawCanvas = document.getElementById('draw-canvas');
  if (!drawCanvas) return;
  drawCtx = drawCanvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = drawCanvas.getBoundingClientRect();
  drawCanvas.width = rect.width * dpr; drawCanvas.height = rect.height * dpr;
  drawCtx.scale(dpr, dpr);

  const colorsEl = document.getElementById('draw-colors');
  if (colorsEl) {
    colorsEl.innerHTML = DRAW_COLORS.map(c => `<div class="draw-color ${c === drawColor ? 'selected' : ''}" data-color="${c}" style="background:${c}"></div>`).join('');
    colorsEl.addEventListener('click', e => {
      const el = e.target.closest('.draw-color'); if (!el) return;
      colorsEl.querySelectorAll('.draw-color').forEach(d => d.classList.remove('selected'));
      el.classList.add('selected'); drawColor = el.dataset.color;
    });
  }

  const cc = document.getElementById('color-options');
  if (cc) {
    cc.innerHTML = BG_COLORS.map(c => `<div class="color-option ${c === avatarChoice.bgColor ? 'selected' : ''}" data-color="${c}" style="background:${c}"></div>`).join('');
    cc.addEventListener('click', e => {
      const opt = e.target.closest('.color-option'); if (!opt) return;
      cc.querySelectorAll('.color-option').forEach(d => d.classList.remove('selected'));
      opt.classList.add('selected'); avatarChoice.bgColor = opt.dataset.color; updateAvatarPreview();
    });
  }

  function getPos(e) {
    const r = drawCanvas.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    return { x: (src.clientX - r.left), y: (src.clientY - r.top) };
  }
  drawCanvas.addEventListener('pointerdown', e => {
    isDrawing = true; const p = getPos(e);
    currentStroke = { color: drawColor, width: 4, points: [p] };
    drawCanvas.setPointerCapture(e.pointerId);
  });
  drawCanvas.addEventListener('pointermove', e => {
    if (!isDrawing || !currentStroke) return;
    currentStroke.points.push(getPos(e)); redrawCanvas();
  });
  drawCanvas.addEventListener('pointerup', () => {
    if (currentStroke) { drawStrokes.push(currentStroke); currentStroke = null; }
    isDrawing = false; updateAvatarPreview();
  });
  document.getElementById('btn-undo') && document.getElementById('btn-undo').addEventListener('click', () => { drawStrokes.pop(); redrawCanvas(); updateAvatarPreview(); });
  document.getElementById('btn-clear') && document.getElementById('btn-clear').addEventListener('click', () => { drawStrokes = []; redrawCanvas(); updateAvatarPreview(); });
}
function redrawCanvas() {
  if (!drawCtx) return;
  const r = drawCanvas.getBoundingClientRect();
  drawCtx.clearRect(0, 0, r.width, r.height);
  const strokes = currentStroke ? [...drawStrokes, currentStroke] : drawStrokes;
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    drawCtx.strokeStyle = stroke.color; drawCtx.lineWidth = stroke.width; drawCtx.lineCap = 'round'; drawCtx.lineJoin = 'round';
    drawCtx.beginPath();
    if (stroke.points.length === 1) {
      drawCtx.arc(stroke.points[0].x, stroke.points[0].y, stroke.width / 2, 0, Math.PI * 2);
      drawCtx.fillStyle = stroke.color; drawCtx.fill();
    } else {
      drawCtx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) drawCtx.lineTo(stroke.points[i].x, stroke.points[i].y);
      drawCtx.stroke();
    }
  }
}
function getDrawingDataUrl() {
  const ec = document.createElement('canvas'); ec.width = 60; ec.height = 60;
  const ectx = ec.getContext('2d');
  ectx.fillStyle = avatarChoice.bgColor || BG_COLORS[0]; ectx.fillRect(0, 0, 60, 60);
  if (drawCanvas) ectx.drawImage(drawCanvas, 0, 0, drawCanvas.width, drawCanvas.height, 0, 0, 60, 60);
  return ec.toDataURL('image/png');
}
function updateAvatarPreview() {
  const p = document.getElementById('avatar-preview'); if (!p) return;
  p.style.background = avatarChoice.bgColor;
  if (drawStrokes.length > 0) {
    const d = getDrawingDataUrl(); avatarChoice.drawing = d;
    p.style.backgroundImage = 'url(' + d + ')'; p.style.backgroundSize = 'cover';
  } else { avatarChoice.drawing = null; p.style.backgroundImage = ''; }
}

// ─── Render ───────────────────────────────────────────────────────────────────
function renderAvatarContent(avatar, roundWins) {
  const crown = roundWins > 0 ? '<span class="avatar-crown">\u{1F451}</span>' : '';
  if (avatar && avatar.drawing) return crown + '<img src="' + avatar.drawing + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%">';
  return crown + '\u{1F3B2}';
}
function renderGameScreens() {
  if (!myState) return;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = document.getElementById('screen-' + myState.phase);
  if (screen) screen.classList.add('active');
  switch (myState.phase) {
    case 'lobby': renderLobby(); break;
    case 'playing': renderPlaying(); break;
    case 'roundEnd':
      if (!scoringAnimationActive && scoringAnimationDoneForRound !== myState.round) renderRoundEnd();
      break;
    case 'gameOver': renderGameOver(); break;
  }
}
function renderLobby() {
  renderLobbyPlayers();
  updateHostControls();
  // Sync selects to current gameState settings (in case another player changed them, or on first render)
  if (myState) {
    const gs = document.getElementById('cfg-grid-size');
    const mr = document.getElementById('cfg-rounds');
    const rd = document.getElementById('cfg-duration');
    if (gs) gs.value = myState.gridSize || DEFAULT_GRID_SIZE;
    if (mr) mr.value = myState.maxRounds || DEFAULT_MAX_ROUNDS;
    if (rd) rd.value = myState.roundDuration || DEFAULT_ROUND_DURATION;
  }
}
function renderLobbyPlayers() {
  const c = document.getElementById('lobby-player-list'); if (!c || !myState || !myState.players) return;
  c.innerHTML = '<div class="scoreboard">' + myState.players.map(p =>
    '<div class="player-card" ' + (p.id === myPlayerId ? 'style="border:2px solid var(--accent)"' : '') + '>' +
    '<div class="avatar" style="background:' + (p.avatar && p.avatar.bgColor ? p.avatar.bgColor : '#4a3a6e') + '">' + renderAvatarContent(p.avatar, p.roundWins) + '</div>' +
    '<div class="player-name">' + esc(p.name) + '</div></div>'
  ).join('') + '</div>';
}
function renderMiniScoreboard() {
  const c = document.getElementById('mini-scoreboard'); if (!c || !myState || !myState.players) return;
  const counts = myState.playerWordCounts || {};
  c.innerHTML = myState.players.map(p =>
    '<div class="mini-player ' + (p.id === myPlayerId ? 'me' : '') + '">' +
    '<div class="avatar" style="background:' + (p.avatar && p.avatar.bgColor ? p.avatar.bgColor : '#4a3a6e') + ';width:32px;height:32px;font-size:0.85rem;margin:0">' + renderAvatarContent(p.avatar, p.roundWins) + '</div>' +
    '<div class="mini-name">' + esc(p.name) + '</div>' +
    '<div class="mini-words">' + (counts[p.id] || 0) + '</div></div>'
  ).join('');
}
function renderPlaying() {
  const rn = document.getElementById('round-num'); if (rn) rn.textContent = myState.round;
  const mr = document.getElementById('max-rounds'); if (mr) mr.textContent = myState.maxRounds;
  const me = myState.players && myState.players.find(p => p.id === myPlayerId);
  const ts = document.getElementById('my-total-score'); if (ts) ts.textContent = me ? me.totalScore : 0;
  const validCount = (myState.myWords || []).filter(w => w.valid).length;
  const ce = document.getElementById('my-word-count'); if (ce) ce.textContent = validCount;
  renderMiniScoreboard();
  renderBoard();
  renderMyWords();
}
function renderBoard() {
  const c = document.getElementById('board'); if (!myState || !myState.board || !c) return;
  const g = myState.board.length;
  c.style.gridTemplateColumns = `repeat(${g}, 1fr)`;
  c.innerHTML = myState.board.flat().map((letter, idx) => '<div class="tile' + (g >= 6 ? ' small' : '') + '" data-idx="' + idx + '">' + letter + '</div>').join('');
  updateBoardSelection();
  attachBoardEvents();
}
function getNeighborsFlat(idx) {
  const g = (myState && myState.board) ? myState.board.length : 4;
  const r = Math.floor(idx / g), col = idx % g, n = [];
  for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
    if (dr === 0 && dc === 0) continue;
    const nr = r + dr, nc = col + dc;
    if (nr >= 0 && nr < g && nc >= 0 && nc < g) n.push(nr * g + nc);
  }
  return n;
}
function isAdjacentFlat(i1, i2) {
  const g = (myState && myState.board) ? myState.board.length : 4;
  return Math.abs(Math.floor(i1 / g) - Math.floor(i2 / g)) <= 1 && Math.abs((i1 % g) - (i2 % g)) <= 1;
}
function updateBoardSelection() {
  const tiles = document.querySelectorAll('#board .tile');
  tiles.forEach(t => t.classList.remove('selected', 'adjacent'));
  for (const idx of selectedPath) { if (tiles[idx]) tiles[idx].classList.add('selected'); }
  if (selectedPath.length > 0) {
    for (const n of getNeighborsFlat(selectedPath[selectedPath.length - 1])) { if (!selectedPath.includes(n) && tiles[n]) tiles[n].classList.add('adjacent'); }
  }
  const el = document.getElementById('current-word');
  if (el) {
    if (!selectedPath.length || !myState || !myState.board) { el.innerHTML = '&nbsp;'; }
    else { el.textContent = selectedPath.map(idx => myState.board[Math.floor(idx / 4)][idx % 4]).join(''); }
  }
}
function renderMyWords() {
  const c = document.getElementById('my-words'); if (!c || !myState) return;
  c.innerHTML = '<ul class="word-list">' + (myState.myWords || []).map(w =>
    '<li class="word-tag ' + (w.valid ? 'valid' : 'invalid') + '">' + esc(w.word) + (w.valid ? '<span class="score">+' + w.score + '</span>' : '') + '</li>'
  ).join('') + '</ul>';
}
// ─── Round End (animated scoring) ────────────────────────────────────────────
let scoringAnimationActive = false;
let scoringAnimationDoneForRound = -1;

function getRoundScoreFromPhases(playerId, phases) {
  let total = 0;
  if (!phases) return 0;
  for (const ph of phases) {
    if (ph.phase === 'common') {
      for (const item of ph.items) { if (item.playerIds && item.playerIds.includes(playerId)) total += item.score; }
    } else if (ph.phase === 'unique') {
      for (const item of ph.items) { if (item.playerId === playerId) total += item.totalScore; }
    }
  }
  return total;
}

function renderRoundEnd() {
  const ren = document.getElementById('round-end-num'); if (ren) ren.textContent = myState.round;
  updateHostControls();
  const wordsCard = document.getElementById('round-end-words');
  const scoresCard = document.getElementById('round-end-scores');

  function showStatic() {
    if (scoresCard) scoresCard.style.display = '';
    if (wordsCard) {
      const words = myState.myWords || [];
      wordsCard.innerHTML = '<h2 style="margin-bottom:0.5rem">Your Words</h2><ul class="word-list">' + words.map(w => {
        let cls = 'invalid';
        if (w.reason === 'unique') cls = 'valid'; else if (w.reason === 'common') cls = 'common';
        return '<li class="word-tag ' + cls + '">' + esc(w.word) + (w.finalScore ? '<span class="score">+' + w.finalScore + '</span>' : '') + '</li>';
      }).join('') + '</ul>';
    }
    const standings = document.getElementById('player-standings');
    if (standings) renderStandings(standings);
  }

  if (!myState.scoringPhases) { showStatic(); return; }

  if (scoresCard) scoresCard.style.display = 'none';
  if (wordsCard) {
    wordsCard.innerHTML = `
      <div id="scoring-players" class="scoring-players"></div>
      <div id="scoring-phase-label" class="scoring-phase-label"></div>
      <div id="scoring-words" class="scoring-words"></div>
    `;
    const playersEl = document.getElementById('scoring-players');
    if (playersEl && myState.players) {
      playersEl.innerHTML = myState.players.map(p => {
        const preScore = p.totalScore - getRoundScoreFromPhases(p.id, myState.scoringPhases);
        return `<div class="scoring-player-card" id="scoring-player-${p.id}">
          <div class="avatar" style="background:${p.avatar ? p.avatar.bgColor || '#4a3a6e' : '#4a3a6e'}">${renderAvatarContent(p.avatar, p.roundWins)}</div>
          <div class="player-name">${esc(p.name)}</div>
          <div class="scoring-player-score" id="score-display-${p.id}">${preScore}</div>
          <div class="score-float-container" id="float-${p.id}"></div>
        </div>`;
      }).join('');
    }
  }

  scoringAnimationActive = true;
  animateScoring(myState.scoringPhases, () => {
    scoringAnimationActive = false;
    scoringAnimationDoneForRound = myState.round;
    if (myState.players) {
      myState.players.forEach(p => {
        const el = document.getElementById(`score-display-${p.id}`);
        if (el) el.textContent = p.totalScore;
      });
    }
    showStatic();
  });
}

function animateScoring(phases, onComplete) {
  const commonPhase = phases.find(p => p.phase === 'common');
  const uniquePhase = phases.find(p => p.phase === 'unique');

  const runningScores = {};
  if (myState.players) {
    myState.players.forEach(p => { runningScores[p.id] = p.totalScore - getRoundScoreFromPhases(p.id, phases); });
  }

  const phaseLabel = document.getElementById('scoring-phase-label');
  const wordsEl = document.getElementById('scoring-words');
  if (!phaseLabel || !wordsEl) { onComplete(); return; }

  phaseLabel.textContent = '🤝 Common Words';
  phaseLabel.className = 'scoring-phase-label fade-in';
  wordsEl.innerHTML = '';

  let delay = 600;

  if (commonPhase && commonPhase.items.length > 0) {
    commonPhase.items.forEach((item, i) => {
      setTimeout(() => {
        const tag = document.createElement('span');
        tag.className = 'word-tag common pop-in';
        tag.innerHTML = `${esc(item.word.toUpperCase())} <span class="score">+${item.score}</span>`;
        wordsEl.appendChild(tag);
        item.playerIds.forEach(pid => {
          runningScores[pid] = (runningScores[pid] || 0) + item.score;
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

  setTimeout(() => {
    phaseLabel.textContent = `⭐ Unique Words (+${UNIQUE_BONUS} bonus each)`;
    phaseLabel.className = 'scoring-phase-label fade-in';
    wordsEl.innerHTML = '';

    if (uniquePhase && uniquePhase.items.length > 0) {
      uniquePhase.items.forEach((item, i) => {
        setTimeout(() => {
          const tag = document.createElement('span');
          tag.className = 'word-tag valid pop-in';
          const bonusText = item.lengthBonus > 0 ? ` (${item.baseScore}+${item.lengthBonus}+${item.uniqueBonus})` : '';
          tag.innerHTML = `${esc(item.word.toUpperCase())} <span class="score">+${item.totalScore}${bonusText}</span>`;
          wordsEl.appendChild(tag);
          runningScores[item.playerId] = (runningScores[item.playerId] || 0) + item.totalScore;
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
  if (scoreEl) setTimeout(() => { scoreEl.textContent = newTotal; }, 400);
}
function renderGameOver() {
  const fl = document.getElementById('final-player-list');
  if (fl) renderStandings(fl);
  updateHostControls();
}
function renderStandings(container) {
  if (!container || !myState || !myState.players) return;
  const sorted = [...myState.players].sort((a, b) => b.totalScore - a.totalScore);
  container.innerHTML = sorted.map((p, i) =>
    '<div class="player-card" style="display:flex;align-items:center;gap:1rem;padding:0.75rem;width:100%;text-align:left;' + (p.id === myPlayerId ? 'border:2px solid var(--accent)' : '') + '">' +
    '<span style="font-size:1.2rem;font-weight:900;color:var(--text-dim);width:30px">' + (i + 1) + '</span>' +
    '<div class="avatar" style="background:' + (p.avatar && p.avatar.bgColor ? p.avatar.bgColor : '#4a3a6e') + ';width:40px;height:40px;font-size:1.2rem;margin:0">' + renderAvatarContent(p.avatar, p.roundWins) + '</div>' +
    '<span class="player-name" style="flex:1">' + esc(p.name) + '</span>' +
    '<span class="player-score" style="font-size:1.3rem">' + p.totalScore + '</span></div>'
  ).join('');
}

// ─── Board Events ─────────────────────────────────────────────────────────────
function attachBoardEvents() {
  const board = document.getElementById('board');
  if (!board) return;
  const tiles = board.querySelectorAll('.tile');
  let tileCenters = [];
  function cacheTileCenters() {
    tileCenters = Array.from(tiles).map((t, i) => {
      const r = t.getBoundingClientRect();
      return { idx: i, cx: r.left + r.width / 2, cy: r.top + r.height / 2, halfSize: Math.max(r.width, r.height) / 2 };
    });
  }
  function getNearestTile(x, y) {
    let best = null, bestDist = Infinity;
    const maxRadius = tileCenters[0] ? tileCenters[0].halfSize * 0.95 : 50;
    for (const t of tileCenters) { const dx = x - t.cx, dy = y - t.cy, dist = Math.sqrt(dx * dx + dy * dy); if (dist < maxRadius && dist < bestDist) { best = t.idx; bestDist = dist; } }
    return best;
  }
  board.addEventListener('pointerdown', e => {
    const tile = e.target.closest('.tile'); if (!tile) return;
    e.preventDefault(); isDragging = true; selectedPath = []; cacheTileCenters();
    selectedPath.push(parseInt(tile.dataset.idx, 10)); updateBoardSelection();
    board.setPointerCapture(e.pointerId);
  });
  board.addEventListener('pointermove', e => {
    if (!isDragging) return; e.preventDefault();
    const idx = getNearestTile(e.clientX, e.clientY); if (idx === null) return;
    if (selectedPath.includes(idx)) {
      if (selectedPath.length >= 2 && selectedPath[selectedPath.length - 2] === idx) { selectedPath.pop(); updateBoardSelection(); }
      return;
    }
    if (isAdjacentFlat(selectedPath[selectedPath.length - 1], idx)) { selectedPath.push(idx); updateBoardSelection(); }
  });
  board.addEventListener('pointerup', () => {
    if (isDragging && selectedPath.length >= 3) submitPath(); else clearSelection();
    isDragging = false;
  });
}
function submitPath() {
  if (selectedPath.length < 3) { toast('Too short! (3+ letters)', 'error'); return; }
  handlePathSubmission(myPlayerId, selectedPath);
  selectedPath = []; updateBoardSelection();
}
function clearSelection() { selectedPath = []; updateBoardSelection(); }

// ─── Host Controls ────────────────────────────────────────────────────────────
function isHostPlayer() { return myState && myState.hostPlayerId === myPlayerId; }
function updateHostControls() {
  const isHP = isHostPlayer();
  const startBtn = document.getElementById('btn-start-game');
  const lobbyWait = document.getElementById('lobby-waiting-msg');
  const configPanel = document.getElementById('game-config');
  if (startBtn) startBtn.style.display = isHP ? '' : 'none';
  if (lobbyWait) lobbyWait.style.display = isHP ? 'none' : '';
  if (configPanel) configPanel.style.display = isHP ? '' : 'none';
  const roundControls = document.getElementById('roundend-host-controls');
  const roundWait = document.getElementById('roundend-waiting-msg');
  if (roundControls) roundControls.style.display = isHP ? '' : 'none';
  if (roundWait) roundWait.style.display = isHP ? 'none' : '';
  const goControls = document.getElementById('gameover-host-controls');
  const goWait = document.getElementById('gameover-waiting-msg');
  if (goControls) goControls.style.display = isHP ? '' : 'none';
  if (goWait) goWait.style.display = isHP ? 'none' : '';
}

// ─── Word Result / Timer / Toast / Audio ─────────────────────────────────────
function handleWordResult(msg) {
  if (msg.valid) { toast(msg.word.toUpperCase() + ' +' + msg.score, 'success'); playFeedback('success'); }
  else if (msg.reason === 'already submitted') { toast(msg.word.toUpperCase() + ' \u2014 already found', 'error'); playFeedback('duplicate'); }
  else { toast(msg.word.toUpperCase() + ' \u2014 ' + msg.reason, 'error'); playFeedback('error'); }
}
function updateTimer(remaining) {
  const el = document.getElementById('timer'); if (!el) return;
  el.textContent = remaining; el.className = 'timer';
  if (remaining <= 10) el.classList.add('danger'); else if (remaining <= 30) el.classList.add('warning');
}
function toast(text, type) {
  if (type === undefined) type = 'success';
  const c = document.getElementById('toasts'); if (!c) return;
  const el = document.createElement('div'); el.className = 'toast ' + type; el.textContent = text;
  c.appendChild(el); setTimeout(() => el.remove(), 2500);
}
function playFeedback(type) {
  if (navigator.vibrate) { if (type === 'success') navigator.vibrate([60, 40, 80]); else if (type === 'duplicate') navigator.vibrate(50); else navigator.vibrate(200); }
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator(), gain = audioCtx.createGain();
    osc.connect(gain); gain.connect(audioCtx.destination); gain.gain.value = 0.15;
    if (type === 'success') {
      osc.type = 'sine'; osc.frequency.setValueAtTime(523, audioCtx.currentTime); osc.frequency.setValueAtTime(659, audioCtx.currentTime + 0.08); osc.frequency.setValueAtTime(784, audioCtx.currentTime + 0.16);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.3); osc.start(audioCtx.currentTime); osc.stop(audioCtx.currentTime + 0.3);
    } else {
      osc.type = 'square'; osc.frequency.setValueAtTime(200, audioCtx.currentTime); osc.frequency.setValueAtTime(150, audioCtx.currentTime + 0.1);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.2); osc.start(audioCtx.currentTime); osc.stop(audioCtx.currentTime + 0.2);
    }
  } catch (e) { /* audio optional */ }
}

// ─── Events ───────────────────────────────────────────────────────────────────
(function wireEvents() {
  const joinBtn = document.getElementById('btn-join');
  if (joinBtn) joinBtn.addEventListener('click', () => {
    const name = document.getElementById('player-name').value.trim();
    if (!name) { document.getElementById('player-name').focus(); return; }
    saveProfile(name, avatarChoice);
    myPlayerId = String(nextPlayerId++);
    gameState.players.set(myPlayerId, { id: myPlayerId, name, avatar: sanitizeAvatar(avatarChoice), deviceId, totalScore: 0, roundScores: [], roundWins: 0, connected: true });
    gameState.hostPlayerId = myPlayerId;
    myState = getPlayerState(myPlayerId);
    initPeerHost();
    renderGameScreens();
  });
  const nameInput = document.getElementById('player-name');
  if (nameInput) nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') joinBtn && joinBtn.click(); });
  const startBtn = document.getElementById('btn-start-game');
  if (startBtn) startBtn.addEventListener('click', () => handlePlayerAction(myPlayerId, { type: 'start-game' }));
  const nextBtn = document.getElementById('btn-next-round');
  if (nextBtn) nextBtn.addEventListener('click', () => handlePlayerAction(myPlayerId, { type: 'next-round' }));
  const againBtn = document.getElementById('btn-play-again');
  if (againBtn) againBtn.addEventListener('click', () => handlePlayerAction(myPlayerId, { type: 'restart' }));
  function sendConfig() {
    const gs = document.getElementById('cfg-grid-size');
    const mr = document.getElementById('cfg-rounds');
    const rd = document.getElementById('cfg-duration');
    handlePlayerAction(myPlayerId, { type: 'set-config', gridSize: gs ? parseInt(gs.value) : 4, maxRounds: mr ? parseInt(mr.value) : 5, roundDuration: rd ? parseInt(rd.value) : 90 });
  }
  document.getElementById('cfg-grid-size')?.addEventListener('change', sendConfig);
  document.getElementById('cfg-rounds')?.addEventListener('change', sendConfig);
  document.getElementById('cfg-duration')?.addEventListener('change', sendConfig);
})();

// ─── Init ─────────────────────────────────────────────────────────────────────
(async function init() {
  const profile = loadProfile();
  const nameInput = document.getElementById('player-name');
  if (profile.name && nameInput) nameInput.value = profile.name;
  if (profile.avatar) avatarChoice = Object.assign({}, avatarChoice, profile.avatar);

  const dictPath = new URL('../csw19.txt', location.href).href;
  try {
    const res = await fetch(dictPath);
    if (!res.ok) throw new Error('Dictionary load failed (' + res.status + ')');
    dictionary = new Dictionary();
    const text = await res.text();
    for (const raw of text.split(/\r?\n/)) dictionary.insert(raw);
  } catch (e) { console.error('Failed to load dictionary:', e); }

  initAvatarBuilder();
})();
