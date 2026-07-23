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

// ---------- Setup page (creates a fresh game session — visit this once before the event) ----------
app.get('/setup-jasper-quiz-2026', (req, res) => {
  try {
    const fs = require('fs');
    const contentPath = fs.existsSync(path.join(__dirname, '..', 'content', 'session.json'))
      ? path.join(__dirname, '..', 'content', 'session.json')
      : path.join(__dirname, '..', 'content', 'session.example.json');
    const content = JSON.parse(fs.readFileSync(contentPath, 'utf8'));

    function randomCode(len = 5) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    }

    const sessionId = nanoid();
    const roomCode = randomCode();
    const hostSecret = nanoid(12);

    db.prepare(`INSERT INTO sessions (id, room_code, host_secret, status, created_at) VALUES (?, ?, ?, 'lobby', ?)`)
      .run(sessionId, roomCode, hostSecret, Date.now());

    content.rounds.forEach((round, ri) => {
      const roundId = nanoid();
      db.prepare(`INSERT INTO rounds (id, session_id, sequence, title) VALUES (?, ?, ?, ?)`)
        .run(roundId, sessionId, ri, round.title);

      round.questions.forEach((q, qi) => {
        const questionId = nanoid();
        db.prepare(`INSERT INTO questions
          (id, round_id, session_id, sequence, status, public_display, team_view, jasper_view,
           excluded_participant_ids, answer_key, accepted_answers, marking_notes, scoring, assets, reveal_content, host_notes)
          VALUES (@id, @round_id, @session_id, @sequence, 'draft', @public_display, @team_view, @jasper_view,
           @excluded_participant_ids, @answer_key, @accepted_answers, '', @scoring, @assets, @reveal_content, '')`)
          .run({
            id: questionId,
            round_id: roundId,
            session_id: sessionId,
            sequence: qi,
            public_display: JSON.stringify(q.public_display),
            team_view: JSON.stringify(q.team_view),
            jasper_view: JSON.stringify(q.jasper_view),
            excluded_participant_ids: JSON.stringify(q.excluded_participant_ids || []),
            answer_key: JSON.stringify(q.answer_key),
            accepted_answers: JSON.stringify(q.accepted_answers || []),
            scoring: JSON.stringify(q.scoring),
            assets: JSON.stringify(q.assets || []),
            reveal_content: JSON.stringify(q.reveal_content || {})
          });
      });
    });

    res.send(`
      <html><body style="font-family: sans-serif; padding: 40px; font-size: 18px; max-width: 600px;">
        <h1>Session created!</h1>
        <p><b>Room code (give to players):</b> ${roomCode}</p>
        <p><b>Host link (bookmark this, keep private):</b><br>
          <a href="/host?secret=${hostSecret}">/host?secret=${hostSecret}</a>
        </p>
        <p><b>Team link:</b> <a href="/team">/team</a></p>
        <p><b>Jasper link:</b> <a href="/jasper">/jasper</a></p>
        <p><b>Projector link:</b> <a href="/projector">/projector</a></p>
        <p style="color:#888; margin-top:30px;">Note: visiting this page again creates a brand new session with a new room code.</p>
      </body></html>
    `);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// ---------- DB helpers ----------
const getSessionByRoomCode = (code) => db.prepare('SELECT * FROM sessions WHERE room_code = ?').get(code.toUpperCase());
const getSessionByHostSecret = (secret) => db.prepare('SELECT * FROM sessions WHERE host_secret = ?').get(secret);
const getSessionById = (id) => db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
const getParticipantByToken = (token) => db.prepare('SELECT * FROM participants WHERE session_token = ?').get(token);
const getParticipant = (id) => db.prepare('SELECT * FROM participants WHERE id = ?').get(id);
const getRounds = (sessionId) => db.prepare('SELECT * FROM rounds WHERE session_id = ? ORDER BY sequence').all(sessionId);
const getRoundById = (id) => db.prepare('SELECT * FROM rounds WHERE id = ?').get(id);
const getQuestionsForRound = (roundId) => db.prepare('SELECT * FROM questions WHERE round_id = ? ORDER BY sequence').all(roundId);
const getQuestion = (id) => db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
const getExcludedIds = (q) => JSON.parse(q.excluded_participant_ids || '[]');

function isExcluded(question, participantId) {
  return getExcludedIds(question).includes(participantId);
}

// Build the payload sent to a given role for a question. This is the ONLY
// place role-specific content is assembled — never send the raw question
// row to a team/jasper/projector client.
function questionPayloadFor(question, role, participantId) {
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
  if (role === 'team' || role === 'jasper') {
    const view = role === 'team' ? JSON.parse(question.team_view) : JSON.parse(question.jasper_view);
    let hasSubmitted = false;
    if (participantId) {
      const sub = db.prepare('SELECT * FROM submissions WHERE question_id = ? AND participant_id = ?').get(question.id, participantId);
      hasSubmitted = !!sub;
    }
    return { ...base, view, hasSubmitted };
  }
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

// Build the round payload for one participant: every non-draft (i.e. ever-opened)
// question in the round they're not excluded from, each with their own answer
// echoed back so the team app can pre-fill it for editing.
function roundStateFor(roundId, role, participantId) {
  const round = getRoundById(roundId);
  const questions = getQuestionsForRound(roundId)
    .filter(q => q.status !== 'draft')
    .filter(q => !isExcluded(q, participantId))
    .map(q => {
      const payload = questionPayloadFor(q, role, participantId);
      const sub = db.prepare('SELECT answer FROM submissions WHERE question_id = ? AND participant_id = ?').get(q.id, participantId);
      payload.myAnswer = sub ? JSON.parse(sub.answer) : null;
      return payload;
    });
  return { roundId, title: round.title, completed: !!round.completed, questions };
}

// After any change to a question (opened, hint released, locked, revealed,
// exclusion toggled): tell the host its detail view, and push every team/Jasper
// in that round their updated round-wide question list. The projector is
// deliberately NOT touched here — it's controlled independently by the host.
function afterQuestionChange(question) {
  io.to(roomHost(question.session_id)).emit('question:state', questionPayloadFor(question, 'host'));
  const teams = db.prepare("SELECT * FROM participants WHERE session_id = ? AND type = 'team'").all(question.session_id);
  teams.forEach(t => {
    io.to(roomTeam(question.session_id, t.id)).emit('round:state', roundStateFor(question.round_id, 'team', t.id));
  });
  const jasperP = db.prepare("SELECT * FROM participants WHERE session_id = ? AND type = 'jasper'").get(question.session_id);
  if (jasperP) {
    io.to(roomJasper(question.session_id)).emit('round:state', roundStateFor(question.round_id, 'jasper', jasperP.id));
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
    sendRoundStateTo(socket, session.id, id, 'team');
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
    sendRoundStateTo(socket, session.id, id, 'jasper');
  });

  // --- Reconnect via stored token (team or jasper) ---
  socket.on('join:reconnect', ({ token }, ack) => {
    const p = getParticipantByToken(token);
    if (!p) return ack({ ok: false, error: 'Session expired' });
    joinCommon(socket, p.session_id, p.id, p.type, token);
    ack({ ok: true, participant: { id: p.id, name: p.name, type: p.type } });
    sendRoundStateTo(socket, p.session_id, p.id, p.type);
  });

  // Send the current round's question list (if any question has ever been
  // opened) to a participant who just joined/reconnected, so late joiners
  // land straight on the right question(s) instead of a blank screen.
  function sendRoundStateTo(sock, sessionId, participantId, role) {
    const session = getSessionById(sessionId);
    if (!session.current_question_id) return;
    const q = getQuestion(session.current_question_id);
    sock.emit('round:state', roundStateFor(q.round_id, role, participantId));
  }

  // --- Projector (no auth needed, read-only) ---
  socket.on('join:projector', ({ roomCode }, ack) => {
    const session = getSessionByRoomCode(roomCode || '');
    if (!session) return ack({ ok: false, error: 'Room not found' });
    socket.data.sessionId = session.id;
    socket.data.role = 'projector';
    socket.join(roomProjector(session.id));
    ack({ ok: true, session: { roomCode: session.room_code, status: session.status } });
    if (session.projector_mode === 'question' && session.projector_question_id) {
      const q = getQuestion(session.projector_question_id);
      socket.emit('projector:state', { mode: 'question', question: questionPayloadFor(q, 'projector') });
    } else {
      socket.emit('projector:state', { mode: 'blank' });
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
    const session = getSessionById(q.session_id);
    // Already the live question — just refresh the host's own view, don't reset
    // it or re-broadcast to teams (that would wipe their submitted-answer screen).
    if (session.current_question_id === q.id) {
      socket.emit('question:state', questionPayloadFor(q, 'host'));
      return ack && ack({ ok: true });
    }
    db.prepare("UPDATE questions SET status = 'open', opened_at = ? WHERE id = ?").run(Date.now(), q.id);
    db.prepare('UPDATE sessions SET current_question_id = ?, status = ? WHERE id = ?')
      .run(q.id, 'live', q.session_id);
    afterQuestionChange(getQuestion(q.id));
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
    afterQuestionChange(getQuestion(q.id));
    ack && ack({ ok: true });
  });

  // "Lock" is now just a pacing marker the host can use during play (e.g. to
  // signal "no more hints coming"). It does NOT freeze editing or trigger
  // scoring any more — teams can still revise their answer for this question
  // right up until the whole round is completed. All auto-marking happens
  // once, at host:completeRound, so nothing gets scored twice.
  socket.on('host:lockQuestion', ({ questionId }, ack) => {
    if (!requireHost(socket)) return ack && ack({ ok: false, error: 'Not authorised' });
    const q = getQuestion(questionId);
    if (!q) return ack && ack({ ok: false, error: 'Question not found' });
    db.prepare("UPDATE questions SET status = 'locked', locked_at = ? WHERE id = ?").run(Date.now(), q.id);
    afterQuestionChange(getQuestion(q.id));
    ack && ack({ ok: true });
  });

  // Reveal the answer for this question. Once revealed, teams can no longer
  // edit their submission for it (they've seen the answer) — but the round
  // as a whole isn't scored yet; that still happens at host:completeRound.
  socket.on('host:revealQuestion', ({ questionId }, ack) => {
    if (!requireHost(socket)) return ack && ack({ ok: false, error: 'Not authorised' });
    const q = getQuestion(questionId);
    if (!q) return ack && ack({ ok: false, error: 'Question not found' });
    db.prepare("UPDATE questions SET status = 'revealed', revealed_at = ? WHERE id = ?").run(Date.now(), q.id);
    afterQuestionChange(getQuestion(q.id));
    ack && ack({ ok: true });
  });

  // Complete a round: freezes every question in it (auto-marks any pending,
  // auto-markable submissions exactly once), and blocks any further answer
  // edits or Phone-a-Friend token use for that round from this point on.
  socket.on('host:completeRound', ({ roundId }, ack) => {
    if (!requireHost(socket)) return ack && ack({ ok: false, error: 'Not authorised' });
    const round = getRoundById(roundId);
    if (!round) return ack && ack({ ok: false, error: 'Round not found' });
    if (round.completed) return ack && ack({ ok: true }); // already done, no-op
    const questions = getQuestionsForRound(roundId);
    questions.forEach(q => {
      if (q.status !== 'revealed') {
        db.prepare("UPDATE questions SET status = 'locked', locked_at = COALESCE(locked_at, ?) WHERE id = ?").run(Date.now(), q.id);
      }
      // Auto-mark only submissions still pending — keeps this safe to call once.
      const subs = db.prepare("SELECT * FROM submissions WHERE question_id = ? AND marked_status = 'pending'").all(q.id);
      const updatedQ = getQuestion(q.id);
      subs.forEach(sub => {
        const participant = getParticipant(sub.participant_id);
        const answer = JSON.parse(sub.answer);
        const result = scoring.autoMark({ participantType: participant.type, answer, question: updatedQ });
        if (result.status !== 'pending') {
          db.prepare('UPDATE submissions SET marked_status = ?, awarded_points = ? WHERE id = ?')
            .run(result.status, result.points, sub.id);
          scoring.awardPoints({ sessionId: updatedQ.session_id, participantId: participant.id, questionId: q.id, amount: result.points, reason: result.reason });
        }
      });
    });
    db.prepare('UPDATE rounds SET completed = 1, completed_at = ? WHERE id = ?').run(Date.now(), roundId);
    // Refresh every question's broadcast so host + teams see final locked state.
    getQuestionsForRound(roundId).forEach(q => afterQuestionChange(q));
    broadcastStandings(round.session_id);
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
    afterQuestionChange(getQuestion(questionId));
    ack && ack({ ok: true });
  });

  // Projector control — fully independent of what's live for teams. The host
  // can point the shared screen at any question (any status, including ones
  // from earlier in the night) or blank it, without affecting what teams see
  // or can currently answer.
  socket.on('host:setProjector', ({ mode, questionId }, ack) => {
    if (!requireHost(socket)) return ack && ack({ ok: false, error: 'Not authorised' });
    const sessionId = socket.data.sessionId;
    if (mode === 'blank') {
      db.prepare('UPDATE sessions SET projector_mode = ?, projector_question_id = NULL WHERE id = ?').run('blank', sessionId);
      io.to(roomProjector(sessionId)).emit('projector:state', { mode: 'blank' });
      return ack && ack({ ok: true });
    }
    const q = getQuestion(questionId);
    if (!q) return ack && ack({ ok: false, error: 'Question not found' });
    db.prepare('UPDATE sessions SET projector_mode = ?, projector_question_id = ? WHERE id = ?').run('question', q.id, sessionId);
    io.to(roomProjector(sessionId)).emit('projector:state', { mode: 'question', question: questionPayloadFor(q, 'projector') });
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
    if (!q || q.status === 'draft') return ack && ack({ ok: false, error: 'Question not open yet' });
    if (q.status === 'revealed') return ack && ack({ ok: false, error: 'Answer revealed — no further changes' });
    const round = getRoundById(q.round_id);
    if (round.completed) return ack && ack({ ok: false, error: 'This round is complete — no further changes' });
    if (isExcluded(q, socket.data.participantId)) return ack && ack({ ok: false, error: 'You are excluded from this question' });
    const existing = db.prepare('SELECT * FROM submissions WHERE question_id = ? AND participant_id = ?').get(questionId, socket.data.participantId);
    const stage = hintStageOf(q);
    if (existing) {
      // If this submission was already scored (e.g. host marked it, or an
      // earlier round-completion auto-marked it), reverse that score first —
      // the edit means it needs marking again from scratch.
      if (existing.marked_status !== 'pending' && existing.awarded_points != null) {
        scoring.awardPoints({
          sessionId: q.session_id, participantId: socket.data.participantId, questionId: q.id,
          amount: -existing.awarded_points, reason: 'Answer edited — previous score reversed'
        });
        broadcastStandings(q.session_id);
      }
      db.prepare('UPDATE submissions SET answer = ?, hint_stage_at_submit = ?, submitted_at = ?, marked_status = ?, awarded_points = NULL WHERE id = ?')
        .run(JSON.stringify(answer), stage, Date.now(), 'pending', existing.id);
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
    const round = getRoundById(tok.round_id);
    if (round && round.completed) return ack && ack({ ok: false, error: 'This round is complete' });
    db.prepare('UPDATE pat_tokens SET used = 1, used_at = ? WHERE id = ?').run(Date.now(), tokenId);
    io.to(roomHost(socket.data.sessionId)).emit('pat:used', { tokenId, participantId: socket.data.participantId });
    ack && ack({ ok: true });
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Jasper quiz server listening on :${PORT}`));
