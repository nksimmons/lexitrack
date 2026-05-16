const BG_COLORS = ['#e63946','#457b9d','#2a9d8f','#e9c46a','#f4a261','#264653','#6a4c93','#1982c4','#8ac926','#ff595e','#ff924c','#c77dff'];
const DRAW_COLORS = ['#ffffff','#ff4444','#ff8800','#ffdd00','#44cc44','#2299ff','#aa44ff','#ff66cc','#88ccff','#aaaaaa'];
const roomParam = new URLSearchParams(location.search).get('room');

let playerId = null;
let state = null;
let selectedPath = []; // indices into the 4x4 grid
let isDragging = false;
let avatarChoice = { drawing: null, bgColor: BG_COLORS[0] };
let ws = null;
let playerPeer = null;
let sendFn = null;

// --- Device Identity (persistent across sessions) ---
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
  const avatarStr = localStorage.getItem('lexitrack-avatar');
  let avatar = null;
  try { avatar = avatarStr ? JSON.parse(avatarStr) : null; } catch(e) {}
  return { name, avatar };
}

const deviceId = getDeviceId();

// --- Drawing Avatar Builder ---
let drawCtx, drawCanvas;
let drawStrokes = []; // array of strokes, each stroke is { color, width, points: [{x,y}] }
let currentStroke = null;
let drawColor = DRAW_COLORS[0];
let isDrawing = false;

function initAvatarBuilder() {
  drawCanvas = document.getElementById('draw-canvas');
  drawCtx = drawCanvas.getContext('2d');

  // Set up high-DPI canvas
  const dpr = window.devicePixelRatio || 1;
  const rect = drawCanvas.getBoundingClientRect();
  drawCanvas.width = rect.width * dpr;
  drawCanvas.height = rect.height * dpr;
  drawCtx.scale(dpr, dpr);

  // Draw color swatches
  const colorsEl = document.getElementById('draw-colors');
  colorsEl.innerHTML = DRAW_COLORS.map(c => `
    <div class="draw-color ${c === drawColor ? 'selected' : ''}" data-color="${c}" style="background:${c}"></div>
  `).join('');
  colorsEl.addEventListener('click', (e) => {
    const el = e.target.closest('.draw-color');
    if (!el) return;
    colorsEl.querySelectorAll('.draw-color').forEach(d => d.classList.remove('selected'));
    el.classList.add('selected');
    drawColor = el.dataset.color;
  });

  // Background color
  const selectedColor = avatarChoice.bgColor || BG_COLORS[0];
  const colorContainer = document.getElementById('color-options');
  colorContainer.innerHTML = BG_COLORS.map((c) => `
    <div class="color-option ${c === selectedColor ? 'selected' : ''}" data-color="${c}" style="background:${c}"></div>
  `).join('');
  colorContainer.addEventListener('click', (e) => {
    const opt = e.target.closest('.color-option');
    if (!opt) return;
    colorContainer.querySelectorAll('.color-option').forEach(o => o.classList.remove('selected'));
    opt.classList.add('selected');
    avatarChoice.bgColor = opt.dataset.color;
    redrawCanvas();
    updateAvatarPreview();
  });

  // Drawing events (pointer events for mouse+touch)
  drawCanvas.addEventListener('pointerdown', onDrawStart);
  drawCanvas.addEventListener('pointermove', onDrawMove);
  drawCanvas.addEventListener('pointerup', onDrawEnd);
  drawCanvas.addEventListener('pointerleave', onDrawEnd);

  document.getElementById('btn-undo').addEventListener('click', () => {
    drawStrokes.pop();
    redrawCanvas();
    updateAvatarPreview();
  });

  document.getElementById('btn-clear').addEventListener('click', () => {
    drawStrokes = [];
    redrawCanvas();
    updateAvatarPreview();
  });

  // Restore saved drawing if available
  if (avatarChoice.drawing) {
    const img = new Image();
    img.onload = () => {
      const rect = drawCanvas.getBoundingClientRect();
      drawCtx.drawImage(img, 0, 0, rect.width, rect.height);
      // We can't reconstruct strokes from image, but that's OK
      drawStrokes = [{ restored: true }];
      updateAvatarPreview();
    };
    img.src = avatarChoice.drawing;
  } else {
    redrawCanvas();
  }

  updateAvatarPreview();
}

