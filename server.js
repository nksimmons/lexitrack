const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const QRCode = require('qrcode');
const { loadDictionary } = require('./dictionary');
const { generateBoard, getScore, getBaseScore, getLengthBonus, UNIQUE_BONUS, findAllWords } = require('./game');
const { scoreRound } = require('./shared/round-scoring');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const ROUND_DURATION = 90; // seconds
const MAX_ROUNDS = 5;
const PROFILES_PATH = path.join(__dirname, 'data', 'profiles.json');

// --- Experimental WebRTC Signaling (hybrid mode) ---
const rtcPeersById = new Map(); // peerId -> ws
const rtcHostByRoom = new Map(); // roomCode -> hostPeerId
const rtcRoomByHostPeerId = new Map(); // hostPeerId -> roomCode
const rtcRoomByPlayerPeerId = new Map(); // playerPeerId -> roomCode

// --- Persistent Player Profiles ---
let playerProfiles = {}; // deviceId -> { name, avatar, gamesPlayed, gamesWon, allTimeScore }

function loadProfiles() {
  try {
    if (fs.existsSync(PROFILES_PATH)) {
      playerProfiles = JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Failed to load profiles:', e.message);
    playerProfiles = {};
  }
}

function saveProfiles() {
  try {
    const dir = path.dirname(PROFILES_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(PROFILES_PATH, JSON.stringify(playerProfiles, null, 2));
  } catch (e) {
    console.error('Failed to save profiles:', e.message);
  }
}

loadProfiles();

// --- State ---
const dictionary = loadDictionary();
let gameState = createFreshState();

function createFreshState() {
  return {
    phase: 'lobby', // lobby | playing | roundEnd | gameOver
    players: new Map(), // id -> player
    board: null,
    round: 0,
    maxRounds: MAX_ROUNDS,
    timerEnd: null,
    roundWords: new Map(), // playerId -> [{word, score, valid}]
    validWordsOnBoard: new Set(), // cached valid words for active board
    hostWs: null,
    hostPlayerId: null, // first player to join controls the game
  };
}

function resetGame() {
  const players = gameState.players;
  const hostPlayerId = gameState.hostPlayerId;
  const hostWs = gameState.hostWs;
  // Keep players but reset scores
  for (const [id, p] of players) {
    p.totalScore = 0;
    p.roundScores = [];
    p.roundWins = 0;
  }
  gameState = {
    ...createFreshState(),
    players,
    hostPlayerId,
    hostWs,
  };
}

let timerInterval = null;

// --- Serve static files ---
app.use(express.static(path.join(__dirname, 'public')));

app.get('/host', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get('/player', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'player.html'));
});

app.get('/combined', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'combined.html'));
});

app.get('/qr.png', async (_req, res) => {
  const ip = getLocalIP();
  const url = `http://${ip}:${PORT}/player`;
  try {
    const buf = await QRCode.toBuffer(url, { width: 300, margin: 2, color: { dark: '#000000', light: '#ffffff' } });
    res.type('image/png').send(buf);
  } catch (e) {
    console.error('QR generation failed:', e.message);
    res.status(500).send('QR generation failed');
  }
});

app.get('/api/info', (_req, res) => {
  const ip = getLocalIP();
  res.json({
    playerUrl: `http://${ip}:${PORT}/player`,
    hostUrl: `http://${ip}:${PORT}/host`,
    combinedUrl: `http://${ip}:${PORT}/combined`,
  });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- WebSocket heartbeat ---
const PING_INTERVAL = 25000; // 25 seconds
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, PING_INTERVAL);
wss.on('close', () => clearInterval(pingInterval));

let nextPlayerId = 1;

function generatePeerId() {
  return Math.random().toString(36).slice(2, 10);
}

function normalizeRoomCode(rawCode) {
  return String(rawCode || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function generateRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return code;
}

function assignUniqueRoomCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = generateRoomCode();
    if (!rtcHostByRoom.has(code)) {
      return code;
    }
  }
  return `${Date.now().toString(36).slice(-6).toUpperCase()}`;
}

function clearRtcHostForPeer(peerId) {
  const roomCode = rtcRoomByHostPeerId.get(peerId);
  if (!roomCode) return;
  rtcRoomByHostPeerId.delete(peerId);
  rtcHostByRoom.delete(roomCode);

  for (const [playerPeerId, playerRoom] of rtcRoomByPlayerPeerId) {
    if (playerRoom !== roomCode) continue;
    rtcRoomByPlayerPeerId.delete(playerPeerId);
    const playerWs = rtcPeersById.get(playerPeerId);
    sendToWs(playerWs, { type: 'rtc-peer-left', peerId });
  }
}

