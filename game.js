'use strict';

// ── Config ──────────────────────────────────────────────────────────────────

const MODES = {
  sprint: {
    id: 'sprint',
    name: 'SPRINT',
    subtitle: '10 targets — fastest time wins',
    targetCount: 10,
    timeLimit: null,
    scoreLabel: 'Total Time',
    lowerIsBetter: true,
  },
  blitz: {
    id: 'blitz',
    name: 'BLITZ',
    subtitle: '60 seconds — most targets wins',
    targetCount: null,
    timeLimit: 60,
    scoreLabel: 'Targets Hit',
    lowerIsBetter: false,
  },
  endurance: {
    id: 'endurance',
    name: 'ENDURANCE',
    subtitle: '25 targets — can you keep pace?',
    targetCount: 25,
    timeLimit: null,
    scoreLabel: 'Total Time',
    lowerIsBetter: true,
  },
};

const BOX_SIZE       = 72;
const BOX_PADDING    = 24;
const STORAGE_KEY    = 'reflexRush_v1_scores';
const MAX_PER_MODE   = 20;

// ── Audio ────────────────────────────────────────────────────────────────────

let audioCtx = null;
let muted = false;

function getAudioCtx() {
  if (!audioCtx) {
    try { audioCtx = new (window.AudioContext || window['webkitAudioContext'])(); }
    catch { return null; }
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Laser zap — downward frequency sweep with harmonics
function playLaser() {
  if (muted) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  const now = ctx.currentTime;

  // Main sweep: square wave high → low (the "pew")
  const osc1 = ctx.createOscillator();
  const g1   = ctx.createGain();
  osc1.connect(g1); g1.connect(ctx.destination);
  osc1.type = 'square';
  osc1.frequency.setValueAtTime(1100, now);
  osc1.frequency.exponentialRampToValueAtTime(120, now + 0.13);
  g1.gain.setValueAtTime(0.18, now);
  g1.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
  osc1.start(now); osc1.stop(now + 0.14);

  // Sub sine for punch
  const osc2 = ctx.createOscillator();
  const g2   = ctx.createGain();
  osc2.connect(g2); g2.connect(ctx.destination);
  osc2.type = 'sine';
  osc2.frequency.setValueAtTime(520, now);
  osc2.frequency.exponentialRampToValueAtTime(60, now + 0.09);
  g2.gain.setValueAtTime(0.22, now);
  g2.gain.exponentialRampToValueAtTime(0.0001, now + 0.1);
  osc2.start(now); osc2.stop(now + 0.1);
}

// Short ascending chime for game complete
function playComplete() {
  if (muted) return;
  const ctx = getAudioCtx();
  if (!ctx) return;
  [0, 0.1, 0.22].forEach((offset, i) => {
    const freq = [523, 659, 784][i]; // C5 E5 G5
    const now  = ctx.currentTime + offset;
    const osc  = ctx.createOscillator();
    const g    = ctx.createGain();
    osc.connect(g); g.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, now);
    g.gain.setValueAtTime(0.22, now);
    g.gain.exponentialRampToValueAtTime(0.0001, now + 0.25);
    osc.start(now); osc.stop(now + 0.25);
  });
}

// ── State ────────────────────────────────────────────────────────────────────

let state = {
  phase: 'menu',   // menu | waiting | playing | ended
  mode: null,
  clicks: 0,
  startTime: null,
  targetAppearTime: null,
  reactionTimes: [],
  timerRAF: null,
  countdownEnd: null,
};

// ── DOM refs ─────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const screens = {
  menu:        $('menu-screen'),
  game:        $('game-screen'),
  results:     $('results-screen'),
  leaderboard: $('leaderboard-screen'),
};

const gameArea    = $('game-area');
const startPrompt = $('start-prompt');

// ── Screen helpers ────────────────────────────────────────────────────────────