function getCanvasPos(e) {
  const rect = drawCanvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function onDrawStart(e) {
  e.preventDefault();
  drawCanvas.setPointerCapture(e.pointerId);
  isDrawing = true;
  const pos = getCanvasPos(e);
  currentStroke = { color: drawColor, width: 3, points: [pos] };
  // If we restored from image, clear the restoration marker and start fresh tracking
  if (drawStrokes.length === 1 && drawStrokes[0].restored) {
    drawStrokes = [];
    // Canvas already has the image, just keep going
  }
}

function onDrawMove(e) {
  if (!isDrawing || !currentStroke) return;
  e.preventDefault();
  const pos = getCanvasPos(e);
  currentStroke.points.push(pos);
  // Draw just the new segment for performance
  const pts = currentStroke.points;
  drawCtx.beginPath();
  drawCtx.strokeStyle = currentStroke.color;
  drawCtx.lineWidth = currentStroke.width;
  drawCtx.lineCap = 'round';
  drawCtx.lineJoin = 'round';
  if (pts.length >= 2) {
    drawCtx.moveTo(pts[pts.length - 2].x, pts[pts.length - 2].y);
    drawCtx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
  }
  drawCtx.stroke();
}

function onDrawEnd(e) {
  if (!isDrawing || !currentStroke) return;
  isDrawing = false;
  if (currentStroke.points.length >= 2) {
    drawStrokes.push(currentStroke);
  } else if (currentStroke.points.length === 1) {
    // Draw a dot for single tap
    const p = currentStroke.points[0];
    drawCtx.beginPath();
    drawCtx.fillStyle = currentStroke.color;
    drawCtx.arc(p.x, p.y, currentStroke.width, 0, Math.PI * 2);
    drawCtx.fill();
    drawStrokes.push(currentStroke);
  }
  currentStroke = null;
  updateAvatarPreview();
}

function redrawCanvas() {
  const rect = drawCanvas.getBoundingClientRect();
  const w = rect.width, h = rect.height;
  drawCtx.clearRect(0, 0, w, h);
  // Fill background
  drawCtx.fillStyle = avatarChoice.bgColor || BG_COLORS[0];
  drawCtx.fillRect(0, 0, w, h);

  for (const stroke of drawStrokes) {
    if (stroke.restored) continue;
    drawCtx.beginPath();
    drawCtx.strokeStyle = stroke.color;
    drawCtx.lineWidth = stroke.width;
    drawCtx.lineCap = 'round';
    drawCtx.lineJoin = 'round';
    const pts = stroke.points;
    if (pts.length === 1) {
      drawCtx.fillStyle = stroke.color;
      drawCtx.arc(pts[0].x, pts[0].y, stroke.width, 0, Math.PI * 2);
      drawCtx.fill();
    } else {
      drawCtx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) {
        drawCtx.lineTo(pts[i].x, pts[i].y);
      }
      drawCtx.stroke();
    }
  }
}

function getDrawingDataUrl() {
  // Export to small PNG (60x60 to keep payload small)
  const exportCanvas = document.createElement('canvas');
  exportCanvas.width = 60;
  exportCanvas.height = 60;
  const ectx = exportCanvas.getContext('2d');
  // Fill bg
  ectx.fillStyle = avatarChoice.bgColor || BG_COLORS[0];
  ectx.fillRect(0, 0, 60, 60);
  // Draw the full canvas scaled down
  const rect = drawCanvas.getBoundingClientRect();
  ectx.drawImage(drawCanvas, 0, 0, drawCanvas.width, drawCanvas.height, 0, 0, 60, 60);
  return exportCanvas.toDataURL('image/png');
}

function updateAvatarPreview() {
  const preview = document.getElementById('avatar-preview');
  preview.textContent = '';
  preview.style.background = avatarChoice.bgColor;
  if (drawStrokes.length > 0) {
    const dataUrl = getDrawingDataUrl();
    avatarChoice.drawing = dataUrl;
    preview.style.backgroundImage = `url(${dataUrl})`;
    preview.style.backgroundSize = 'cover';
  } else {
    avatarChoice.drawing = null;
    preview.style.backgroundImage = '';
  }
}