function clearRtcPlayerForPeer(peerId) {
  const roomCode = rtcRoomByPlayerPeerId.get(peerId);
  if (!roomCode) return;
  rtcRoomByPlayerPeerId.delete(peerId);
  const hostPeerId = rtcHostByRoom.get(roomCode);
  const hostWs = rtcPeersById.get(hostPeerId);
  sendToWs(hostWs, { type: 'rtc-peer-left', peerId });
}

function findPlayerIdByRtcPeerId(peerId) {
  if (!peerId) return null;
  for (const [pid, player] of gameState.players) {
    if (player.rtcPeerId === peerId) {
      return pid;
    }
  }
  return null;
}

function handlePlayerAction(playerId, action) {
  if (!playerId || !action || typeof action !== 'object') return;

  switch (action.type) {
    case 'start-game': {
      if (playerId !== gameState.hostPlayerId) return;
      if (gameState.players.size === 0) return;
      if (gameState.phase !== 'lobby' && gameState.phase !== 'gameOver') return;
      resetGame();
      startRound();
      return;
    }

    case 'next-round': {
      if (playerId !== gameState.hostPlayerId) return;
      if (gameState.phase !== 'roundEnd') return;
      startRound();
      return;
    }

    case 'restart': {
      if (playerId !== gameState.hostPlayerId) return;
      resetGame();
      gameState.phase = 'lobby';
      broadcastHostState();
      broadcastAllPlayers();
      return;
    }

    case 'submit-word': {
      if (gameState.phase !== 'playing') return;
      const word = sanitize(action.word || '').toLowerCase().trim();
      handleWordSubmission(playerId, word);
      return;
    }

    case 'submit-path': {
      if (gameState.phase !== 'playing') return;
      const pathIndices = action.path;
      if (!Array.isArray(pathIndices)) return;
      handlePathSubmission(playerId, pathIndices);
      return;
    }
  }
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.rtcPeerId = generatePeerId();
  rtcPeersById.set(ws.rtcPeerId, ws);

  let playerId = null;
  let isHost = false;

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'host-join': {
        isHost = true;
        gameState.hostWs = ws;
        console.log('[host] Host joined, sending state:', gameState.phase);
        sendToWs(ws, { type: 'state', data: getHostState() });
        break;
      }

      case 'get-state': {
        if (isHost) {
          sendToWs(ws, { type: 'state', data: getHostState() });
        }
        break;
      }

      case 'rtc-host-open': {
        clearRtcPlayerForPeer(ws.rtcPeerId);
        clearRtcHostForPeer(ws.rtcPeerId);

        let roomCode = normalizeRoomCode(msg.roomCode);
        if (!roomCode) {
          roomCode = assignUniqueRoomCode();
        }

        const previousHostPeer = rtcHostByRoom.get(roomCode);
        if (previousHostPeer && previousHostPeer !== ws.rtcPeerId) {
          sendToWs(ws, { type: 'rtc-error', message: `Room ${roomCode} is already in use` });
          break;
        }

        rtcHostByRoom.set(roomCode, ws.rtcPeerId);
        rtcRoomByHostPeerId.set(ws.rtcPeerId, roomCode);
        sendToWs(ws, { type: 'rtc-host-opened', roomCode, peerId: ws.rtcPeerId });
        break;
      }

      case 'rtc-join': {
        const roomCode = normalizeRoomCode(msg.roomCode);
        if (!roomCode) {
          sendToWs(ws, { type: 'rtc-error', message: 'Missing room code' });
          break;
        }

        const hostPeerId = rtcHostByRoom.get(roomCode);
        if (!hostPeerId) {
          sendToWs(ws, { type: 'rtc-error', message: `Room ${roomCode} not found` });
          break;
        }

        clearRtcPlayerForPeer(ws.rtcPeerId);
        clearRtcHostForPeer(ws.rtcPeerId);

        rtcRoomByPlayerPeerId.set(ws.rtcPeerId, roomCode);
        sendToWs(ws, { type: 'rtc-joined', roomCode, hostPeerId, peerId: ws.rtcPeerId });

        const hostWs = rtcPeersById.get(hostPeerId);
        sendToWs(hostWs, { type: 'rtc-player-joined', roomCode, playerPeerId: ws.rtcPeerId });
        break;
      }

      case 'rtc-signal': {
        const targetPeerId = sanitize(msg.to || '').substring(0, 32);
        if (!targetPeerId) break;

        const targetWs = rtcPeersById.get(targetPeerId);
        if (!targetWs) {
          sendToWs(ws, { type: 'rtc-error', message: `Peer ${targetPeerId} is offline` });
          break;
        }

        sendToWs(targetWs, {
          type: 'rtc-signal',
          from: ws.rtcPeerId,
          signal: msg.signal || null,
        });
        break;
      }

      case 'rtc-relay-action': {
        const fromPeerId = sanitize(msg.fromPeerId || '').substring(0, 32);
        if (!fromPeerId) break;

        const hostRoom = rtcRoomByHostPeerId.get(ws.rtcPeerId);
        const playerRoom = rtcRoomByPlayerPeerId.get(fromPeerId);
        if (!hostRoom || !playerRoom || hostRoom !== playerRoom) {
          sendToWs(ws, { type: 'rtc-error', message: 'Relay rejected: peer is not in host room' });
          break;
        }

        const targetPlayerId = findPlayerIdByRtcPeerId(fromPeerId);
        if (!targetPlayerId || !gameState.players.has(targetPlayerId)) {
          sendToWs(ws, { type: 'rtc-error', message: 'Relay rejected: player not joined in game session' });
          break;
        }

        handlePlayerAction(targetPlayerId, msg.action || null);
        break;
      }

      case 'player-join': {
        const name = sanitize(msg.name || 'Player').substring(0, 20);
        const avatar = sanitizeAvatar(msg.avatar || {});
        const deviceId = sanitize(msg.deviceId || '').substring(0, 64);
        playerId = String(nextPlayerId++);
        const player = {
          id: playerId,
          name,
          avatar,
          deviceId,
          rtcPeerId: ws.rtcPeerId,
          totalScore: 0,
          roundScores: [],
          roundWins: 0,
          ws,
          connected: true,
        };
        gameState.players.set(playerId, player);

        // First player to join becomes the host player
        if (!gameState.hostPlayerId) {
          gameState.hostPlayerId = playerId;
        }

        // Update persistent profile
        if (deviceId) {
          if (!playerProfiles[deviceId]) {
            playerProfiles[deviceId] = { name, avatar, gamesPlayed: 0, gamesWon: 0, allTimeScore: 0 };
          } else {
            playerProfiles[deviceId].name = name;
            playerProfiles[deviceId].avatar = avatar;
          }
          saveProfiles();
        }

        sendToWs(ws, {
          type: 'joined',
          playerId,
          data: getPlayerState(playerId),
          profile: deviceId ? playerProfiles[deviceId] : null,
        });
        broadcastHostState();
        broadcastPlayerList();
        break;
      }

      case 'reconnect': {
        const devId = sanitize(msg.deviceId || '').substring(0, 64);
        if (!devId) {
          sendToWs(ws, { type: 'unknown-device' });
          break;
        }

        // Find existing player in this game session by deviceId
        let existingPlayer = null;
        for (const [, p] of gameState.players) {
          if (p.deviceId === devId) {
            existingPlayer = p;
            break;
          }
        }

        if (existingPlayer) {
          // Reconnect to active game
          playerId = existingPlayer.id;
          existingPlayer.ws = ws;
          existingPlayer.rtcPeerId = ws.rtcPeerId;
          existingPlayer.connected = true;
          sendToWs(ws, {
            type: 'reconnected',
            playerId,
            data: getPlayerState(playerId),
          });
          broadcastHostState();
          broadcastPlayerList();
        } else {
          // Not in active game, let client show join screen
          sendToWs(ws, { type: 'unknown-device' });
        }
        break;
      }

      case 'start-game': {
        if (isHost && playerId !== gameState.hostPlayerId) {
          // Host display socket can trigger game start directly.
          if (gameState.players.size === 0) return;
          if (gameState.phase !== 'lobby' && gameState.phase !== 'gameOver') return;
          resetGame();
          startRound();
          return;
        }
        handlePlayerAction(playerId, msg);
        break;
      }

      case 'next-round': {
        if (isHost && playerId !== gameState.hostPlayerId) {
          if (gameState.phase !== 'roundEnd') return;
          startRound();
          return;
        }
        handlePlayerAction(playerId, msg);
        break;
      }

      case 'submit-word': {
        handlePlayerAction(playerId, msg);
        break;
      }

      case 'submit-path': {
        handlePlayerAction(playerId, msg);
        break;
      }

      case 'restart': {
        if (isHost && playerId !== gameState.hostPlayerId) {
          resetGame();
          gameState.phase = 'lobby';
          broadcastHostState();
          broadcastAllPlayers();
          return;
        }
        handlePlayerAction(playerId, msg);
        break;
      }
    }
  });

  ws.on('close', () => {
    const rtcPeerId = ws.rtcPeerId;
    if (rtcPeerId) {
      clearRtcHostForPeer(rtcPeerId);
      clearRtcPlayerForPeer(rtcPeerId);
      rtcPeersById.delete(rtcPeerId);
    }

    if (isHost) {
      gameState.hostWs = null;
    }
    if (playerId && gameState.players.has(playerId)) {
      gameState.players.get(playerId).connected = false;
      gameState.players.get(playerId).ws = null;
      broadcastHostState();
      broadcastPlayerList();
    }
  });
});

