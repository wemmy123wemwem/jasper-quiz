const socket = io();
let currentRound = null;
let selectedQuestionId = null;
let selectedOption = null;
let myId = null;

const $ = (id) => document.getElementById(id);

// Work out how to actually render/read this question, based on what's really
// there — not just the inputType label, which content can get wrong (e.g. a
// "single_choice" question with no options for Jasper should behave as free text).
function inputModeFor(view) {
  if (view.options && view.options.length > 0) return 'choice';
  if (view.inputType === 'numeric') return 'numeric';
  return 'text';
}

// --- Reconnect on load if we have a stored token ---
const savedToken = localStorage.getItem('quiz_token');
const savedRoom = localStorage.getItem('quiz_room');
const savedName = localStorage.getItem('quiz_team_name');

if (savedToken) {
  socket.on('connect', () => {
    socket.emit('join:reconnect', { token: savedToken }, (res) => {
      if (res.ok) {
        myId = res.participant.id;
        showGame(savedRoom, res.participant.name);
      } else {
        localStorage.removeItem('quiz_token');
      }
    });
  });
}

$('joinBtn').onclick = () => {
  const roomCode = $('roomCode').value.trim();
  const teamName = $('teamName').value.trim();
  if (!roomCode || !teamName) { $('joinError').textContent = 'Enter a room code and team name.'; return; }
  socket.emit('join:team', { roomCode, teamName }, (res) => {
    if (!res.ok) { $('joinError').textContent = res.error; return; }
    myId = res.participant.id;
    localStorage.setItem('quiz_token', res.token);
    localStorage.setItem('quiz_room', roomCode);
    localStorage.setItem('quiz_team_name', res.participant.name);
    showGame(roomCode, res.participant.name);
  });
};

function showGame(roomCode, name) {
  $('join-screen').style.display = 'none';
  $('game-screen').style.display = 'block';
  $('teamNameDisplay').textContent = name;
  $('roomCodeDisplay').textContent = roomCode;
}

// --- Round state: the list of every question opened so far this round ---
socket.on('round:state', (r) => {
  currentRound = r;
  // Keep the current selection if it's still in the list; otherwise jump to the newest question.
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
  $('statusBadge').className = 'badge ' + (q.status === 'open' || q.status.startsWith('hint') ? 'open' : q.status === 'locked' ? 'locked' : q.status === 'revealed' ? 'revealed' : '');
  $('qBody').textContent = q.view.body;

  const optArea = $('optionsArea');
  optArea.innerHTML = '';

  // Editable any time up to reveal, as long as the round isn't complete yet.
  const editable = !currentRound.completed && q.status !== 'revealed';

  if (q.view.options && q.view.options.length) {
    q.view.options.forEach(opt => {
      const b = document.createElement('button');
      b.className = 'option-btn' + (selectedOption === opt ? ' selected' : '');
      b.textContent = opt;
      b.disabled = !editable;
      b.onclick = () => {
        if (!editable) return;
        selectedOption = opt;
        [...optArea.children].forEach(c => c.classList.remove('selected'));
        b.classList.add('selected');
      };
      optArea.appendChild(b);
    });
  } else if (inputModeFor(q.view) === 'numeric') {
    const min = q.view.min != null ? q.view.min : 1900;
    const max = q.view.max != null ? q.view.max : (new Date().getFullYear() + 1);
    optArea.innerHTML = `<input type="number" id="numInput" placeholder="Your answer" inputmode="numeric" min="${min}" max="${max}">`;
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
    const d = document.createElement('div');
    d.className = 'hint';
    d.textContent = `Hint ${i + 1}: ${h}`;
    hintsArea.appendChild(d);
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
  const mode = inputModeFor(q.view);
  let value = selectedOption;
  if (mode === 'numeric') value = $('numInput') ? $('numInput').value : null;
  if (mode === 'text') value = $('textInput') ? $('textInput').value : null;
  if (value === null || value === undefined || value === '') { alert('Enter or select an answer first.'); return; }
  if (mode === 'numeric') {
    const num = Number(value);
    const min = q.view.min != null ? q.view.min : 1900;
    const max = q.view.max != null ? q.view.max : (new Date().getFullYear() + 1);
    if (Number.isNaN(num)) { alert('Please enter a number.'); return; }
    if (num < min || num > max) { alert(`Please enter a value between ${min} and ${max}.`); return; }
  }
  socket.emit('team:submitAnswer', { questionId: q.id, answer: { value } }, (res) => {
    if (!res.ok) { alert(res.error); return; }
    q.myAnswer = { value };
    renderRoundNav();
    renderSelectedQuestion();
  });
};

socket.on('pat:issued', ({ id, roundId }) => {
  $('patArea').innerHTML = `<button id="useTokenBtn_${id}">Use Phone a Friend token</button>`;
  document.getElementById(`useTokenBtn_${id}`).onclick = () => {
    socket.emit('team:usePatToken', { tokenId: id }, (res) => {
      if (res.ok) $('patArea').innerHTML = '<span class="muted">Token used.</span>';
      else alert(res.error);
    });
  };
});

socket.on('score:updated', (st) => {
  const box = $('scoreboard');
  box.innerHTML = '';
  st.teams.forEach(t => {
    const row = document.createElement('div');
    row.className = 'scoreboard-row';
    row.innerHTML = `<span>${t.name}${t.id === myId ? ' (you)' : ''}</span><span>${t.total}</span>`;
    box.appendChild(row);
  });
  if (st.jasper) {
    const row = document.createElement('div');
    row.className = 'scoreboard-row jasper-row';
    row.innerHTML = `<span>Jasper</span><span>${st.jasper.total}</span>`;
    box.appendChild(row);
  }
});

socket.on('session:pauseState', ({ paused }) => {
  if (paused) alert('The host has paused the quiz.');
});