// --- WebSocket Connection ---
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    sendFn = (msg) => ws.send(JSON.stringify(msg));
    send({ type: 'reconnect', deviceId });
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    processServerMessage(msg);
  };

  ws.onclose = () => {
    sendFn = null;
    setTimeout(connectWs, 2000);
  };
}

// --- Trystero Connection (BitTorrent signaling — no server needed) ---
function connectPeer(roomCode) {
  playerPeer = new TrysteroPlayerPeer('nksimmons-lexitrack');

  playerPeer.on('open', () => {
    const conn = playerPeer.connect(roomCode);

    conn.on('open', () => {
      sendFn = (msg) => conn.send(msg);
      send({ type: 'reconnect', deviceId });
    });

    conn.on('data', (msg) => {
      if (msg && typeof msg === 'object') processServerMessage(msg);
    });

    conn.on('close', () => {
      sendFn = null;
      setTimeout(() => connectPeer(roomCode), 3000);
    });
  });

  playerPeer.on('error', () => {
    setTimeout(() => connectPeer(roomCode), 3000);
  });
}

async function processServerMessage(msg) {
  switch (msg.type) {
    case 'joined':
      playerId = msg.playerId;
      state = msg.data;
      if (msg.profile) {
        // Save updated profile from server
        saveProfile(msg.profile.name, msg.profile.avatar);
      }
      render();
      break;
    case 'reconnected':
      playerId = msg.playerId;
      state = msg.data;
      render();
      break;
    case 'unknown-device':
      // Not in an active game, show join screen
      render();
      break;
    case 'state':
      state = msg.data;
      render();
      break;
    case 'players':
      if (state) state.players = msg.players;
      renderPlayerList();
      break;
    case 'word-counts':
      if (state) state.playerWordCounts = msg.counts;
      break;
    case 'timer':
      updateTimer(msg.remaining);
      break;
    case 'word-result':
      handleWordResult(msg);
      break;
  }
}

function send(msg) {
  if (sendFn) sendFn(msg);
}

// --- Render ---
function render() {
  if (!state) return;

  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));

  if (!playerId) {
    document.getElementById('screen-join').classList.add('active');
    return;
  }

  const screenId = `screen-${state.phase}`;
  const screen = document.getElementById(screenId);
  if (screen) screen.classList.add('active');

  switch (state.phase) {
    case 'lobby': renderLobby(); break;
    case 'playing': renderPlaying(); break;
    case 'roundEnd': renderRoundEnd(); break;
    case 'gameOver': renderGameOver(); break;
  }
}

function renderLobby() {
  renderPlayerList();
  updateHostControls();
}

function renderPlaying() {
  document.getElementById('round-num').textContent = state.round;
  document.getElementById('max-rounds').textContent = state.maxRounds;

  // Render word counts for all players
  const countsEl = document.getElementById('word-count-bar');
  if (countsEl && state.players) {
    const myValidCount = state.myWords ? state.myWords.filter(w => w.valid).length : 0;
    countsEl.innerHTML = state.players.map(p => {
      const count = state.playerWordCounts != null
        ? (state.playerWordCounts[p.id] ?? 0)
        : (p.id === playerId ? myValidCount : 0);
      const isMe = p.id === playerId;
      return `<div class="count-chip${isMe ? ' me' : ''}"><div class="mini-avatar" style="background:${p.avatar.bgColor || '#4a3a6e'}"></div><span class="count-label">${esc(p.name.split(' ')[0])}</span><span class="count-num">${count}</span></div>`;
    }).join('');
  }

  renderBoard();
  renderMyWords();
}

function renderBoard() {
  const container = document.getElementById('board');
  if (!state.board) return;

  container.innerHTML = state.board.flat().map((letter, idx) => `
    <div class="tile" data-idx="${idx}">${letter}</div>
  `).join('');

  // Restore selection state
  updateBoardSelection();

  // Attach touch/mouse events
  attachBoardEvents();
}

