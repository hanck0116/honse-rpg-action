PRAGMA foreign_keys = ON;

CREATE TABLE save_slots (
  slot_id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 80),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'completed', 'archived')),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  last_action_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_save_slots_status_updated
  ON save_slots(status, updated_at DESC);

CREATE TABLE action_requests (
  action_id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('processing', 'committed', 'rejected')),
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  http_status INTEGER,
  log_id TEXT NOT NULL UNIQUE,
  event_type TEXT NOT NULL,
  cause TEXT NOT NULL,
  rule_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(rule_refs_json)),
  target_revision INTEGER,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_action_requests_slot_created
  ON action_requests(slot_id, created_at DESC);

CREATE TABLE action_logs (
  log_id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,
  slot_id TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  revision_before INTEGER,
  revision_after INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  cause TEXT NOT NULL,
  rule_refs_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(rule_refs_json)),
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT NOT NULL CHECK (json_valid(after_json)),
  roll_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(roll_ids_json)),
  created_at TEXT NOT NULL,
  FOREIGN KEY (action_id) REFERENCES action_requests(action_id),
  FOREIGN KEY (slot_id) REFERENCES save_slots(slot_id)
);

CREATE INDEX idx_action_logs_slot_created
  ON action_logs(slot_id, created_at DESC);

CREATE INDEX idx_action_logs_action
  ON action_logs(action_id);

CREATE TABLE characters (
  character_id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  level INTEGER NOT NULL DEFAULT 1 CHECK (level >= 1),
  adventurer_rank TEXT NOT NULL DEFAULT 'F',
  current_hp INTEGER NOT NULL DEFAULT 1,
  max_hp INTEGER NOT NULL DEFAULT 1 CHECK (max_hp >= 1),
  sheet_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(sheet_json)),
  last_action_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (slot_id) REFERENCES save_slots(slot_id)
);

CREATE INDEX idx_characters_slot_active
  ON characters(slot_id, active, name);

CREATE TABLE world_states (
  state_id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL,
  state_type TEXT NOT NULL,
  title TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  public_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(public_json)),
  gm_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(gm_json)),
  last_action_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (slot_id) REFERENCES save_slots(slot_id)
);

CREATE INDEX idx_world_states_slot_type_active
  ON world_states(slot_id, state_type, active);

CREATE TABLE rolls (
  roll_id TEXT PRIMARY KEY,
  slot_id TEXT NOT NULL,
  action_id TEXT NOT NULL,
  resolution_type TEXT NOT NULL,
  dice_expression TEXT NOT NULL,
  locked_context_json TEXT NOT NULL CHECK (json_valid(locked_context_json)),
  raw_results_json TEXT NOT NULL CHECK (json_valid(raw_results_json)),
  outcome_json TEXT NOT NULL CHECK (json_valid(outcome_json)),
  rng_method TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (slot_id) REFERENCES save_slots(slot_id),
  FOREIGN KEY (action_id) REFERENCES action_requests(action_id)
);

CREATE INDEX idx_rolls_slot_created
  ON rolls(slot_id, created_at DESC);

CREATE TRIGGER log_save_slot_insert
AFTER INSERT ON save_slots
WHEN NEW.last_action_id IS NOT NULL
BEGIN
  INSERT INTO action_logs (
    log_id,
    action_id,
    slot_id,
    target_type,
    target_id,
    revision_before,
    revision_after,
    event_type,
    cause,
    rule_refs_json,
    before_json,
    after_json,
    roll_ids_json,
    created_at
  )
  SELECT
    request.log_id,
    request.action_id,
    NEW.slot_id,
    'save_slot',
    NEW.slot_id,
    NULL,
    NEW.revision,
    request.event_type,
    request.cause,
    request.rule_refs_json,
    NULL,
    json_object('title', NEW.title, 'status', NEW.status),
    '[]',
    NEW.created_at
  FROM action_requests AS request
  WHERE request.action_id = NEW.last_action_id;
END;

CREATE TRIGGER log_save_slot_update
AFTER UPDATE ON save_slots
WHEN NEW.last_action_id IS NOT OLD.last_action_id
BEGIN
  INSERT INTO action_logs (
    log_id,
    action_id,
    slot_id,
    target_type,
    target_id,
    revision_before,
    revision_after,
    event_type,
    cause,
    rule_refs_json,
    before_json,
    after_json,
    roll_ids_json,
    created_at
  )
  SELECT
    request.log_id,
    request.action_id,
    NEW.slot_id,
    'save_slot',
    NEW.slot_id,
    OLD.revision,
    NEW.revision,
    request.event_type,
    request.cause,
    request.rule_refs_json,
    CASE
      WHEN request.event_type = 'save_slot_renamed'
        THEN json_object('title', OLD.title)
      ELSE json_object('status', OLD.status)
    END,
    CASE
      WHEN request.event_type = 'save_slot_renamed'
        THEN json_object('title', NEW.title)
      ELSE json_object('status', NEW.status)
    END,
    '[]',
    NEW.updated_at
  FROM action_requests AS request
  WHERE request.action_id = NEW.last_action_id;
END;

