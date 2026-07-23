const socket = io();
let currentQuestion = null;
let selectedOption = null;
let myId = null;

const $ = (id) => document.getElementById(id);

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

socket.on('question:state', (q) => {
  currentQuestion = q;
  selectedOption = null;
  $('lockoutCard').style.display = 'none';
  $('questionCard').style.display = 'block';
  $('statusBadge').textContent = q.status.toUpperCase();
  $('statusBadge').className = 'badge ' + (q.status === 'open' || q.status.startsWith('hint') ? 'open' : q.status === 'locked' ? 'locked' : q.status === 'revealed' ? 'revealed' : '');
  $('qBody').textContent = q.view.body;

  const optArea = $('optionsArea');
  optArea.innerHTML = '';
  const submitArea = $('submitArea');
  const submittedNote = $('submittedNote');
  submittedNote.style.display = 'none';

  const isOpen = ['open', 'hint1', 'hint2'].includes(q.status);
  submitArea.style.display = isOpen ? 'block' : 'none';

  if (q.view.inputType === 'single_choice' || q.view.inputType === 'multiple_choice') {
    q.view.options.forEach(opt => {
      const b = document.createElement('button');
      b.className = 'option-btn';
      b.textContent = opt;
      b.onclick = () => {
        if (!isOpen) return;
        selectedOption = opt;
        [...optArea.children].forEach(c => c.classList.remove('selected'));
        b.classList.add('selected');
      };
      optArea.appendChild(b);
    });
  } else if (q.view.inputType === 'numeric') {
    optArea.innerHTML = '<input type="number" id="numInput" placeholder="Your answer" inputmode="numeric">';
  } else {
    optArea.innerHTML = '<textarea id="textInput" rows="3" placeholder="Your answer"></textarea>';
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
});

socket.on('question:lockout', () => {
  $('questionCard').style.display = 'none';
  $('lockoutCard').style.display = 'block';
});

socket.on('submission:ack', ({ locked }) => {
  if (locked) {
    $('submitArea').style.display = 'none';
    $('submittedNote').style.display = 'block';
  }
});

$('submitBtn').onclick = () => {
  if (!currentQuestion) return;
  let value = selectedOption;
  if (currentQuestion.view.inputType === 'numeric') value = $('numInput') ? $('numInput').value : null;
  if (currentQuestion.view.inputType === 'free_text' || currentQuestion.view.inputType === 'multi_part') value = $('textInput') ? $('textInput').value : null;
  if (value === null || value === undefined || value === '') { alert('Enter or select an answer first.'); return; }
  socket.emit('team:submitAnswer', { questionId: currentQuestion.id, answer: { value } }, (res) => {
    if (!res.ok) { alert(res.error); return; }
    $('submitArea').style.display = 'none';
    $('submittedNote').style.display = 'block';
  });
};

socket.on('pat:issued', ({ id, roundId }) => {
  $('patArea').innerHTML = `<button id="useTokenBtn_${id}">Use Phone a Friend token</button>`;
  document.getElementById(`useTokenBtn_${id}`).onclick = () => {
    socket.emit('team:usePatToken', { tokenId: id }, (res) => {
      if (res.ok) $('patArea').innerHTML = '<span class="muted">Token used.</span>';
    });
  };
});

socket.on('score:updated', (st) => {
  const box = $('scoreboard');
  box.innerHTML = '';
  st.teams.forEach(t => {
    const row = document.createElement('div');
    row.className = 'scoreboard-row' + (t.id === myId ? '' : '');
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