function updateBoardSelection() {
  const tiles = document.querySelectorAll('#board .tile');
  tiles.forEach(t => {
    t.classList.remove('selected', 'adjacent');
  });
  for (const idx of selectedPath) {
    tiles[idx]?.classList.add('selected');
  }

  // Show adjacent hints for last selected tile
  if (selectedPath.length > 0) {
    const last = selectedPath[selectedPath.length - 1];
    const neighbors = getNeighbors(last);
    for (const n of neighbors) {
      if (!selectedPath.includes(n)) {
        tiles[n]?.classList.add('adjacent');
      }
    }
  }

  // Update current word display
  updateCurrentWord();
}

function updateCurrentWord() {
  const el = document.getElementById('current-word');
  if (!state.board || selectedPath.length === 0) {
    el.innerHTML = '&nbsp;';
    return;
  }
  const word = selectedPath.map(idx => {
    const r = Math.floor(idx / 4);
    const c = idx % 4;
    return state.board[r][c];
  }).join('');
  el.textContent = word;
}

function renderMyWords() {
  const container = document.getElementById('my-words');
  if (!state.myWords) return;
  container.innerHTML = `<ul class="word-list">${state.myWords.map(w => `
    <li class="word-tag ${w.valid ? 'valid' : 'invalid'}">${esc(w.word)}${w.valid ? `<span class="score">+${w.score}</span>` : ''}</li>
  `).join('')}</ul>`;
}

function renderRoundEnd() {
  document.getElementById('round-end-num').textContent = state.round;
  updateHostControls();

  // Round winner banner
  const winnerBanner = document.getElementById('round-winner-banner');
  if (winnerBanner) {
    if (state.lastRoundWinnerId) {
      const winner = state.players.find(p => p.id === state.lastRoundWinnerId);
      if (winner) {
        const isMe = winner.id === playerId;
        winnerBanner.innerHTML = `<div class="round-winner-card${isMe ? ' is-me' : ''}">👑 ${isMe ? 'You won this round!' : `${esc(winner.name)} wins this round!`}</div>`;
        winnerBanner.style.display = '';
      }
    } else {
      winnerBanner.style.display = 'none';
    }
  }

  const container = document.getElementById('round-end-words');
  const words = state.myWords || [];
  container.innerHTML = `
    <h2 style="margin-bottom:0.5rem">Your Words</h2>
    <ul class="word-list">${words.map(w => {
      let cls = 'invalid';
      if (w.reason === 'unique') cls = 'valid';
      else if (w.reason === 'common') cls = 'common';
      return `<li class="word-tag ${cls}">${esc(w.word)}${w.finalScore ? `<span class="score">+${w.finalScore}</span>` : ''}</li>`;
    }).join('')}</ul>
  `;

  renderStandings(document.getElementById('player-standings'));
}

function renderGameOver() {
  renderStandings(document.getElementById('final-player-list'));
  updateHostControls();
}

function renderStandings(container) {
  if (!state.players) return;
  const sorted = [...state.players].sort((a, b) => b.totalScore - a.totalScore);
  container.innerHTML = sorted.map((p, i) => `
    <div class="player-card" style="display:flex;align-items:center;gap:1rem;padding:0.75rem;width:100%;text-align:left;${p.id === playerId ? 'border:2px solid var(--accent)' : ''}">
      <span style="font-size:1.2rem;font-weight:900;color:var(--text-dim);width:30px">${i + 1}</span>
      <div class="avatar" style="background:${p.avatar.bgColor || '#4a3a6e'};width:40px;height:40px;font-size:1.2rem;margin:0">${renderAvatarContent(p.avatar, p.roundWins)}</div>
      <span class="player-name" style="flex:1">${esc(p.name)}</span>
      <span class="player-score" style="font-size:1.3rem">${p.totalScore}</span>
    </div>
  `).join('');
}

