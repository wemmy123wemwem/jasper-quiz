const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { nanoid } = require('nanoid');
const db = require('./db');
const scoring = require('./scoring');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'host.html')));
app.get('/team', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'team.html')));
app.get('/jasper', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'jasper.html')));
app.get('/projector', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'projector.html')));

// ---------- DB helpers ----------
const getSessionByRoomCode = (code) => db.prepare('SELECT * FROM sessions WHERE room_code = ?').get(code.toUpperCase());
const getSessionByHostSecret = (secret) => db.prepare('SELECT * FROM sessions WHERE host_secret = ?').get(secret);
const getSessionById = (id) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
const getParticipantByToken = (token) => db.prepare('SELECT * FROM participants WHERE session_token = ?').get(token);
const getParticipant = (id) => db.prepare('SELECT * FROM participants WHERE id = ?').get(id);
const getRounds = (sessionId) => db.prepare('SELECT * FROM rounds WHERE session_id = ? ORDER BY sequence').all(sessionId);
const getQuestionsForRound = (roundId) => db.prepare('SELECT * FROM questions WHERE round_id = ? ORDER BY sequence').all(roundId);
const getQuestion = (id) => db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
const getExcludedIds = (q) => JSON.parse(q.excluded_participant_ids || '[]');

function isExcluded(question, participantId) {
  return getExcludedIds(question).includes(participantId);
}

// Build the payload sent to a given role for a question. This is the ONLY
// place role-specific content is assembled — never send the raw question
// row to a team/jasper/projector client.
function questionPayloadFor(question, role) {
  const base = {
    id: question.id,
    status: question.status,
    public: JSON.parse(question.public_display)
  };
  if (role === 'host') {
    return { ...base, teamView: JSON.parse(question.team_view), jasperView: JSON.parse(question.jasper_view),
      answerKey: JSON.parse(question.answer_key), scoring: JSON.parse(question.scoring),
      revealContent: JSON.parse(question.reveal_content), hostNotes: question.host_notes,
      excludedParticipantIds: getExcludedIds(question) };
  }
  if (role === 'team') return { ...base, view: JSON.parse(question.team_view) };
  if (role === 'jasper') return { ...base, view: JSON.parse(question.jasper_view) };
  // projector — public only, plus reveal content if revealed
  const payload = { ...base };
  if (question.status === 'revealed') payload.revealContent = JSON.parse(question.reveal_content);
  return payload;
}

function hintStageOf(question) {
  if (question.status === 'hint2') return 2;
  if (question.status === 'hint1') return 1;
  return 0;
}

function roomHost(sid) { return `s:${sid}:host`; }
function roomProjector(sid) { return `s:${sid}:projector`; }
function roomJasper(sid) { return `s:${sid}:jasper`; }
function roomTeam(sid, pid) { return `s:${sid}:team:${pid}`; }
function roomAllPlayers(sid) { return `s:${sid}:players`; } // teams + jasper, for lobby-wide notices

function broadcastStandings(sessionId) {
  const st = scoring.standings(sessionId);
  io.to(roomHost(sessionId)).to(roomProjector(sessionId)).to(roomAllPlayers(sessionId)).emit('score:updated', st);
}

function broadcastQuestionState(question) {
  const sessionId = question.session_id;
  io.to(roomHost(sessionId)).emit('question:state', questionPayloadFor(question, 'host'));
  io.to(roomProjector(sessionId)).emit('question:state', questionPayloadFor(question, 'projector'));
  // teams: everyone except excluded, plus jasper separately
  const teams = db.prepare("SELECT * FROM participants WHERE session_id = ? AND type = 'team'").all(sessionId);
  teams.forEach(t => {
    if (isExcluded(question, t.id)) {
      io.to(roomTeam(sessionId, t.id)).emit('question:lockout', { questionId: question.id });
    } else {
      io.to(roomTeam(sessionId, t.id)).emit('question:state', questionPayloadFor(question, 'team'));
    }
  });
  const jasperP = db.prepare("SELECT * FROM participants WHERE session_id = ? AND type = 'jasper'").get(sessionId);
  if (jasperP) {
    if (isExcluded(question, jasperP.id)) {
      io.to(roomJasper(sessionId)).emit('question:lockout', { questionId: question.id });
    } else {
      io.to(roomJasper(sessionId)).emit('question:state', questionPayloadFor(question, 'jasper'));
    }
  }
}