function showScreen(name) {
  Object.values(screens).forEach(s => s.classList.remove('active'));
  screens[name].classList.add('active');
}

// ── Event wiring ─────────────────────────────────────────────────────────────

document.querySelectorAll('.mode-card').forEach(card => {
  card.addEventListener('click', () => startMode(card.dataset.mode));
});

$('quit-btn').addEventListener('click', quitToMenu);
$('mute-btn').addEventListener('click', () => {
  muted = !muted;
  $('mute-btn').textContent = muted ? '🔇' : '🔊';
});
$('play-again-btn').addEventListener('click', () => startMode(state.mode));
$('menu-btn').addEventListener('click', () => showScreen('menu'));
$('results-lb-btn').addEventListener('click', () => openLeaderboard(state.mode));
$('leaderboard-btn').addEventListener('click', () => openLeaderboard('sprint'));
$('back-from-lb-btn').addEventListener('click', () => showScreen('menu'));
$('clear-scores-btn').addEventListener('click', clearAllScores);

document.querySelectorAll('.lb-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.lb-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    renderLeaderboard(tab.dataset.mode);
  });
});

// Game area — start on click while waiting, or eat stray clicks
gameArea.addEventListener('click', () => {
  if (state.phase === 'waiting') beginRound();
});

// ── Game flow ─────────────────────────────────────────────────────────────────

function startMode(modeId) {
  const cfg = MODES[modeId];

  cancelLoop();
  removeTarget();

  state = {
    phase: 'waiting',
    mode: modeId,
    clicks: 0,
    startTime: null,
    targetAppearTime: null,
    reactionTimes: [],
    timerRAF: null,
    countdownEnd: null,
  };

  // Header
  $('mode-label').textContent = cfg.name;
  $('stat-time-label').textContent = cfg.timeLimit ? 'TIME LEFT' : 'ELAPSED';

  // Reset stat display
  $('click-count').textContent = '0';
  $('timer').textContent = cfg.timeLimit ? `${cfg.timeLimit}.000` : '0.000';
  $('avg-reaction').textContent = '-.---';

  // Prompt text
  $('prompt-sub-text').textContent = cfg.subtitle;
  startPrompt.style.display = 'flex';

  showScreen('game');
}

function beginRound() {
  state.phase = 'playing';
  state.startTime = performance.now();

  startPrompt.style.display = 'none';

  const cfg = MODES[state.mode];
  if (cfg.timeLimit) {
    state.countdownEnd = state.startTime + cfg.timeLimit * 1000;
    tickCountdown();
  } else {
    tickElapsed();
  }

  spawnTarget();
}

// ── Timer loops (rAF) ─────────────────────────────────────────────────────────

function tickElapsed() {
  const elapsed = (performance.now() - state.startTime) / 1000;
  $('timer').textContent = elapsed.toFixed(3);
  state.timerRAF = requestAnimationFrame(tickElapsed);
}

function tickCountdown() {
  const remaining = Math.max(0, (state.countdownEnd - performance.now()) / 1000);
  $('timer').textContent = remaining.toFixed(3);

  if (remaining <= 0) {
    $('timer').textContent = '0.000';
    endGame();
    return;
  }

  state.timerRAF = requestAnimationFrame(tickCountdown);
}

function cancelLoop() {
  if (state.timerRAF) {
    cancelAnimationFrame(state.timerRAF);
    state.timerRAF = null;
  }
}

// ── Target ────────────────────────────────────────────────────────────────────

