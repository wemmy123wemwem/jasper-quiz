const socket = io();
const $ = (id) => document.getElementById(id);

document.getElementById('connectBtn').onclick = () => {
  const roomCode = $('roomCode').value.trim();
  if (!roomCode) return;
  socket.emit('join:projector', { roomCode }, (res) => {
    if (!res.ok) { alert(res.error); return; }
    localStorage.setItem('quiz_projector_room', roomCode);
    $('lobby').style.display = 'none';
    $('stage').style.display = 'block';
  });
};

// auto-reconnect to last room on refresh
const savedRoom = localStorage.getItem('quiz_projector_room');
if (savedRoom) {
  socket.on('connect', () => {
    socket.emit('join:projector', { roomCode: savedRoom }, (res) => {
      if (res.ok) { $('lobby').style.display = 'none'; $('stage').style.display = 'block'; }
    });
  });
}

let currentProjectedQuestionId = null;

socket.on('projector:state', (s) => {
  $('revealBox').style.display = 'none';
  $('submissionCount').textContent = '';
  if (s.mode === 'blank' || !s.question) {
    currentProjectedQuestionId = null;
    $('qTitle').textContent = '';
    $('qBody').textContent = "Waiting for the next question…";
    return;
  }
  const q = s.question;
  currentProjectedQuestionId = q.id;
  $('qTitle').textContent = q.public.title || '';
  $('qBody').textContent = q.public.body || '';
  if (q.status === 'revealed' && q.revealContent) {
    $('revealBox').style.display = 'block';
    $('revealBox').innerHTML = `<h2 style="color:var(--accent)">${q.revealContent.note || 'Revealed'}</h2>`;
  }
});

socket.on('submission:count', ({ questionId, count }) => {
  // Only reflect this on screen if it's for the question currently on display.
  if (questionId === currentProjectedQuestionId) {
    $('submissionCount').textContent = `${count} answer(s) submitted`;
  }
});

socket.on('score:updated', (st) => {
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
});
