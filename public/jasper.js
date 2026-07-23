const socket = io();
let currentRound = null;
let selectedQuestionId = null;
let selectedOption = null;
let myId = null;
const $ = (id) => document.getElementById(id);

const savedToken = localStorage.getItem('quiz_jasper_token');
const savedRoom = localStorage.getItem('quiz_jasper_room');

if (savedToken) {
  socket.on('connect', () => {
    socket.emit('join:reconnect', { token: savedToken }, (res) => {
      if (res.ok) { myId = res.participant.id; showGame(savedRoom); }
      else localStorage.removeItem('quiz_jasper_token');
    });
  });
}

$('joinBtn').onclick = () => {
  const roomCode = $('roomCode').value.trim();
  if (!roomCode) { $('joinError').textContent = 'Enter the room code.'; return; }
  socket.emit('join:jasper', { roomCode }, (res) => {
    if (!res.ok) { $('joinError').textContent = res.error; return; }
    myId = res.participant.id;
    localStorage.setItem('quiz_jasper_token', res.token);
    localStorage.setItem('quiz_jasper_room', roomCode);
    showGame(roomCode);
  });
};

function showGame(roomCode) {
  $('join-screen').style.display = 'none';
  $('game-screen').style.display = 'block';
  $('roomCodeDisplay').textContent = roomCode;
}

socket.on('round:state', (r) => {
  currentRound = r;
  if (!selectedQuestionId || !r.questions.some(q => q.id === selectedQuestionId)) {
    selectedQuestionId = r.questions.length ? r.questions[r.questions.length - 1].id : null;
  }
  renderRoundNav();
  renderSelectedQuestion();
});

function renderRoundNav() {
  const hasQuestions = currentRound && currentRound.questions.length > 0;
  $('noQuestionsYet').style.display = hasQuestions ? 'none' : 'block';
  $('roundCard').style.display = hasQuestions ? 'block' : 'none';
  if (!hasQuestions) { $('questionCard').style.display = 'none'; return; }

  $('roundTitle').textContent = currentRound.title;
  $('roundCompleteNote').style.display = currentRound.completed ? 'block' : 'none';

  const nav = $('questionNav');
  nav.innerHTML = '';
  currentRound.questions.forEach((q, i) => {
    const b = document.createElement('button');
    b.className = 'secondary';
    if (q.id === selectedQuestionId) b.style.background = 'var(--accent2)';
    b.textContent = `Q${i + 1}${q.myAnswer != null ? ' ✓' : ''}`;
    b.onclick = () => { selectedQuestionId = q.id; renderRoundNav(); renderSelectedQuestion(); };
    nav.appendChild(b);
  });
}

function renderSelectedQuestion() {
  const q = currentRound && currentRound.questions.find(x => x.id === selectedQuestionId);
  if (!q) { $('questionCard').style.display = 'none'; return; }
  $('questionCard').style.display = 'block';
  selectedOption = q.myAnswer != null ? q.myAnswer.value : null;

  $('statusBadge').textContent = q.status.toUpperCase();
  $('statusBadge').className = 'badge ' + (['open', 'hint1', 'hint2'].includes(q.status) ? 'open' : q.status === 'locked' ? 'locked' : q.status === 'revealed' ? 'revealed' : '');
  $('qBody').textContent = q.view.body;

  const optArea = $('optionsArea');
  optArea.innerHTML = '';
  const editable = !currentRound.completed && q.status !== 'revealed';

  if (q.view.options && q.view.options.length) {
    q.view.options.forEach(opt => {
      const b = document.createElement('button');
      b.className = 'option-btn' + (selectedOption === opt ? ' selected' : '');
      b.textContent = opt;
      b.disabled = !editable;
      b.onclick = () => { if (!editable) return; selectedOption = opt; [...optArea.children].forEach(c => c.classList.remove('selected')); b.classList.add('selected'); };
      optArea.appendChild(b);
    });
  } else if (q.view.inputType === 'numeric') {
    optArea.innerHTML = '<input type="number" id="numInput" placeholder="Your answer" inputmode="numeric">';
    if (q.myAnswer != null) $('numInput').value = q.myAnswer.value;
    $('numInput').disabled = !editable;
  } else {
    optArea.innerHTML = '<textarea id="textInput" rows="3" placeholder="Your answer"></textarea>';
    if (q.myAnswer != null) $('textInput').value = q.myAnswer.value;
    $('textInput').disabled = !editable;
  }

  const hintsArea = $('hintsArea');
  hintsArea.innerHTML = '';
  const stage = q.status === 'hint2' ? 2 : q.status === 'hint1' ? 1 : 0;
  (q.view.hints || []).slice(0, stage).forEach((h, i) => {
    const d = document.createElement('div'); d.className = 'hint'; d.textContent = `Hint ${i + 1}: ${h}`; hintsArea.appendChild(d);
  });

  const submitArea = $('submitArea');
  const submittedNote = $('submittedNote');
  const readOnlyNote = $('readOnlyNote');
  submittedNote.style.display = 'none';
  readOnlyNote.style.display = 'none';

  if (editable) {
    submitArea.style.display = 'block';
    $('submitBtn').textContent = q.myAnswer != null ? 'Update answer' : 'Submit answer';
  } else {
    submitArea.style.display = 'none';
    if (q.myAnswer != null) {
      submittedNote.textContent = currentRound.completed ? 'Answer locked in ✓' : 'Answer submitted ✓';
      submittedNote.style.display = 'block';
    } else {
      readOnlyNote.textContent = currentRound.completed ? 'Round complete — no answer was submitted.' : 'Answer revealed — no longer editable.';
      readOnlyNote.style.display = 'block';
    }
  }
}

$('submitBtn').onclick = () => {
  const q = currentRound && currentRound.questions.find(x => x.id === selectedQuestionId);
  if (!q) return;
  let value = selectedOption;
  if (q.view.inputType === 'numeric') value = $('numInput') ? $('numInput').value : null;
  if (q.view.inputType === 'free_text' || q.view.inputType === 'multi_part') value = $('textInput') ? $('textInput').value : null;
  if (value === null || value === undefined || value === '') { alert('Enter or select an answer first.'); return; }
  socket.emit('team:submitAnswer', { questionId: q.id, answer: { value } }, (res) => {
    if (!res.ok) { alert(res.error); return; }
    q.myAnswer = { value };
    renderRoundNav();
    renderSelectedQuestion();
  });
};

socket.on('score:updated', (st) => {
  const box = $('scoreboard'); box.innerHTML = '';
  st.teams.forEach(t => { const row = document.createElement('div'); row.className = 'scoreboard-row'; row.innerHTML = `<span>${t.name}</span><span>${t.total}</span>`; box.appendChild(row); });
  if (st.jasper) { const row = document.createElement('div'); row.className = 'scoreboard-row jasper-row'; row.innerHTML = `<span>Jasper (you)</span><span>${st.jasper.total}</span>`; box.appendChild(row); }
});

socket.on('session:pauseState', ({ paused }) => { if (paused) alert('The host has paused the quiz.'); });