function renderPlayerList() {
  const container = document.getElementById('lobby-player-list');
  if (!container || !state || !state.players) return;
  container.innerHTML = `<div class="scoreboard">${state.players.map(p => `
    <div class="player-card" ${p.id === playerId ? 'style="border:2px solid var(--accent)"' : ''}>
      <div class="avatar" style="background:${p.avatar.bgColor || '#4a3a6e'}">${renderAvatarContent(p.avatar, p.roundWins)}</div>
      <div class="player-name">${esc(p.name)}</div>
    </div>
  `).join('')}</div>`;
}

// --- Board Touch/Mouse Events ---
function attachBoardEvents() {
  const board = document.getElementById('board');
  const tiles = board.querySelectorAll('.tile');

  // Cache tile centers for distance-based hit detection
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
    for (const t of tileCenters) {
      const dx = x - t.cx, dy = y - t.cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < maxRadius && dist < bestDist) {
        best = t.idx;
        bestDist = dist;
      }
    }
    // Only switch to a new tile if we're clearly closer to it than the current tile
    if (best !== null && selectedPath.length > 0) {
      const last = selectedPath[selectedPath.length - 1];
      if (best !== last) {
        const lastTile = tileCenters[last];
        const distToLast = Math.sqrt((x - lastTile.cx) ** 2 + (y - lastTile.cy) ** 2);
        // Must be at least 60% of the way from current tile center to new tile center
        if (bestDist > distToLast * 0.7) {
          return last; // stay on current tile
        }
      }
    }
    return best;
  }

  board.addEventListener('pointerdown', (e) => {
    const tile = e.target.closest('.tile');
    if (!tile) return;
    e.preventDefault();
    isDragging = true;
    selectedPath = [];
    cacheTileCenters();
    const idx = parseInt(tile.dataset.idx, 10);
    selectedPath.push(idx);
    updateBoardSelection();
    board.setPointerCapture(e.pointerId);
  });

  board.addEventListener('pointermove', (e) => {
    if (!isDragging) return;
    e.preventDefault();
    const idx = getNearestTile(e.clientX, e.clientY);
    if (idx === null) return;

    // Already in path?
    if (selectedPath.includes(idx)) {
      // Allow backtracking: if it's the second-to-last, pop the last
      if (selectedPath.length >= 2 && selectedPath[selectedPath.length - 2] === idx) {
        selectedPath.pop();
        updateBoardSelection();
      }
      return;
    }

    // Must be adjacent to last
    const last = selectedPath[selectedPath.length - 1];
    if (isAdjacent(last, idx)) {
      selectedPath.push(idx);
      updateBoardSelection();
    }
  });

  board.addEventListener('pointerup', (e) => {
    if (isDragging && selectedPath.length >= 3) {
      submitPath();
    } else {
      clearSelection();
    }
    isDragging = false;
  });
}

function getNeighbors(idx) {
  const r = Math.floor(idx / 4);
  const c = idx % 4;
  const neighbors = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < 4 && nc >= 0 && nc < 4) {
        neighbors.push(nr * 4 + nc);
      }
    }
  }
  return neighbors;
}

function isAdjacent(idx1, idx2) {
  const r1 = Math.floor(idx1 / 4), c1 = idx1 % 4;
  const r2 = Math.floor(idx2 / 4), c2 = idx2 % 4;
  return Math.abs(r1 - r2) <= 1 && Math.abs(c1 - c2) <= 1;
}

// --- Submit ---
function submitPath() {
  if (selectedPath.length < 3) {
    toast('Too short! (3+ letters)', 'error');
    return;
  }
  send({ type: 'submit-path', path: selectedPath });
  selectedPath = [];
  updateBoardSelection();
}



function clearSelection() {
  selectedPath = [];
  updateBoardSelection();
}

// --- Word Result ---
function handleWordResult(msg) {
  if (msg.valid) {
    toast(`${msg.word.toUpperCase()} +${msg.score}`, 'success');
    playFeedback('success');
  } else if (msg.reason === 'already submitted') {
    toast(`${msg.word.toUpperCase()} — ${msg.reason}`, 'error');
    playFeedback('duplicate');
  } else {
    toast(`${msg.word.toUpperCase()} — ${msg.reason}`, 'error');
    playFeedback('error');
  }
}

