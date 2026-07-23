const socket = io();
const $ = (id) => document.getElementById(id);

let sessionState = null;
let rounds = [];
let participants = [];
let currentQuestion = null;
let ledgerLog = []; // client-side running log of {ledgerId, label} for undo buttons

// --- Auth ---
const urlParams = new URLSearchParams(window.location.search);
const urlSecret = urlParams.get('secret');
if (urlSecret) $('hostSecret').value = urlSecret;

function doAuth(secret) {
  socket.emit('host:auth', { hostSecret: secret }, (res) => {
    if (!res.ok) { $('authError').textContent = res.error; return; }
    sessionState = res.session;
    rounds = res.rounds;
    participants = res.participants;
    localStorage.setItem('quiz_host_secret', secret);
    $('auth-screen').style.display = 'none';
    $('dashboard').style.display = 'block';
    $('sessionInfo').textContent = `Room code: ${sessionState.room_code} — status: ${sessionState.status}`;
    renderRounds();
    renderParticipants();
    renderAdjustSelect();
    renderPatSelect();
    renderScoreboard(res.standings);
  });
}

$('authBtn').onclick = () => doAuth($('hostSecret').value.trim());
const savedSecret = localStorage.getItem('quiz_host_secret');
if (savedSecret && !urlSecret) { $('hostSecret').value = savedSecret; }
if (urlSecret) doAuth(urlSecret);

// --- Rounds / question list ---
function renderRounds() {
  const box = $('roundsList');
  box.innerHTML = '';
  rounds.forEach(r => {
    const h = document.createElement('h4');
    h.textContent = r.title + (r.completed ? ' — round complete' : '');
    box.appendChild(h);
    r.questions.forEach(q => {
      const row = document.createElement('div');
      row.style.marginBottom = '6px';
      const btn = document.createElement('button');
      btn.className = 'secondary';
      btn.textContent = `${q.public.title || q.id.slice(0,4)} [${q.status}]`;
      btn.onclick = () => socket.emit('host:openQuestion', { questionId: q.id }, () => {});
      row.appendChild(btn);

      const projBtn = document.createElement('button');
      projBtn.className = 'secondary';
      projBtn.textContent = '📽 Show on projector';
      // Can't show a question before it's opened, and never for Jasper-only questions.
      projBtn.style.display = (q.status === 'draft' || q.visibility === 'jasper_only') ? 'none' : 'inline-block';
      projBtn.onclick = () => {
        socket.emit('host:setProjector', { mode: 'question', questionId: q.id }, (res) => {
          if (res && res.ok) $('projectorNowShowing').textContent = q.public.title || 'Question';
        });
      };
      row.appendChild(projBtn);
      box.appendChild(row);
    });
    if (!r.completed) {
      const completeBtn = document.createElement('button');
      completeBtn.textContent = 'Complete round (locks all answers + scores this round)';
      completeBtn.onclick = () => {
        if (!confirm(`Complete "${r.title}"? Teams won't be able to change any answers in this round after this.`)) return;
        socket.emit('host:completeRound', { roundId: r.id }, (res) => {
          if (res && res.ok) { r.completed = true; renderRounds(); }
        });
      };
      box.appendChild(completeBtn);
    }
  });
}

$('blankProjectorBtn').onclick = () => {
  socket.emit('host:setProjector', { mode: 'blank' }, (res) => {
    if (res && res.ok) $('projectorNowShowing').textContent = 'blank / waiting screen';
  });
};
$('scoreboardProjectorBtn').onclick = () => {
  socket.emit('host:setProjector', { mode: 'scoreboard' }, (res) => {
    if (res && res.ok) $('projectorNowShowing').textContent = 'scoreboard';
  });
};

// --- Current question state (host view includes both team/jasper content + answer key) ---
socket.on('question:state', (q) => {
  if (!q.teamView) return; // this is a non-host payload variant, ignore (shouldn't happen on host room)
  currentQuestion = q;
  $('controls').style.display = 'block';
  $('currentQ').innerHTML = `
    <strong>${q.public.title}</strong> — <span class="badge">${q.status}</span><br>
    <span class="muted">Team: ${q.teamView.body}</span><br>
    <span class="muted">Jasper: ${q.jasperView.body}</span><br>
    <span class="muted">Answer key: ${JSON.stringify(q.answerKey)}</span>
  `;
  renderExclusionToggles(q);
  refreshRoundListStatuses();
});

function refreshRoundListStatuses() {
  // cheap way to reflect the newest status without a full re-fetch
  rounds.forEach(r => r.questions.forEach(q => { if (currentQuestion && q.id === currentQuestion.id) q.status = currentQuestion.status; }));
  renderRounds();
}

$('hint1Btn').onclick = () => currentQuestion && socket.emit('host:releaseHint', { questionId: currentQuestion.id, stage: 1 });
$('hint2Btn').onclick = () => currentQuestion && socket.emit('host:releaseHint', { questionId: currentQuestion.id, stage: 2 });
$('lockBtn').onclick = () => currentQuestion && socket.emit('host:lockQuestion', { questionId: currentQuestion.id });
$('revealBtn').onclick = () => currentQuestion && socket.emit('host:revealQuestion', { questionId: currentQuestion.id });
$('pauseBtn').onclick = () => socket.emit('host:pauseResume', { pause: true });
$('resumeBtn').onclick = () => socket.emit('host:pauseResume', { pause: false });