// --- Game Logic ---

function startRound() {
  gameState.round++;

  // Generate a quality board (must have enough long words)
  const MIN_LONG_WORDS = 8; // at least 8 words of 5+ letters
  const MAX_ATTEMPTS = 30;
  let board, allWords;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    board = generateBoard();
    allWords = findAllWords(board, dictionary);
    const longWords = [...allWords].filter(w => w.length >= 5);
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

  // Initialize empty word lists for each player
  for (const [id] of gameState.players) {
    gameState.roundWords.set(id, []);
  }

  broadcastHostState();
  broadcastAllPlayers();

  // Timer
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const remaining = Math.max(0, Math.ceil((gameState.timerEnd - Date.now()) / 1000));
    broadcastToAll({ type: 'timer', remaining });
    if (remaining <= 0) {
      clearInterval(timerInterval);
      endRound();
    }
  }, 1000);
}

function endRound() {
  gameState.phase = gameState.round >= gameState.maxRounds ? 'gameOver' : 'roundEnd';

  const scored = scoreRound(gameState.roundWords, {
    getBaseScore,
    getLengthBonus,
    uniqueBonus: UNIQUE_BONUS,
  });

  // Calculate round scores and update totals
  for (const [pid] of gameState.roundWords) {
    const roundScore = scored.playerRoundScores[pid] || 0;
    const player = gameState.players.get(pid);
    if (player) {
      player.roundScores.push(roundScore);
      player.totalScore += roundScore;
    }
  }

  // Store scoring phases for host animation
  gameState.scoringPhases = [
    { phase: 'common', items: scored.commonItems },
    { phase: 'unique', items: scored.uniqueItems },
  ];

  // Determine round winner
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
  }

  // Update lifetime stats if game is over
  if (gameState.phase === 'gameOver') {
    // Find game winner
    let bestTotal = 0;
    let gameWinnerId = null;
    for (const [pid, p] of gameState.players) {
      if (p.totalScore > bestTotal) {
        bestTotal = p.totalScore;
        gameWinnerId = pid;
      }
    }

    for (const [, p] of gameState.players) {
      if (p.deviceId && playerProfiles[p.deviceId]) {
        const prof = playerProfiles[p.deviceId];
        prof.gamesPlayed = (prof.gamesPlayed || 0) + 1;
        prof.allTimeScore = (prof.allTimeScore || 0) + p.totalScore;
        if (p.id === gameWinnerId) {
          prof.gamesWon = (prof.gamesWon || 0) + 1;
        }
      }
    }
    saveProfiles();
  }

  broadcastHostState();
  broadcastAllPlayers();
}