function spawnTarget() {
  removeTarget();

  const areaW = gameArea.clientWidth;
  const areaH = gameArea.clientHeight;

  const maxX = Math.max(BOX_PADDING, areaW - BOX_SIZE - BOX_PADDING);
  const maxY = Math.max(BOX_PADDING, areaH - BOX_SIZE - BOX_PADDING);

  const x = Math.floor(Math.random() * (maxX - BOX_PADDING)) + BOX_PADDING;
  const y = Math.floor(Math.random() * (maxY - BOX_PADDING)) + BOX_PADDING;

  const el = document.createElement('div');
  el.className = 'target';
  el.style.left = x + 'px';
  el.style.top  = y + 'px';

  el.addEventListener('click', onTargetClick, { once: true });
  gameArea.appendChild(el);

  // Trigger CSS appear animation next frame
  requestAnimationFrame(() => el.classList.add('appear'));

  state.targetAppearTime = performance.now();
}

function removeTarget() {
  const el = gameArea.querySelector('.target');
  if (el) el.remove();
}

function onTargetClick(e) {
  if (state.phase !== 'playing') return;

  const reaction = performance.now() - state.targetAppearTime;
  state.reactionTimes.push(reaction);
  state.clicks++;

  playLaser();

  // Show click ripple
  spawnRipple(e.currentTarget);

  // Update header stats
  $('click-count').textContent = state.clicks;
  const avg = state.reactionTimes.reduce((a, b) => a + b, 0) / state.reactionTimes.length;
  $('avg-reaction').textContent = (avg / 1000).toFixed(3);

  const cfg = MODES[state.mode];
  if (cfg.targetCount && state.clicks >= cfg.targetCount) {
    endGame();
  } else {
    spawnTarget();
  }
}

function spawnRipple(targetEl) {
  const ripple = document.createElement('div');
  ripple.className = 'click-ripple';
  ripple.style.left = targetEl.style.left;
  ripple.style.top  = targetEl.style.top;
  gameArea.appendChild(ripple);
  ripple.addEventListener('animationend', () => ripple.remove(), { once: true });
}

// ── End Game ──────────────────────────────────────────────────────────────────

function endGame() {
  state.phase = 'ended';
  cancelLoop();
  removeTarget();

  const cfg     = MODES[state.mode];
  const totalMs = performance.now() - state.startTime;
  const totalS  = totalMs / 1000;
  const score   = cfg.timeLimit ? state.clicks : totalS;
  const times   = state.reactionTimes;
  const avgMs   = times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0;

  playComplete();

  saveScore({
    mode:        state.mode,
    score,
    avgReaction: avgMs,
    clicks:      state.clicks,
    totalTime:   totalS,
    date:        new Date().toISOString(),
  });

  showResults({ cfg, score, avgMs, totalS });
}

function showResults({ cfg, score, avgMs, totalS }) {
  const times = state.reactionTimes;

  $('result-mode').textContent = cfg.name;

  if (cfg.timeLimit) {
    $('result-score-label').textContent = 'Targets Hit';
    $('result-score').textContent = state.clicks;
  } else {
    $('result-score-label').textContent = 'Total Time';
    $('result-score').textContent = totalS.toFixed(3) + 's';
  }

  $('result-avg-reaction').textContent =
    times.length ? (avgMs / 1000).toFixed(3) + 's' : '—';
  $('result-best-reaction').textContent =
    times.length ? (Math.min(...times) / 1000).toFixed(3) + 's' : '—';
  $('result-worst-reaction').textContent =
    times.length ? (Math.max(...times) / 1000).toFixed(3) + 's' : '—';
  $('result-clicks').textContent = state.clicks;

  // New best?
  const isNewBest = checkNewBest(score, cfg);
  $('high-score-badge').style.display = isNewBest ? 'block' : 'none';

  renderReactionBreakdown(times);
  showScreen('results');
}

function checkNewBest(score, cfg) {
  const scores = loadLeaderboard(state.mode);
  // Must have more than 1 entry (includes the one just saved)
  if (scores.length <= 1) return true;
  const others = scores.slice(1).map(s => s.score);
  return cfg.lowerIsBetter
    ? score < Math.min(...others)
    : score > Math.max(...others);
}

