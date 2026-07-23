// scoring.js — pure functions for computing point awards.
// Kept separate from db/socket wiring so the rules can be unit-tested/tweaked
// without touching networking code.

const { nanoid } = require('nanoid');
const db = require('./db');

/**
 * Compute the point value for a correct answer given the hint stage it was
 * submitted at, using the question's configured hint_stage_values.
 * hint_stage_values = [unaided, afterHint1, afterHint2]
 */
function valueForHintStage(scoring, hintStage) {
  const stages = scoring.hint_stage_values || [3, 2, 1];
  const idx = Math.min(hintStage, stages.length - 1);
  return stages[idx];
}

/**
 * Core marking logic. Returns { status, points, reason }.
 * status: 'correct' | 'partial' | 'incorrect'
 * Does NOT write to the ledger — caller does that so manual overrides
 * can reuse the same path.
 */
function autoMark({ participantType, answer, question }) {
  const scoring = JSON.parse(question.scoring);
  const answerKey = JSON.parse(question.answer_key);
  const accepted = JSON.parse(question.accepted_answers || '[]');
  const inputType = JSON.parse(question.team_view).inputType || JSON.parse(question.jasper_view).inputType;

  let isCorrect = false;

  if (inputType === 'multiple_choice' || inputType === 'single_choice') {
    isCorrect = String(answer.value).trim().toLowerCase() === String(answerKey.value).trim().toLowerCase();
  } else if (inputType === 'numeric') {
    const tol = scoring.tolerance ?? 0;
    const given = Number(answer.value);
    const correct = Number(answerKey.value);
    isCorrect = !Number.isNaN(given) && Math.abs(given - correct) <= tol;
  } else if (inputType === 'free_text') {
    const given = String(answer.value || '').trim().toLowerCase();
    const pool = [String(answerKey.value).trim().toLowerCase(), ...accepted.map(a => String(a).trim().toLowerCase())];
    isCorrect = pool.includes(given);
  } else {
    // matching, ordering, image_id, multi_part, manual types fall through
    // to manual adjudication — auto-mark cannot safely decide.
    return { status: 'pending', points: null, reason: 'requires manual adjudication' };
  }

  const base = participantType === 'jasper' ? (scoring.jasper_base ?? -scoring.team_base) : valueForHintStage(scoring, 0);

  if (isCorrect) {
    const points = participantType === 'jasper' ? (scoring.jasper_correct_points ?? Math.abs(scoring.jasper_base ?? 0)) : base;
    return { status: 'correct', points, reason: 'auto-marked correct' };
  }

  // Incorrect: Jasper may take a penalty; teams normally just score 0 (not negative)
  // unless the question explicitly configures a team penalty.
  if (participantType === 'jasper') {
    const penalty = scoring.jasper_base ?? 0; // expected negative, e.g. -2
    if (scoring.jasper_correct_no_loss && isCorrect) return { status: 'correct', points: 0, reason: 'no-loss rule' };
    const capped = scoring.max_loss != null ? Math.max(penalty, -Math.abs(scoring.max_loss)) : penalty;
    return { status: 'incorrect', points: capped, reason: 'auto-marked incorrect (Jasper penalty)' };
  }
  return { status: 'incorrect', points: scoring.team_incorrect_points ?? 0, reason: 'auto-marked incorrect' };
}

/**
 * Write a ledger entry and return it. This is the ONLY way points should
 * ever be applied — keeps every change auditable and undoable.
 */
function awardPoints({ sessionId, participantId, questionId, amount, reason }) {
  const entry = {
    id: nanoid(),
    session_id: sessionId,
    participant_id: participantId,
    question_id: questionId || null,
    amount,
    reason,
    created_at: Date.now(),
    is_undo: 0,
    undoes_ledger_id: null
  };
  db.prepare(`INSERT INTO score_ledger (id, session_id, participant_id, question_id, amount, reason, created_at, is_undo, undoes_ledger_id)
              VALUES (@id, @session_id, @participant_id, @question_id, @amount, @reason, @created_at, @is_undo, @undoes_ledger_id)`).run(entry);
  return entry;
}

/** Undo a ledger entry by inserting an equal-and-opposite compensating entry. */
function undoLedgerEntry(ledgerId) {
  const original = db.prepare('SELECT * FROM score_ledger WHERE id = ?').get(ledgerId);
  if (!original) throw new Error('Ledger entry not found');
  const entry = {
    id: nanoid(),
    session_id: original.session_id,
    participant_id: original.participant_id,
    question_id: original.question_id,
    amount: -original.amount,
    reason: `Undo: ${original.reason}`,
    created_at: Date.now(),
    is_undo: 1,
    undoes_ledger_id: original.id
  };
  db.prepare(`INSERT INTO score_ledger (id, session_id, participant_id, question_id, amount, reason, created_at, is_undo, undoes_ledger_id)
              VALUES (@id, @session_id, @participant_id, @question_id, @amount, @reason, @created_at, @is_undo, @undoes_ledger_id)`).run(entry);
  return entry;
}

/** Sum of all ledger entries for a participant. */
function totalForParticipant(participantId) {
  const row = db.prepare('SELECT COALESCE(SUM(amount),0) as total FROM score_ledger WHERE participant_id = ?').get(participantId);
  return row.total;
}

/** Full standings for a session: teams sorted desc, Jasper shown separately. */
function standings(sessionId) {
  const participants = db.prepare('SELECT * FROM participants WHERE session_id = ?').all(sessionId);
  const teams = participants.filter(p => p.type === 'team').map(p => ({
    id: p.id, name: p.name, total: totalForParticipant(p.id)
  })).sort((a, b) => b.total - a.total);
  const jasperP = participants.find(p => p.type === 'jasper');
  const jasper = jasperP ? { id: jasperP.id, name: jasperP.name, total: totalForParticipant(jasperP.id) } : null;
  return { teams, jasper };
}

module.exports = { valueForHintStage, autoMark, awardPoints, undoLedgerEntry, totalForParticipant, standings };
