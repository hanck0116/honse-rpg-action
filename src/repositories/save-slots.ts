import { AppError } from "../domain/errors";
import { newLogId, newSlotId } from "../domain/ids";
import type { StoredResponse } from "../http";
import { hashRequest } from "../security";

export type SaveSlotStatus = "active" | "paused" | "completed" | "archived";

export interface SaveSlot {
  slot_id: string;
  title: string;
  status: SaveSlotStatus;
  revision: number;
  created_at: string;
  updated_at: string;
}

interface SaveSlotRow extends SaveSlot {
  last_action_id: string | null;
}

interface ActionRequestRow {
  action_id: string;
  request_hash: string;
  status: "processing" | "committed" | "rejected";
  response_json: string | null;
  http_status: number | null;
}

interface MutationBase {
  actionId: string;
  slotId: string;
  expectedRevision: number;
  cause: string;
}

export interface RenameSlotInput extends MutationBase {
  kind: "rename";
  title: string;
}

export interface StatusSlotInput extends MutationBase {
  kind: "archive" | "restore";
}

type SlotMutationInput = RenameSlotInput | StatusSlotInput;

const RULE_REFS = JSON.stringify([
  "05:상태 수정 절차",
  "05:revision 충돌",
  "stage1:저장 슬롯 계약",
]);