function handleWordSubmission(playerId, word) {
  if (word.length < 3) {
    sendToPlayer(playerId, { type: 'word-result', word, valid: false, reason: 'too short' });
    return;
  }

  const playerWords = gameState.roundWords.get(playerId) || [];

  // Check for duplicate submission
  if (playerWords.some(w => w.word === word)) {
    sendToPlayer(playerId, { type: 'word-result', word, valid: false, reason: 'already submitted' });
    return;
  }

  const inDict = dictionary.isWord(word);
  const onBoard = inDict && gameState.validWordsOnBoard.has(word);
  const valid = inDict && onBoard;
  const score = valid ? getScore(word.length) : 0;

  const entry = { word, valid, score, reason: !inDict ? 'not a word' : !onBoard ? 'not on board' : 'ok' };
  playerWords.push(entry);
  gameState.roundWords.set(playerId, playerWords);

  sendToPlayer(playerId, { type: 'word-result', word, valid, score, reason: entry.reason });
  broadcastHostState();
  broadcastWordCounts();
}

function handlePathSubmission(playerId, pathIndices) {
  // Convert path of board indices to a word
  if (!gameState.board) return;

  const gridSize = gameState.board.length;
  const totalTiles = gridSize * gridSize;

  // Validate path: indices in range, no repeats, each adjacent to prior
  const seen = new Set();
  let word = '';
  for (let i = 0; i < pathIndices.length; i++) {
    const idx = pathIndices[i];
    if (typeof idx !== 'number' || idx < 0 || idx >= totalTiles) return;
    if (seen.has(idx)) return;

    if (i > 0) {
      const prevIdx = pathIndices[i - 1];
      const pr = Math.floor(prevIdx / gridSize), pc = prevIdx % gridSize;
      const cr = Math.floor(idx / gridSize), cc = idx % gridSize;
      if (Math.abs(pr - cr) > 1 || Math.abs(pc - cc) > 1) return;
    }

    seen.add(idx);
    const r = Math.floor(idx / gridSize);
    const c = idx % gridSize;
    word += gameState.board[r][c];
  }

  handleWordSubmission(playerId, word.toLowerCase());
}

