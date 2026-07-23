// db.js — SQLite persistence layer.
// Single file DB so it's trivial to back up: just copy quiz.db.
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'quiz.db');
require('fs').mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // safer against crashes mid-write

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  room_code TEXT UNIQUE NOT NULL,
  host_secret TEXT UNIQUE NOT NULL,
  status TEXT NOT NULL DEFAULT 'lobby', -- lobby | live | paused | finished
  current_round_id TEXT,
  current_question_id TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL, -- 'team' | 'jasper'
  name TEXT NOT NULL,
  session_token TEXT UNIQUE NOT NULL,
  connected INTEGER NOT NULL DEFAULT 0,
  joined_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS exclusions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  participant_id TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rounds (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  title TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- draft|open|hint1|hint2|locked|revealed|retired
  public_display TEXT NOT NULL, -- JSON
  team_view TEXT NOT NULL,      -- JSON
  jasper_view TEXT NOT NULL,    -- JSON
  excluded_participant_ids TEXT NOT NULL DEFAULT '[]', -- JSON array
  answer_key TEXT NOT NULL,     -- JSON
  accepted_answers TEXT NOT NULL DEFAULT '[]', -- JSON
  marking_notes TEXT DEFAULT '',
  scoring TEXT NOT NULL,        -- JSON: {team_base, jasper_base, jasper_correct_no_loss, hint_stage_values:[v0,v1,v2], tolerance, max_loss, per_part:[]}
  assets TEXT DEFAULT '[]',     -- JSON
  reveal_content TEXT DEFAULT '{}', -- JSON
  host_notes TEXT DEFAULT '',
  opened_at INTEGER,
  locked_at INTEGER,
  revealed_at INTEGER
);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  answer TEXT NOT NULL, -- JSON
  hint_stage_at_submit INTEGER NOT NULL DEFAULT 0,
  submitted_at INTEGER NOT NULL,
  marked_status TEXT DEFAULT 'pending', -- pending|correct|partial|incorrect|custom
  awarded_points REAL,
  UNIQUE(question_id, participant_id)
);

CREATE TABLE IF NOT EXISTS score_ledger (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  question_id TEXT,
  amount REAL NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  is_undo INTEGER NOT NULL DEFAULT 0,
  undoes_ledger_id TEXT
);

CREATE TABLE IF NOT EXISTS hint_releases (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL,
  stage INTEGER NOT NULL, -- 1 or 2
  released_at INTEGER NOT NULL,
  UNIQUE(question_id, stage)
);

CREATE TABLE IF NOT EXISTS pat_tokens (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  participant_id TEXT NOT NULL,
  used INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER,
  source TEXT NOT NULL DEFAULT 'base' -- base | lowest_team_bonus
);
`);

module.exports = db;
