// seed.js — creates a fresh session + rounds + questions from a content JSON file.
// Usage: node server/seed.js [path-to-content.json]
// Prints the room code and host secret you'll need on the night.

const fs = require('fs');
const path = require('path');
const { nanoid } = require('nanoid');
const db = require('./db');

const contentPath = process.argv[2] || path.join(__dirname, '..', 'content', 'session.example.json');
const content = JSON.parse(fs.readFileSync(contentPath, 'utf8'));

function randomCode(len = 5) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
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

console.log('--------------------------------------------------');
console.log('Session created.');
console.log('Room code (give to players):', roomCode);
console.log('Host secret (keep private, use to open /host):', hostSecret);
console.log('Host URL: /host?secret=' + hostSecret);
console.log('--------------------------------------------------');