// --- Broadcasting ---

function sendToWs(ws, msg) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  } else if (msg.type === 'state') {
    console.log(`[WS] Failed to send state (phase=${msg.data?.phase}): ws=${!!ws}, readyState=${ws?.readyState}`);
  }
}

function sendToPlayer(playerId, msg) {
  const p = gameState.players.get(playerId);
  if (!p) return;

  if (p.ws) {
    sendToWs(p.ws, msg);
  }

  // In hybrid WebRTC mode, mirror authoritative player-specific messages
  // through the host so players can rely on RTC for gameplay updates.
  if (p.rtcPeerId && gameState.hostWs) {
    sendToWs(gameState.hostWs, {
      type: 'rtc-forward',
      toPeerId: p.rtcPeerId,
      payload: msg,
    });
  }
}

function broadcastHostState() {
  const s = getHostState();
  console.log(`[broadcast] phase=${s.phase}, hostWs=${!!gameState.hostWs}, readyState=${gameState.hostWs?.readyState}`);
  if (gameState.hostWs) {
    sendToWs(gameState.hostWs, { type: 'state', data: s });
  }
}

function broadcastPlayerList() {
  const list = getPlayerList();
  for (const [id] of gameState.players) {
    sendToPlayer(id, { type: 'players', players: list });
  }
}

function broadcastWordCounts() {
  if (gameState.phase !== 'playing') return;
  const counts = {};
  for (const [pid, words] of gameState.roundWords) {
    counts[pid] = words.filter(w => w.valid).length;
  }
  for (const [id] of gameState.players) {
    sendToPlayer(id, { type: 'word-counts', counts });
  }
}

function broadcastAllPlayers() {
  for (const [id] of gameState.players) {
    sendToPlayer(id, { type: 'state', data: getPlayerState(id) });
  }
}

function broadcastToAll(msg) {
  if (gameState.hostWs) sendToWs(gameState.hostWs, msg);
  for (const [id] of gameState.players) {
    sendToPlayer(id, msg);
  }
}

// --- State builders ---

function getPlayerList() {
  return [...gameState.players.values()].map(p => {
    const profile = p.deviceId ? playerProfiles[p.deviceId] : null;
    return {
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      totalScore: p.totalScore,
      connected: p.connected,
      roundWins: p.roundWins || 0,
      stats: profile ? {
        gamesPlayed: profile.gamesPlayed || 0,
        gamesWon: profile.gamesWon || 0,
        allTimeScore: profile.allTimeScore || 0,
      } : null,
    };
  });
}

function getHostState() {
  const players = getPlayerList();

  // Per-player word counts during round
  const playerWordCounts = {};
  for (const [pid, words] of gameState.roundWords) {
    playerWordCounts[pid] = words.filter(w => w.valid).length;
  }

  // Round results (only after round ends)
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
  };
}

// --- Sanitization ---

function sanitize(str) {
  return String(str).replace(/[<>&"']/g, '');
}

function sanitizeAvatar(avatar) {
  const clean = {};
  // Background color
  if (avatar.bgColor) {
    clean.bgColor = sanitize(String(avatar.bgColor)).substring(0, 30);
  }
  // Drawing: must be a small data:image/png;base64 URL, cap at 15KB
  if (avatar.drawing && typeof avatar.drawing === 'string') {
    const MAX_DRAWING_SIZE = 15000;
    if (avatar.drawing.startsWith('data:image/png;base64,') && avatar.drawing.length <= MAX_DRAWING_SIZE) {
      clean.drawing = avatar.drawing;
    }
  }
  return clean;
}

// --- Get local IP ---
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }
  return 'localhost';
}

// --- Start ---
server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  console.log('');
  console.log('🧩 LexiTrack is running!');
  console.log('');
  console.log(`  Landing page:     http://${ip}:${PORT}/`);
  console.log(`  Dedicated host:   http://${ip}:${PORT}/host`);
  console.log(`  Phone (combined): http://${ip}:${PORT}/combined`);
  console.log(`  Players join at:  http://${ip}:${PORT}/player`);
  console.log('');
});
