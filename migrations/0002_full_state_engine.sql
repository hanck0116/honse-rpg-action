PRAGMA foreign_keys = ON;

CREATE TABLE game_entities (
  entity_id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL,
  entity_type TEXT NOT NULL CHECK (entity_type IN (
    'character', 'item', 'skill', 'mission_board', 'mission', 'npc', 'monster',
    'named', 'location', 'world', 'crisis', 'gimmick', 'hazard', 'combat',
    'drop_table', 'dlc', 'note'
  )),
  parent_id TEXT,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN (
    'active', 'inactive', 'accepted', 'completed', 'failed', 'paused',
    'archived', 'replaced', 'consumed', 'destroyed'
  )),
  visibility TEXT NOT NULL DEFAULT 'public' CHECK (visibility IN (
    'public', 'discovered', 'hidden', 'sealed', 'gm'
  )),
  sort_order INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  public_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(public_json)),
  gm_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(gm_json)),
  last_action_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (slot_id) REFERENCES save_slots(slot_id),
  FOREIGN KEY (parent_id) REFERENCES game_entities(entity_id)
);

CREATE INDEX idx_game_entities_slot_type_status
  ON game_entities(slot_id, entity_type, status, sort_order, updated_at DESC);

CREATE INDEX idx_game_entities_parent
  ON game_entities(parent_id, entity_type, status);

CREATE TABLE party_access (
  slot_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  token_hint TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (slot_id) REFERENCES save_slots(slot_id)
);

CREATE TABLE slot_counters (
  slot_id TEXT PRIMARY KEY,
  completed_missions INTEGER NOT NULL DEFAULT 0 CHECK (completed_missions >= 0),
  FOREIGN KEY (slot_id) REFERENCES save_slots(slot_id)
);

-- A short-lived CHECK constraint used inside D1 batches. A failed optimistic
-- update inserts 0, aborting and rolling back the entire batch.
CREATE TABLE mutation_guards (
  guard_id TEXT PRIMARY KEY,
  ok INTEGER NOT NULL CHECK (ok = 1)
);

ALTER TABLE action_logs ADD COLUMN public_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(public_json));
ALTER TABLE rolls ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'
  CHECK (visibility IN ('public', 'hidden'));
ALTER TABLE rolls ADD COLUMN public_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(public_json));

CREATE INDEX idx_rolls_slot_visibility_created
  ON rolls(slot_id, visibility, created_at DESC);

CREATE TRIGGER ensure_slot_counter
AFTER INSERT ON save_slots
BEGIN
  INSERT OR IGNORE INTO slot_counters (slot_id, completed_missions)
  VALUES (NEW.slot_id, 0);
END;

INSERT OR IGNORE INTO slot_counters (slot_id, completed_missions)
SELECT slot_id, 0 FROM save_slots;