// --- Haptic + Sound Feedback ---
function playFeedback(type) {
  // Haptic vibration (mobile devices)
  if (navigator.vibrate) {
    if (type === 'success') {
      navigator.vibrate([40, 30, 40]);
    } else if (type === 'duplicate') {
      navigator.vibrate(30);
    } else {
      navigator.vibrate(100);
    }
  }
  // Audio feedback using Web Audio API (no files needed)
  playTone(type);
}

let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioCtx;
}

function playTone(type) {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    gain.gain.value = 0.15;

    if (type === 'success') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(523, ctx.currentTime);      // C5
      osc.frequency.setValueAtTime(659, ctx.currentTime + 0.08); // E5
      osc.frequency.setValueAtTime(784, ctx.currentTime + 0.16); // G5
      gain.gain.setValueAtTime(0.15, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } else if (type === 'duplicate') {
      // Gentle short double-blip
      osc.type = 'sine';
      osc.frequency.setValueAtTime(440, ctx.currentTime);       // A4
      osc.frequency.setValueAtTime(380, ctx.currentTime + 0.08); // slight drop
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.18);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.18);
    } else {
      osc.type = 'square';
      osc.frequency.setValueAtTime(200, ctx.currentTime);
      osc.frequency.setValueAtTime(150, ctx.currentTime + 0.1);
      gain.gain.setValueAtTime(0.1, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.2);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.2);
    }
  } catch (e) {
    // Audio not available, silently ignore
  }
}

// --- Timer ---
function updateTimer(remaining) {
  const el = document.getElementById('timer');
  if (!el) return;
  el.textContent = remaining;
  el.className = 'timer';
  if (remaining <= 10) el.classList.add('danger');
  else if (remaining <= 30) el.classList.add('warning');
}

// --- Toast ---
function toast(text, type = 'success') {
  const container = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = text;
  container.appendChild(el);
  setTimeout(() => el.remove(), 2500);
}

// --- Events ---
document.getElementById('btn-join').addEventListener('click', () => {
  const name = document.getElementById('player-name').value.trim();
  if (!name) {
    document.getElementById('player-name').focus();
    return;
  }
  saveProfile(name, avatarChoice);
  send({ type: 'player-join', name, avatar: avatarChoice, deviceId });
});

document.getElementById('player-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('btn-join').click();
});

document.getElementById('btn-start-game').addEventListener('click', () => {
  send({ type: 'start-game' });
});

document.getElementById('btn-next-round').addEventListener('click', () => {
  send({ type: 'next-round' });
});

document.getElementById('btn-play-again').addEventListener('click', () => {
  send({ type: 'restart' });
});



// --- Host Controls ---
function isHostPlayer() {
  return state && state.hostPlayerId && state.hostPlayerId === playerId;
}

function updateHostControls() {
  const isHP = isHostPlayer();
  // Lobby
  const startBtn = document.getElementById('btn-start-game');
  const lobbyWait = document.getElementById('lobby-waiting-msg');
  if (startBtn) startBtn.style.display = isHP ? '' : 'none';
  if (lobbyWait) lobbyWait.style.display = isHP ? 'none' : '';
  // Round end
  const nextBtn = document.getElementById('btn-next-round');
  const roundWait = document.getElementById('roundend-waiting-msg');
  const roundControls = document.getElementById('roundend-host-controls');
  if (roundControls) roundControls.style.display = isHP ? '' : 'none';
  if (roundWait) roundWait.style.display = isHP ? 'none' : '';
  // Game over
  const againBtn = document.getElementById('btn-play-again');
  const goWait = document.getElementById('gameover-waiting-msg');
  const goControls = document.getElementById('gameover-host-controls');
  if (goControls) goControls.style.display = isHP ? '' : 'none';
  if (goWait) goWait.style.display = isHP ? 'none' : '';
}

// --- Utils ---
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

// --- Init ---
// Pre-fill from saved profile
(function prefillProfile() {
  const profile = loadProfile();
  if (profile.name) {
    document.getElementById('player-name').value = profile.name;
  }
  if (profile.avatar) {
    avatarChoice = { ...avatarChoice, ...profile.avatar };
  }
})();
initAvatarBuilder();
if (roomParam) {
  connectPeer(roomParam);
} else {
  connectWs();
}