function toSaveSlot(row: SaveSlotRow): SaveSlot {
  return {
    slot_id: row.slot_id,
    title: row.title,
    status: row.status,
    revision: row.revision,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

async function getActionRequest(db: D1Database, actionId: string): Promise<ActionRequestRow | null> {
  return db
    .prepare(
      `SELECT action_id, request_hash, status, response_json, http_status
       FROM action_requests
       WHERE action_id = ?`,
    )
    .bind(actionId)
    .first<ActionRequestRow>();
}

function replayAction(row: ActionRequestRow, requestHash: string): StoredResponse {
  if (row.request_hash !== requestHash) {
    throw new AppError(
      409,
      "duplicate_action_mismatch",
      "The same action_id was already used with different request data.",
    );
  }
  if (row.status === "processing" || row.response_json === null || row.http_status === null) {
    throw new AppError(409, "action_in_progress", "The action is still being finalized.", {
      retryable: true,
    });
  }

  let body: unknown;
  try {
    body = JSON.parse(row.response_json);
  } catch {
    throw new AppError(500, "internal_error", "A stored action response is invalid.", {
      retryable: true,
    });
  }
  return { status: row.http_status, body };
}

async function replayIfPresent(
  db: D1Database,
  actionId: string,
  requestHash: string,
): Promise<StoredResponse | null> {
  const existing = await getActionRequest(db, actionId);
  return existing === null ? null : replayAction(existing, requestHash);
}

async function replayAfterWrite(
  db: D1Database,
  actionId: string,
  requestHash: string,
): Promise<StoredResponse> {
  const stored = await getActionRequest(db, actionId);
  if (stored === null) {
    throw new AppError(500, "internal_error", "The action result could not be reloaded.", {
      retryable: true,
    });
  }
  return replayAction(stored, requestHash);
}

export async function listSaveSlots(db: D1Database, includeArchived: boolean): Promise<SaveSlot[]> {
  const result = await db
    .prepare(
      `SELECT slot_id, title, status, revision, last_action_id, created_at, updated_at
       FROM save_slots
       WHERE ? = 1 OR status <> 'archived'
       ORDER BY updated_at DESC, created_at DESC`,
    )
    .bind(includeArchived ? 1 : 0)
    .all<SaveSlotRow>();

  return result.results.map(toSaveSlot);
}

export async function findSaveSlot(db: D1Database, slotId: string): Promise<SaveSlot | null> {
  const row = await db
    .prepare(
      `SELECT slot_id, title, status, revision, last_action_id, created_at, updated_at
       FROM save_slots
       WHERE slot_id = ?`,
    )
    .bind(slotId)
    .first<SaveSlotRow>();
  return row === null ? null : toSaveSlot(row);
}

export async function createSaveSlot(
  db: D1Database,
  input: { actionId: string; title: string },
): Promise<StoredResponse> {
  const requestHash = await hashRequest({
    operation: "create_save_slot",
    action_id: input.actionId,
    title: input.title,
  });
  const replay = await replayIfPresent(db, input.actionId, requestHash);
  if (replay !== null) return replay;

  const slotId = newSlotId();
  const logId = newLogId();
  const now = new Date().toISOString();
  const body = {
    ok: true,
    data: {
      slot: {
        slot_id: slotId,
        title: input.title,
        status: "active",
        revision: 0,
        created_at: now,
        updated_at: now,
      },
    },
  };

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO action_requests (
             action_id, slot_id, operation, request_hash, status, response_json, http_status,
             log_id, event_type, cause, rule_refs_json, target_revision, created_at
           ) VALUES (?, ?, 'create_save_slot', ?, 'processing', ?, 201, ?,
                     'save_slot_created', '새 저장 슬롯 생성', ?, NULL, ?)`,
        )
        .bind(
          input.actionId,
          slotId,
          requestHash,
          JSON.stringify(body),
          logId,
          RULE_REFS,
          now,
        ),
      db
        .prepare(
          `INSERT INTO save_slots (
             slot_id, title, status, revision, last_action_id, created_at, updated_at
           ) VALUES (?, ?, 'active', 0, ?, ?, ?)`,
        )
        .bind(slotId, input.title, input.actionId, now, now),
      db
        .prepare(
          `UPDATE action_requests
           SET status = 'committed', completed_at = ?
           WHERE action_id = ?
             AND EXISTS (
               SELECT 1 FROM save_slots
               WHERE slot_id = ? AND last_action_id = ?
             )`,
        )
        .bind(now, input.actionId, slotId, input.actionId),
    ]);
  } catch (error) {
    const raced = await replayIfPresent(db, input.actionId, requestHash);
    if (raced !== null) return raced;
    throw error;
  }

  return replayAfterWrite(db, input.actionId, requestHash);
}

function mutationMetadata(input: SlotMutationInput): {
  operation: string;
  eventType: string;
  nextTitle: string | null;
  nextStatus: SaveSlotStatus | null;
} {
  switch (input.kind) {
    case "rename":
      return {
        operation: "rename_save_slot",
        eventType: "save_slot_renamed",
        nextTitle: input.title,
        nextStatus: null,
      };
    case "archive":
      return {
        operation: "archive_save_slot",
        eventType: "save_slot_archived",
        nextTitle: null,
        nextStatus: "archived",
      };
    case "restore":
      return {
        operation: "restore_save_slot",
        eventType: "save_slot_restored",
        nextTitle: null,
        nextStatus: "active",
      };
  }
}

function mutationStatement(db: D1Database, input: SlotMutationInput, now: string): D1PreparedStatement {
  if (input.kind === "rename") {
    return db
      .prepare(
        `UPDATE save_slots
         SET title = ?, revision = revision + 1, last_action_id = ?, updated_at = ?
         WHERE slot_id = ? AND revision = ?`,
      )
      .bind(input.title, input.actionId, now, input.slotId, input.expectedRevision);
  }

  const status = input.kind === "archive" ? "archived" : "active";
  return db
    .prepare(
      `UPDATE save_slots
       SET status = ?, revision = revision + 1, last_action_id = ?, updated_at = ?
       WHERE slot_id = ? AND revision = ?`,
    )
    .bind(status, input.actionId, now, input.slotId, input.expectedRevision);
}

export async function mutateSaveSlot(
  db: D1Database,
  input: SlotMutationInput,
): Promise<StoredResponse> {
  const metadata = mutationMetadata(input);
  const requestHash = await hashRequest({
    operation: metadata.operation,
    action_id: input.actionId,
    slot_id: input.slotId,
    expected_revision: input.expectedRevision,
    cause: input.cause,
    ...(metadata.nextTitle === null ? {} : { title: metadata.nextTitle }),
  });
  const replay = await replayIfPresent(db, input.actionId, requestHash);
  if (replay !== null) return replay;

  const current = await findSaveSlot(db, input.slotId);
  const now = new Date().toISOString();
  const logId = newLogId();
  const successBody = {
    ok: true,
    data: {
      slot: {
        slot_id: input.slotId,
        title: metadata.nextTitle ?? current?.title ?? "",
        status: metadata.nextStatus ?? current?.status ?? "active",
        revision: input.expectedRevision + 1,
        created_at: current?.created_at ?? now,
        updated_at: now,
      },
    },
  };
  const notFoundBody = {
    ok: false,
    error: {
      code: "slot_not_found",
      message: "The save slot does not exist.",
      retryable: false,
    },
  };
  const conflictBody = {
    ok: false,
    error: {
      code: "revision_conflict",
      message: "The save slot changed after it was last read. Reload it before retrying.",
      retryable: true,
    },
  };

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO action_requests (
             action_id, slot_id, operation, request_hash, status, response_json, http_status,
             log_id, event_type, cause, rule_refs_json, target_revision, created_at
           ) VALUES (?, ?, ?, ?, 'processing', ?, 200, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.actionId,
          input.slotId,
          metadata.operation,
          requestHash,
          JSON.stringify(successBody),
          logId,
          metadata.eventType,
          input.cause,
          RULE_REFS,
          input.expectedRevision,
          now,
        ),
      mutationStatement(db, input, now),
      db
        .prepare(
          `UPDATE action_requests
           SET status = 'committed', completed_at = ?
           WHERE action_id = ? AND status = 'processing'
             AND EXISTS (
               SELECT 1 FROM save_slots
               WHERE slot_id = ? AND last_action_id = ? AND revision = ?
             )`,
        )
        .bind(now, input.actionId, input.slotId, input.actionId, input.expectedRevision + 1),
      db
        .prepare(
          `UPDATE action_requests
           SET status = 'rejected', response_json = ?, http_status = 404, completed_at = ?
           WHERE action_id = ? AND status = 'processing'
             AND NOT EXISTS (SELECT 1 FROM save_slots WHERE slot_id = ?)`,
        )
        .bind(JSON.stringify(notFoundBody), now, input.actionId, input.slotId),
      db
        .prepare(
          `UPDATE action_requests
           SET status = 'rejected', response_json = ?, http_status = 409, completed_at = ?
           WHERE action_id = ? AND status = 'processing'`,
        )
        .bind(JSON.stringify(conflictBody), now, input.actionId),
    ]);
  } catch (error) {
    const raced = await replayIfPresent(db, input.actionId, requestHash);
    if (raced !== null) return raced;
    throw error;
  }

  return replayAfterWrite(db, input.actionId, requestHash);
}