// --- Exclusions ---
function renderExclusionToggles(q) {
  const existing = document.getElementById('exclusionBox');
  if (existing) existing.remove();
  const box = document.createElement('div');
  box.id = 'exclusionBox';
  box.innerHTML = '<div class="muted" style="margin-top:8px;">Exclude from this question:</div>';
  participants.forEach(p => {
    const isExcluded = q.excludedParticipantIds.includes(p.id);
    const b = document.createElement('button');
    b.className = isExcluded ? 'danger' : 'secondary';
    b.textContent = `${p.name}${isExcluded ? ' (excluded)' : ''}`;
    b.onclick = () => socket.emit('host:excludeParticipant', { questionId: q.id, participantId: p.id, excluded: !isExcluded }, () => {});
    box.appendChild(b);
  });
  $('controls').appendChild(box);
}

// --- Participants ---
function renderParticipants() {
  const box = $('participantsList');
  box.innerHTML = '';
  participants.forEach(p => {
    const row = document.createElement('div');
    row.className = 'scoreboard-row';
    row.innerHTML = `<span>${p.name} ${p.type === 'jasper' ? '👑' : ''}</span><span class="muted">${p.connected ? 'online' : 'offline'}</span>`;
    box.appendChild(row);
  });
}
socket.on('participant:joined', (p) => { participants.push({ ...p, connected: 1 }); renderParticipants(); renderAdjustSelect(); renderPatSelect(); });
socket.on('participant:disconnected', ({ id }) => { const p = participants.find(x => x.id === id); if (p) p.connected = 0; renderParticipants(); });

// --- Submissions ---
socket.on('submission:received', ({ questionId, participantId }) => {
  const p = participants.find(x => x.id === participantId);
  const box = $('submissionsList');
  if (box.textContent === 'None yet.') box.innerHTML = '';
  const row = document.createElement('div');
  row.id = `sub_${participantId}`;
  row.className = 'card';
  row.innerHTML = `<strong>${p ? p.name : participantId}</strong> submitted an answer for this question. <span class="muted">Marking happens after lock (auto) or use buttons below for manual types.</span>`;
  box.prepend(row);
});

socket.on('submission:marked', ({ submissionId, status, points }) => {
  const line = document.createElement('div');
  line.className = 'muted';
  line.textContent = `Marked ${status} (${points} pts)`;
  $('submissionsList').prepend(line);
});

// --- Standings + ledger ---
function renderScoreboard(st) {
  const box = $('scoreboard');
  box.innerHTML = '';
  st.teams.forEach(t => {
    const row = document.createElement('div');
    row.className = 'scoreboard-row';
    row.innerHTML = `<span>${t.name}</span><span>${t.total}</span>`;
    box.appendChild(row);
  });
  if (st.jasper) {
    const row = document.createElement('div');
    row.className = 'scoreboard-row jasper-row';
    row.innerHTML = `<span>Jasper</span><span>${st.jasper.total}</span>`;
    box.appendChild(row);
  }
}
socket.on('score:updated', renderScoreboard);

function renderAdjustSelect() {
  const sel = $('adjustParticipant');
  sel.innerHTML = participants.map(p => `<option value="${p.id}">${p.name}</option>`).join('');
}
function renderPatSelect() {
  const sel = $('patParticipant');
  sel.innerHTML = participants.filter(p => p.type === 'team').map(p => `<option value="${p.id}">${p.name}</option>`).join('');
}

$('adjustBtn').onclick = () => {
  const participantId = $('adjustParticipant').value;
  const amount = Number($('adjustAmount').value);
  const reason = $('adjustReason').value || 'Manual adjustment';
  if (!participantId || Number.isNaN(amount)) return;
  socket.emit('host:adjustScore', { participantId, amount, reason }, (res) => {
    if (res.ok) logLedger(res.ledgerId, `${reason}: ${amount > 0 ? '+' : ''}${amount} to ${participants.find(p=>p.id===participantId)?.name}`);
    $('adjustAmount').value = ''; $('adjustReason').value = '';
  });
};

function logLedger(ledgerId, label) {
  ledgerLog.unshift({ ledgerId, label });
  renderLedgerLog();
}
function renderLedgerLog() {
  const box = $('ledgerLog');
  if (!ledgerLog.length) { box.textContent = '—'; return; }
  box.innerHTML = '';
  ledgerLog.slice(0, 20).forEach(entry => {
    const row = document.createElement('div');
    const b = document.createElement('button');
    b.className = 'secondary';
    b.style.fontSize = '12px';
    b.style.padding = '4px 8px';
    b.textContent = 'Undo';
    b.onclick = () => socket.emit('host:undoLedger', { ledgerId: entry.ledgerId }, (res) => {
      if (res.ok) { logLedger(null, `Undone: ${entry.label}`); }
    });
    row.appendChild(document.createTextNode(entry.label + ' '));
    if (entry.ledgerId) row.appendChild(b);
    box.appendChild(row);
  });
}

// --- Phone a Friend ---
$('patBtn').onclick = () => {
  const participantId = $('patParticipant').value;
  if (!participantId) return;
  const roundId = (rounds[0] && rounds[0].id) || null; // simple default; refine per-round selection if needed
  socket.emit('host:issuePatToken', { participantId, roundId, source: 'base' }, () => {});
};
socket.on('pat:issued', ({ participantId }) => {
  const p = participants.find(x => x.id === participantId);
  const line = document.createElement('div');
  line.className = 'muted';
  line.textContent = `Phone a Friend token issued to ${p ? p.name : participantId}`;
  $('submissionsList').prepend(line);
});