// ---------- Socket handlers ----------
io.on('connection', (socket) => {

  // --- Host auth ---
  socket.on('host:auth', ({ hostSecret }, ack) => {
    const session = getSessionByHostSecret(hostSecret);
    if (!session) return ack({ ok: false, error: 'Invalid host secret' });
    socket.data.sessionId = session.id;
    socket.data.role = 'host';
    socket.join(roomHost(session.id));
    const rounds = getRounds(session.id).map(r => ({ ...r, questions: getQuestionsForRound(r.id).map(q => questionPayloadFor(q, 'host')) }));
    const participants = db.prepare('SELECT id, type, name, connected FROM participants WHERE session_id = ?').all(session.id);
    ack({ ok: true, session, rounds, participants, standings: scoring.standings(session.id) });
  });

  // --- Join as team ---
  socket.on('join:team', ({ roomCode, teamName }, ack) => {
    const session = getSessionByRoomCode(roomCode || '');
    if (!session) return ack({ ok: false, error: 'Room not found' });
    const existing = db.prepare("SELECT * FROM participants WHERE session_id = ? AND type = 'team' AND name = ?").get(session.id, teamName.trim());
    if (existing) return ack({ ok: false, error: 'Team name already taken this session' });
    const token = nanoid(24);
    const id = nanoid();
    db.prepare(`INSERT INTO participants (id, session_id, type, name, session_token, connected, joined_at)
                VALUES (?, ?, 'team', ?, ?, 1, ?)`).run(id, session.id, teamName.trim(), token, Date.now());
    joinCommon(socket, session.id, id, 'team', token);
    io.to(roomHost(session.id)).emit('participant:joined', { id, type: 'team', name: teamName.trim() });
    ack({ ok: true, token, participant: { id, name: teamName.trim(), type: 'team' } });
  });

  // --- Join as Jasper (one per session) ---
  socket.on('join:jasper', ({ roomCode }, ack) => {
    const session = getSessionByRoomCode(roomCode || '');
    if (!session) return ack({ ok: false, error: 'Room not found' });
    const existing = db.prepare("SELECT * FROM participants WHERE session_id = ? AND type = 'jasper'").get(session.id);
    if (existing) return ack({ ok: false, error: 'Jasper role already claimed for this session' });
    const token = nanoid(24);
    const id = nanoid();
    db.prepare(`INSERT INTO participants (id, session_id, type, name, session_token, connected, joined_at)
                VALUES (?, ?, 'jasper', 'Jasper', ?, 1, ?)`).run(id, session.id, token, Date.now());
    joinCommon(socket, session.id, id, 'jasper', token);
    io.to(roomHost(session.id)).emit('participant:joined', { id, type: 'jasper', name: 'Jasper' });
    ack({ ok: true, token, participant: { id, name: 'Jasper', type: 'jasper' } });
  });

  // --- Reconnect via stored token (team or jasper) ---
  socket.on('join:reconnect', ({ token }, ack) => {
    const p = getParticipantByToken(token);
    if (!p) return ack({ ok: false, error: 'Session expired' });
    joinCommon(socket, p.session_id, p.id, p.type, token);
    ack({ ok: true, participant: { id: p.id, name: p.name, type: p.type } });
    // Re-send current question state so their screen catches up.
    const session = getSessionById(p.session_id);
    if (session.current_question_id) {
      const q = getQuestion(session.current_question_id);
      const role = p.type;
      if (isExcluded(q, p.id)) socket.emit('question:lockout', { questionId: q.id });
      else socket.emit('question:state', questionPayloadFor(q, role));
      // let them know if they already submitted
      const sub = db.prepare('SELECT * FROM submissions WHERE question_id = ? AND participant_id = ?').get(q.id, p.id);
      if (sub) socket.emit('submission:ack', { questionId: q.id, locked: !!sub.locked_at });
    }
  });

  // --- Projector (no auth needed, read-only) ---
  socket.on('join:projector', ({ roomCode }, ack) => {
    const session = getSessionByRoomCode(roomCode || '');
    if (!session) return ack({ ok: false, error: 'Room not found' });
    socket.data.sessionId = session.id;
    socket.data.role = 'projector';
    socket.join(roomProjector(session.id));
    ack({ ok: true, session: { roomCode: session.room_code, status: session.status } });
    if (session.current_question_id) {
      const q = getQuestion(session.current_question_id);
      socket.emit('question:state', questionPayloadFor(q, 'projector'));
    }
    socket.emit('score:updated', scoring.standings(session.id));
  });

  function joinCommon(sock, sessionId, participantId, type, token) {
    sock.data.sessionId = sessionId;
    sock.data.participantId = participantId;
    sock.data.role = type;
    sock.join(roomAllPlayers(sessionId));
    sock.join(type === 'team' ? roomTeam(sessionId, participantId) : roomJasper(sessionId));
    db.prepare('UPDATE participants SET connected = 1 WHERE id = ?').run(participantId);
  }

  socket.on('disconnect', () => {
    if (socket.data.participantId) {
      db.prepare('UPDATE participants SET connected = 0 WHERE id = ?').run(socket.data.participantId);
      if (socket.data.sessionId) {
        io.to(roomHost(socket.data.sessionId)).emit('participant:disconnected', { id: socket.data.participantId });
      }
    }
  });

  // ---------- Host actions (all require role === 'host') ----------
  function requireHost(sock) { return sock.data.role === 'host' && sock.data.sessionId; }

  socket.on('host:openQuestion', ({ questionId }, ack) => {
    if (!requireHost(socket)) return ack && ack({ ok: false, error: 'Not authorised' });
    const q = getQuestion(questionId);
    if (!q) return ack && ack({ ok: false, error: 'Question not found' });
    db.prepare("UPDATE questions SET status = 'open', opened_at = ? WHERE id = ?").run(Date.now(), q.id);
    db.prepare('UPDATE sessions SET current_question_id = ?, status = ? WHERE id = ?')
      .run(q.id, 'live', q.session_id);
    broadcastQuestionState(getQuestion(q.id));
    ack && ack({ ok: true });
  });

  socket.on('host:releaseHint', ({ questionId, stage }, ack) => {
    if (!requireHost(socket)) return ack && ack({ ok: false, error: 'Not authorised' });
    const q = getQuestion(questionId);
    if (!q) return ack && ack({ ok: false, error: 'Question not found' });
    const status = stage === 2 ? 'hint2' : 'hint1';
    db.prepare('UPDATE questions SET status = ? WHERE id = ?').run(status, q.id);
    try {
      db.prepare('INSERT INTO hint_releases (id, question_id, stage, released_at) VALUES (?, ?, ?, ?)')
        .run(nanoid(), q.id, stage, Date.now());
    } catch (e) { /* already released, ignore unique constraint */ }
    broadcastQuestionState(getQuestion(q.id));
    ack && ack({ ok: true });
  });

  socket.on('host:lockQuestion', ({ questionId }, ack) => {
    if (!requireHost(socket)) return ack && ack({ ok: false, error: 'Not authorised' });
    const q = getQuestion(questionId);
    db.prepare("UPDATE questions SET status = 'locked', locked_at = ? WHERE id = ?").run(Date.now(), q.id);
    // Auto-mark any eligible submissions now that answers are locked.
    const subs = db.prepare('SELECT * FROM submissions WHERE question_id = ?').all(q.id);
    const updated = getQuestion(q.id);
    subs.forEach(sub => {
      const participant = getParticipant(sub.participant_id);
      const answer = JSON.parse(sub.answer);
      const result = scoring.autoMark({ participantType: participant.type, answer, question: updated });
      if (result.status !== 'pending') {
        db.prepare('UPDATE submissions SET marked_status = ?, awarded_points = ? WHERE id = ?')
          .run(result.status, result.points, sub.id);
        scoring.awardPoints({ sessionId: updated.session_id, participantId: participant.id, questionId: q.id, amount: result.points, reason: result.reason });
      }
    });
    broadcastQuestionState(getQuestion(q.id));
    broadcastStandings(updated.session_id);
    ack && ack({ ok: true });
  });

  socket.on('host:revealQuestion', ({ questionId }, ack) => {
    if (!requireHost(socket)) return ack && ack({ ok: false, error: 'Not authorised' });
    const q = getQuestion(questionId);
    db.prepare("UPDATE questions SET status = 'revealed', revealed_at = ? WHERE id = ?").run(Date.now(), q.id);
    broadcastQuestionState(getQuestion(q.id));
    ack && ack({ ok: true });
  });

  // Manual marking / override — also used for question types autoMark can't score
  // (matching, ordering, image_id, multi_part) and for correcting an auto-mark.
  socket.on('host:markSubmission', ({ submissionId, status, points, reason }, ack) => {
    if (!requireHost(socket)) return ack && ack({ ok: false, error: 'Not authorised' });
    const sub = db.prepare('SELECT * FROM submissions WHERE id = ?').get(submissionId);
    if (!sub) return ack && ack({ ok: false, error: 'Submission not found' });
    db.prepare('UPDATE submissions SET marked_status = ?, awarded_points = ? WHERE id = ?').run(status, points, submissionId);
    const q = getQuestion(sub.question_id);
    const entry = scoring.awardPoints({ sessionId: q.session_id, participantId: sub.participant_id, questionId: q.id, amount: points, reason: reason || `Manual mark: ${status}` });
    broadcastStandings(q.session_id);
    io.to(roomHost(q.session_id)).emit('submission:marked', { submissionId, status, points, ledgerId: entry.id });
    ack && ack({ ok: true, ledgerId: entry.id });
  });

  socket.on('host:adjustScore', ({ participantId, amount, reason }, ack) => {
    if (!requireHost(socket)) return ack && ack({ ok: false, error: 'Not authorised' });
    const entry = scoring.awardPoints({ sessionId: socket.data.sessionId, participantId, questionId: null, amount, reason: reason || 'Manual host adjustment' });
    broadcastStandings(socket.data.sessionId);
    ack && ack({ ok: true, ledgerId: entry.id });
  });

  socket.on('host:undoLedger', ({ ledgerId }, ack) => {
    if (!requireHost(socket)) return ack && ack({ ok: false, error: 'Not authorised' });
    const entry = scoring.undoLedgerEntry(ledgerId);
    broadcastStandings(socket.data.sessionId);
    ack && ack({ ok: true, entry });
  });

  socket.on('host:excludeParticipant', ({ questionId, participantId, excluded }, ack) => {
    if (!requireHost(socket)) return ack && ack({ ok: false, error: 'Not authorised' });
    const q = getQuestion(questionId);
    const ids = new Set(getExcludedIds(q));
    if (excluded) ids.add(participantId); else ids.delete(participantId);
    db.prepare('UPDATE questions SET excluded_participant_ids = ? WHERE id = ?').run(JSON.stringify([...ids]), questionId);
    broadcastQuestionState(getQuestion(questionId));
    ack && ack({ ok: true });
  });

  socket.on('host:pauseResume', ({ pause }, ack) => {
    if (!requireHost(socket)) return ack && ack({ ok: false, error: 'Not authorised' });
    db.prepare('UPDATE sessions SET status = ? WHERE id = ?').run(pause ? 'paused' : 'live', socket.data.sessionId);
    io.to(roomAllPlayers(socket.data.sessionId)).to(roomProjector(socket.data.sessionId)).emit('session:pauseState', { paused: pause });
    ack && ack({ ok: true });
  });

  // Phone a Friend token issuance (host controls, per brief's configurable rule)
  socket.on('host:issuePatToken', ({ participantId, roundId, source }, ack) => {
    if (!requireHost(socket)) return ack && ack({ ok: false, error: 'Not authorised' });
    const id = nanoid();
    db.prepare('INSERT INTO pat_tokens (id, session_id, round_id, participant_id, used, source) VALUES (?, ?, ?, ?, 0, ?)')
      .run(id, socket.data.sessionId, roundId, participantId, source || 'base');
    io.to(roomTeam(socket.data.sessionId, participantId)).emit('pat:issued', { id, roundId });
    io.to(roomHost(socket.data.sessionId)).emit('pat:issued', { id, roundId, participantId });
    ack && ack({ ok: true, tokenId: id });
  });

  // ---------- Team / Jasper actions ----------
  socket.on('team:submitAnswer', ({ questionId, answer }, ack) => {
    if (!socket.data.participantId) return ack && ack({ ok: false, error: 'Not joined' });
    const q = getQuestion(questionId);
    if (!q || !['open', 'hint1', 'hint2'].includes(q.status)) return ack && ack({ ok: false, error: 'Question not open' });
    if (isExcluded(q, socket.data.participantId)) return ack && ack({ ok: false, error: 'You are excluded from this question' });
    const existing = db.prepare('SELECT * FROM submissions WHERE question_id = ? AND participant_id = ?').get(questionId, socket.data.participantId);
    if (existing && existing.locked_at) return ack && ack({ ok: false, error: 'Answer already locked' });
    const stage = hintStageOf(q);
    if (existing) {
      db.prepare('UPDATE submissions SET answer = ?, hint_stage_at_submit = ?, submitted_at = ? WHERE id = ?')
        .run(JSON.stringify(answer), stage, Date.now(), existing.id);
    } else {
      db.prepare(`INSERT INTO submissions (id, question_id, participant_id, answer, hint_stage_at_submit, submitted_at)
                  VALUES (?, ?, ?, ?, ?, ?)`).run(nanoid(), questionId, socket.data.participantId, JSON.stringify(answer), stage, Date.now());
    }
    io.to(roomHost(q.session_id)).emit('submission:received', { questionId, participantId: socket.data.participantId });
    // Projector only ever sees a count, never the content.
    const count = db.prepare('SELECT COUNT(*) as c FROM submissions WHERE question_id = ?').get(questionId).c;
    io.to(roomProjector(q.session_id)).emit('submission:count', { questionId, count });
    ack && ack({ ok: true });
  });

  socket.on('team:usePatToken', ({ tokenId }, ack) => {
    const tok = db.prepare('SELECT * FROM pat_tokens WHERE id = ? AND participant_id = ?').get(tokenId, socket.data.participantId);
    if (!tok || tok.used) return ack && ack({ ok: false, error: 'Token not available' });
    db.prepare('UPDATE pat_tokens SET used = 1, used_at = ? WHERE id = ?').run(Date.now(), tokenId);
    io.to(roomHost(socket.data.sessionId)).emit('pat:used', { tokenId, participantId: socket.data.participantId });
    ack && ack({ ok: true });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Jasper quiz server listening on :${PORT}`));
