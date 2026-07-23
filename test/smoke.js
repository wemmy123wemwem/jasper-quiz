const { io } = require('socket.io-client');
const db = require('../server/db');

const ROOM = process.argv[2];
const HOST_SECRET = process.argv[3];
const URL = 'http://localhost:3000';

function connect() { return io(URL, { transports: ['websocket'] }); }

async function main() {
  const host = connect();
  const team1 = connect();
  const team2 = connect();
  const jasper = connect();
  const projector = connect();

  await new Promise(r => host.on('connect', r));
  await new Promise(r => team1.on('connect', r));
  await new Promise(r => team2.on('connect', r));
  await new Promise(r => jasper.on('connect', r));
  await new Promise(r => projector.on('connect', r));

  const hostAuth = await new Promise(r => host.emit('host:auth', { hostSecret: HOST_SECRET }, r));
  console.log('HOST AUTH:', hostAuth.ok, 'rounds:', hostAuth.rounds.length);
  const q1 = hostAuth.rounds[0].questions[0];

  const t1join = await new Promise(r => team1.emit('join:team', { roomCode: ROOM, teamName: 'Alpha' }, r));
  const t2join = await new Promise(r => team2.emit('join:team', { roomCode: ROOM, teamName: 'Beta' }, r));
  const jJoin = await new Promise(r => jasper.emit('join:jasper', { roomCode: ROOM }, r));
  const projJoin = await new Promise(r => projector.emit('join:projector', { roomCode: ROOM }, r));
  console.log('JOINS ok:', t1join.ok, t2join.ok, jJoin.ok, projJoin.ok);

  let team1SawQuestion = null, jasperSawQuestion = null, projSawQuestion = null;
  team1.on('question:state', (q) => { team1SawQuestion = q; });
  jasper.on('question:state', (q) => { jasperSawQuestion = q; });
  projector.on('question:state', (q) => { projSawQuestion = q; });

  const openRes = await new Promise(r => host.emit('host:openQuestion', { questionId: q1.id }, r));
  console.log('OPEN ok:', openRes.ok);
  await new Promise(r => setTimeout(r, 300));

  console.log('--- ROLE ISOLATION CHECK ---');
  console.log('Team1 view body:', team1SawQuestion.view.body);
  console.log('Team1 view has options:', team1SawQuestion.view.options.length > 0);
  console.log('Jasper view body:', jasperSawQuestion.view.body);
  console.log('Jasper view has options (should be empty per brief):', jasperSawQuestion.view.options.length);
  console.log('Projector received NO team/jasper fields (should be undefined):', projSawQuestion.view, projSawQuestion.teamView, projSawQuestion.jasperView);
  console.log('Projector body === public body only:', projSawQuestion.public.body);

  // Submit answers
  const submitCorrectTeam = await new Promise(r => team1.emit('team:submitAnswer', { questionId: q1.id, answer: { value: '2007' } }, r));
  const submitWrongTeam = await new Promise(r => team2.emit('team:submitAnswer', { questionId: q1.id, answer: { value: '2005' } }, r));
  const submitJasper = await new Promise(r => jasper.emit('team:submitAnswer', { questionId: q1.id, answer: { value: '2007' } }, r));
  console.log('SUBMITS ok:', submitCorrectTeam.ok, submitWrongTeam.ok, submitJasper.ok);

  // release hint 1 then lock
  const hint1 = await new Promise(r => host.emit('host:releaseHint', { questionId: q1.id, stage: 1 }, r));
  console.log('HINT1 ok:', hint1.ok);

  let scoreUpdates = [];
  team1.on('score:updated', (st) => scoreUpdates.push(st));

  const lockRes = await new Promise(r => host.emit('host:lockQuestion', { questionId: q1.id }, r));
  console.log('LOCK ok:', lockRes.ok);
  await new Promise(r => setTimeout(r, 300));

  console.log('--- SCORING CHECK ---');
  const latest = scoreUpdates[scoreUpdates.length - 1];
  console.log('Standings after lock:', JSON.stringify(latest));

  // Reveal
  const revealRes = await new Promise(r => host.emit('host:revealQuestion', { questionId: q1.id }, r));
  console.log('REVEAL ok:', revealRes.ok);

  // Manual score adjustment + undo
  const adjust = await new Promise(r => host.emit('host:adjustScore', { participantId: t1join.participant.id, amount: 5, reason: 'bonus for enthusiasm' }, r));
  console.log('ADJUST ok:', adjust.ok, 'ledgerId:', adjust.ledgerId);
  await new Promise(r => setTimeout(r, 200));
  const undo = await new Promise(r => host.emit('host:undoLedger', { ledgerId: adjust.ledgerId }, r));
  console.log('UNDO ok:', undo.ok);

  // Exclusion test
  const excl = await new Promise(r => host.emit('host:excludeParticipant', { questionId: q1.id, participantId: t2join.participant.id, excluded: true }, r));
  console.log('EXCLUDE ok:', excl.ok);
  let team2Lockout = false;
  team2.on('question:lockout', () => { team2Lockout = true; });
  // Re-emit open to trigger a fresh broadcast that includes exclusion (already broadcast by excludeParticipant handler)
  await new Promise(r => setTimeout(r, 300));
  console.log('Team2 got lockout event:', team2Lockout);

  // Reconnect test
  const savedToken = t1join.token;
  const reconnectSocket = connect();
  await new Promise(r => reconnectSocket.on('connect', r));
  const reconnectRes = await new Promise(r => reconnectSocket.emit('join:reconnect', { token: savedToken }, r));
  console.log('RECONNECT ok:', reconnectRes.ok, 'name:', reconnectRes.participant && reconnectRes.participant.name);

  console.log('\\nSMOKE TEST COMPLETE — see checks above for PASS/FAIL judgement');
  process.exit(0);
}

main().catch(e => { console.error('SMOKE TEST FAILED:', e); process.exit(1); });
