// --- State ---
let state = null;
let ws = null;
const UNIQUE_BONUS = 2; // display only; matches server logic
let scoringAnimationActive = false;
let scoringAnimationDoneForRound = -1;
let previousWordCounts = {};

// --- WebSocket Connection ---
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'host-join' }));
    loadServerInfo();
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    switch (msg.type) {
      case 'state': renderWithState(msg.data); break;
      case 'timer': updateTimer(msg.remaining); break;
    }
  };

  ws.onclose = () => setTimeout(connectWs, 2000);
}

function sendHost(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

async function loadServerInfo() {
  try {
    const res = await fetch('/api/info');
    const info = await res.json();
    const urlEl = document.getElementById('join-url');
    if (urlEl) urlEl.textContent = info.playerUrl;
  } catch (e) {
    console.warn('Failed to load server info:', e);
  }
}

// --- Host Control Buttons ---
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-host-start')?.addEventListener('click', () => {
    sendHost({ type: 'start-game' });
  });
  document.getElementById('btn-host-next')?.addEventListener('click', () => {
    sendHost({ type: 'next-round' });
  });
  document.getElementById('btn-host-restart')?.addEventListener('click', () => {
    sendHost({ type: 'restart' });
  });
});

// --- State + Render ---
function renderWithState(nextState) {
  state = nextState;
  render();
}

function render() {
  if (!state) return;

  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screenId = `screen-${state.phase}`;
  const screen = document.getElementById(screenId);
  if (screen) screen.classList.add('active');

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

  const startBtn = document.getElementById('btn-host-start');
  if (startBtn) startBtn.disabled = !state.players || state.players.length === 0;
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

  if (state.playerWordCounts) {
    previousWordCounts = { ...state.playerWordCounts };
  }
}

// --- TIMER ---
function updateTimer(remaining) {
  const el = document.getElementById('timer');
  if (!el) return;
  el.textContent = remaining;
  el.className = 'timer';
  if (remaining <= 10) el.classList.add('danger');
  else if (remaining <= 30) el.classList.add('warning');
}

// --- ROUND END (animated scoring) ---
function renderRoundEnd() {
  document.getElementById('round-end-num').textContent = state.round;
  const container = document.getElementById('round-results');
  const standingsEl = document.getElementById('standings');
  const standingsCard = standingsEl ? (standingsEl.closest('.card') || standingsEl.parentElement) : null;

  if (standingsCard) standingsCard.style.display = 'none';

  container.innerHTML = `
    <div id="scoring-animation">
      <div id="scoring-players" class="scoring-players"></div>
      <div id="scoring-phase-label" class="scoring-phase-label"></div>
      <div id="scoring-words" class="scoring-words"></div>
    </div>
  `;

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
      state.players.forEach(p => {
        const el = document.getElementById(`score-display-${p.id}`);
        if (el) el.textContent = p.totalScore;
      });
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

  setTimeout(() => {
    phaseLabel.textContent = '⭐ Unique Words (+' + UNIQUE_BONUS + ' bonus each)';
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
  if (avatar && avatar.drawing) {
    return crown + `<img src="${avatar.drawing}" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`;
  }
  return crown + '🎲';
}

function esc(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

// --- INIT ---
connectWs();