function renderReactionBreakdown(times) {
  const container = $('reaction-breakdown');
  container.innerHTML = '';

  if (!times.length) return;

  const maxT = Math.max(...times);

  times.forEach((t, i) => {
    const pct = (t / maxT) * 100;
    let color;
    if (t < 280)      color = '#00e87a';
    else if (t < 450) color = '#ffcc00';
    else if (t < 700) color = '#ff8c00';
    else              color = '#ff3333';

    const bar = document.createElement('div');
    bar.className = 'reaction-bar';
    bar.innerHTML = `
      <div class="reaction-bar-track" style="flex:1">
        <div class="reaction-bar-fill" style="width:${pct.toFixed(1)}%;background:${color}"></div>
      </div>
      <span class="reaction-bar-label">#${i + 1} &nbsp;${(t / 1000).toFixed(3)}s</span>
    `;
    container.appendChild(bar);
  });
}

// ── Leaderboard ───────────────────────────────────────────────────────────────

function loadAllScores() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
  } catch { return []; }
}

function loadLeaderboard(modeId) {
  const cfg = MODES[modeId];
  return loadAllScores()
    .filter(s => s.mode === modeId)
    .sort((a, b) => cfg.lowerIsBetter ? a.score - b.score : b.score - a.score);
}

function saveScore(entry) {
  const all = loadAllScores();
  all.push(entry);

  // Trim to MAX_PER_MODE per mode
  const trimmed = [];
  Object.keys(MODES).forEach(modeId => {
    const cfg = MODES[modeId];
    const sorted = all
      .filter(s => s.mode === modeId)
      .sort((a, b) => cfg.lowerIsBetter ? a.score - b.score : b.score - a.score)
      .slice(0, MAX_PER_MODE);
    trimmed.push(...sorted);
  });

  localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
}

function clearAllScores() {
  if (!confirm('Clear ALL leaderboard scores? This cannot be undone.')) return;
  localStorage.removeItem(STORAGE_KEY);
  const activeTab = document.querySelector('.lb-tab.active');
  renderLeaderboard(activeTab ? activeTab.dataset.mode : 'sprint');
}

function openLeaderboard(defaultMode = 'sprint') {
  document.querySelectorAll('.lb-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.mode === defaultMode);
  });
  renderLeaderboard(defaultMode);
  showScreen('leaderboard');
}

function renderLeaderboard(modeId) {
  const cfg    = MODES[modeId];
  const scores = loadLeaderboard(modeId);
  const tbody  = $('lb-tbody');
  const empty  = $('lb-empty');
  const table  = document.querySelector('.lb-table-wrap .lb-table');

  if (!scores.length) {
    table.style.display = 'none';
    empty.style.display = 'block';
    return;
  }

  table.style.display = '';
  empty.style.display = 'none';
  tbody.innerHTML = '';

  const medals = ['🥇', '🥈', '🥉'];

  scores.forEach((entry, i) => {
    const tr = document.createElement('tr');
    if (i === 0) tr.classList.add('top-score');

    const rank = medals[i] ?? `#${i + 1}`;

    const scoreText = cfg.timeLimit
      ? `${entry.clicks} targets`
      : `${entry.score.toFixed(3)}s`;

    const avgText = entry.avgReaction
      ? (entry.avgReaction / 1000).toFixed(3) + 's'
      : '—';

    const date = new Date(entry.date).toLocaleDateString(undefined, {
      month: 'short', day: 'numeric', year: '2-digit',
    });

    tr.innerHTML = `
      <td class="rank-cell">${rank}</td>
      <td style="font-family:var(--mono);font-weight:700">${scoreText}</td>
      <td style="font-family:var(--mono)">${avgText}</td>
      <td>${entry.clicks}</td>
      <td style="color:var(--text-dim);font-size:12px">${date}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ── Quit ──────────────────────────────────────────────────────────────────────

function quitToMenu() {
  cancelLoop();
  removeTarget();
  state.phase = 'menu';
  showScreen('menu');
}
