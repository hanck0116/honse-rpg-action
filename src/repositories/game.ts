import { AppError } from "../domain/errors";
import {
  canonicalCharacterPublic,
  canonicalEntityPublic,
  type EntityStatus,
  type EntityType,
  isRecord,
  type Visibility,
} from "../domain/game";
import type { StoredResponse } from "../http";
import { hashRequest, sha256Hex } from "../security";

export interface GameEntity {
  entity_id: string;
  slot_id: string;
  entity_type: EntityType;
  parent_id: string | null;
  name: string;
  status: EntityStatus;
  visibility: Visibility;
  sort_order: number;
  revision: number;
  public_data: Record<string, unknown>;
  gm_data: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface GameEntityRow {
  entity_id: string;
  slot_id: string;
  entity_type: EntityType;
  parent_id: string | null;
  name: string;
  status: EntityStatus;
  visibility: Visibility;
  sort_order: number;
  revision: number;
  public_json: string;
  gm_json: string;
  last_action_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ActionRequestRow {
  action_id: string;
  request_hash: string;
  status: "processing" | "committed" | "rejected";
  response_json: string | null;
  http_status: number | null;
}

interface SaveSlotRow {
  slot_id: string;
  title: string;
  status: string;
  revision: number;
  updated_at: string;
}

const RULE_REFS = JSON.stringify([
  "01:핵심 판정·스탯 계산",
  "04:임무·전투·드롭 고정",
  "05:상태 수정·revision·행동 로그",
]);

function parseStoredObject(json: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new AppError(500, "invalid_stored_state", `${label} contains invalid JSON.`);
  }
  if (!isRecord(parsed)) throw new AppError(500, "invalid_stored_state", `${label} must be an object.`);
  return parsed;
}

function toEntity(row: GameEntityRow): GameEntity {
  return {
    entity_id: row.entity_id,
    slot_id: row.slot_id,
    entity_type: row.entity_type,
    parent_id: row.parent_id,
    name: row.name,
    status: row.status,
    visibility: row.visibility,
    sort_order: row.sort_order,
    revision: row.revision,
    public_data: parseStoredObject(row.public_json, "public_json"),
    gm_data: parseStoredObject(row.gm_json, "gm_json"),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function newEntityId(type: EntityType): string {
  const prefix: Record<EntityType, string> = {
    character: "chr", item: "itm", skill: "skl", mission_board: "mbrd", mission: "msn",
    npc: "npc", monster: "mon", named: "nmd", location: "loc", world: "wld",
    crisis: "crs", gimmick: "gim", hazard: "haz", combat: "cmb", drop_table: "drp",
    dlc: "dlc", note: "nte",
  };
  return `${prefix[type]}_${crypto.randomUUID()}`;
}

function newLogId(): string {
  return `log_${crypto.randomUUID()}`;
}

async function getAction(db: D1Database, actionId: string): Promise<ActionRequestRow | null> {
  return db
    .prepare(`SELECT action_id, request_hash, status, response_json, http_status FROM action_requests WHERE action_id = ?`)
    .bind(actionId)
    .first<ActionRequestRow>();
}

function replayAction(row: ActionRequestRow, requestHash: string): StoredResponse {
  if (row.request_hash !== requestHash) {
    throw new AppError(409, "duplicate_action_mismatch", "The same action_id was already used with different request data.");
  }
  if (row.status !== "committed" || row.response_json === null || row.http_status === null) {
    throw new AppError(409, "action_in_progress", "The action is still being finalized.", { retryable: true });
  }
  let body: unknown;
  try {
    body = JSON.parse(row.response_json);
  } catch {
    throw new AppError(500, "invalid_stored_state", "A stored action response is invalid.");
  }
  return { status: row.http_status, body };
}

async function replayIfPresent(
  db: D1Database,
  actionId: string,
  requestHash: string,
): Promise<StoredResponse | null> {
  const existing = await getAction(db, actionId);
  return existing === null ? null : replayAction(existing, requestHash);
}

export async function requireSlot(db: D1Database, slotId: string): Promise<SaveSlotRow> {
  const slot = await db
    .prepare(`SELECT slot_id, title, status, revision, updated_at FROM save_slots WHERE slot_id = ?`)
    .bind(slotId)
    .first<SaveSlotRow>();
  if (slot === null) throw new AppError(404, "slot_not_found", "The save slot does not exist.");
  return slot;
}

export async function findEntity(
  db: D1Database,
  slotId: string,
  entityId: string,
): Promise<GameEntity | null> {
  const row = await db
    .prepare(
      `SELECT entity_id, slot_id, entity_type, parent_id, name, status, visibility,
              sort_order, revision, public_json, gm_json, last_action_id, created_at, updated_at
       FROM game_entities WHERE slot_id = ? AND entity_id = ?`,
    )
    .bind(slotId, entityId)
    .first<GameEntityRow>();
  return row === null ? null : toEntity(row);
}

export async function requireEntity(
  db: D1Database,
  slotId: string,
  entityId: string,
  expectedType?: EntityType,
): Promise<GameEntity> {
  const entity = await findEntity(db, slotId, entityId);
  if (entity === null) throw new AppError(404, "entity_not_found", "The state entity does not exist.");
  if (expectedType !== undefined && entity.entity_type !== expectedType) {
    throw new AppError(400, "entity_type_mismatch", `The entity must be a ${expectedType}.`);
  }
  return entity;
}

export async function listEntities(
  db: D1Database,
  slotId: string,
  options: { type?: EntityType; includeArchived?: boolean } = {},
): Promise<GameEntity[]> {
  await requireSlot(db, slotId);
  const result = await db
    .prepare(
      `SELECT entity_id, slot_id, entity_type, parent_id, name, status, visibility,
              sort_order, revision, public_json, gm_json, last_action_id, created_at, updated_at
       FROM game_entities
       WHERE slot_id = ?
         AND (? IS NULL OR entity_type = ?)
         AND (? = 1 OR status NOT IN ('archived', 'replaced', 'destroyed', 'consumed'))
       ORDER BY entity_type, sort_order, created_at`,
    )
    .bind(slotId, options.type ?? null, options.type ?? null, options.includeArchived ? 1 : 0)
    .all<GameEntityRow>();
  return result.results.map(toEntity);
}

export interface CreateEntityInput {
  actionId: string;
  slotId: string;
  entityType: EntityType;
  parentId: string | null;
  name: string;
  status: EntityStatus;
  visibility: Visibility;
  sortOrder: number;
  publicData: Record<string, unknown>;
  gmData: Record<string, unknown>;
  cause: string;
  publicSummary?: Record<string, unknown>;
}

export async function createEntity(
  db: D1Database,
  input: CreateEntityInput,
): Promise<StoredResponse> {
  await requireSlot(db, input.slotId);
  if (input.parentId !== null) await requireEntity(db, input.slotId, input.parentId);
  const publicData = canonicalEntityPublic(input.entityType, input.publicData);
  const requestHash = await hashRequest({ operation: "create_entity", ...input, publicData });
  const replay = await replayIfPresent(db, input.actionId, requestHash);
  if (replay !== null) return replay;

  const entityId = newEntityId(input.entityType);
  const logId = newLogId();
  const now = new Date().toISOString();
  const entity: GameEntity = {
    entity_id: entityId,
    slot_id: input.slotId,
    entity_type: input.entityType,
    parent_id: input.parentId,
    name: input.name,
    status: input.status,
    visibility: input.visibility,
    sort_order: input.sortOrder,
    revision: 0,
    public_data: publicData,
    gm_data: input.gmData,
    created_at: now,
    updated_at: now,
  };
  const response = { ok: true, data: { entity } };
  const responseJson = JSON.stringify(response);
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO action_requests (
          action_id, slot_id, operation, request_hash, status, response_json, http_status,
          log_id, event_type, cause, rule_refs_json, target_revision, created_at
        ) VALUES (?, ?, 'create_entity', ?, 'processing', ?, 201, ?, 'entity_created', ?, ?, 0, ?)`,
      ).bind(input.actionId, input.slotId, requestHash, responseJson, logId, input.cause, RULE_REFS, now),
      db.prepare(
        `INSERT INTO game_entities (
          entity_id, slot_id, entity_type, parent_id, name, status, visibility, sort_order,
          revision, public_json, gm_json, last_action_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      ).bind(
        entityId, input.slotId, input.entityType, input.parentId, input.name, input.status,
        input.visibility, input.sortOrder, JSON.stringify(publicData), JSON.stringify(input.gmData),
        input.actionId, now, now,
      ),
      db.prepare(
        `INSERT INTO action_logs (
          log_id, action_id, slot_id, target_type, target_id, revision_before, revision_after,
          event_type, cause, rule_refs_json, before_json, after_json, roll_ids_json, public_json, created_at
        ) VALUES (?, ?, ?, ?, ?, NULL, 0, 'entity_created', ?, ?, NULL, ?, '[]', ?, ?)`,
      ).bind(
        logId, input.actionId, input.slotId, input.entityType, entityId, input.cause, RULE_REFS,
        JSON.stringify({ name: input.name, status: input.status, public_data: publicData }),
        JSON.stringify(input.publicSummary ?? {}), now,
      ),
      db.prepare(`UPDATE action_requests SET status = 'committed', completed_at = ? WHERE action_id = ?`)
        .bind(now, input.actionId),
    ]);
  } catch (error) {
    const raced = await replayIfPresent(db, input.actionId, requestHash);
    if (raced !== null) return raced;
    throw error;
  }
  return { status: 201, body: response };
}

export interface UpdateEntityInput {
  actionId: string;
  slotId: string;
  entityId: string;
  expectedRevision: number;
  name?: string;
  status?: EntityStatus;
  visibility?: Visibility;
  sortOrder?: number;
  publicData?: Record<string, unknown>;
  gmData?: Record<string, unknown>;
  cause: string;
  publicSummary?: Record<string, unknown>;
}

export async function updateEntity(
  db: D1Database,
  input: UpdateEntityInput,
): Promise<StoredResponse> {
  const requestHash = await hashRequest({ operation: "update_entity", ...input });
  const replay = await replayIfPresent(db, input.actionId, requestHash);
  if (replay !== null) return replay;
  const current = await requireEntity(db, input.slotId, input.entityId);
  if (current.revision !== input.expectedRevision) {
    throw new AppError(409, "revision_conflict", "The entity changed after it was read.", {
      retryable: true,
      details: { current_revision: current.revision },
    });
  }
  const publicData = input.publicData === undefined
    ? current.public_data
    : canonicalEntityPublic(current.entity_type, input.publicData);
  const next: GameEntity = {
    ...current,
    name: input.name ?? current.name,
    status: input.status ?? current.status,
    visibility: input.visibility ?? current.visibility,
    sort_order: input.sortOrder ?? current.sort_order,
    revision: current.revision + 1,
    public_data: publicData,
    gm_data: input.gmData ?? current.gm_data,
    updated_at: new Date().toISOString(),
  };
  const logId = newLogId();
  const guardId = `guard_${crypto.randomUUID()}`;
  const response = { ok: true, data: { entity: next } };
  const now = next.updated_at;
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO action_requests (
          action_id, slot_id, operation, request_hash, status, response_json, http_status,
          log_id, event_type, cause, rule_refs_json, target_revision, created_at
        ) VALUES (?, ?, 'update_entity', ?, 'processing', ?, 200, ?, 'entity_updated', ?, ?, ?, ?)`,
      ).bind(
        input.actionId, input.slotId, requestHash, JSON.stringify(response), logId, input.cause,
        RULE_REFS, next.revision, now,
      ),
      db.prepare(
        `UPDATE game_entities
         SET name = ?, status = ?, visibility = ?, sort_order = ?, revision = revision + 1,
             public_json = ?, gm_json = ?, last_action_id = ?, updated_at = ?
         WHERE slot_id = ? AND entity_id = ? AND revision = ?`,
      ).bind(
        next.name, next.status, next.visibility, next.sort_order, JSON.stringify(next.public_data),
        JSON.stringify(next.gm_data), input.actionId, now, input.slotId, input.entityId,
        input.expectedRevision,
      ),
      db.prepare(
        `INSERT INTO mutation_guards (guard_id, ok)
         SELECT ?, CASE WHEN EXISTS (
           SELECT 1 FROM game_entities WHERE entity_id = ? AND last_action_id = ? AND revision = ?
         ) THEN 1 ELSE 0 END`,
      ).bind(guardId, input.entityId, input.actionId, next.revision),
      db.prepare(
        `INSERT INTO action_logs (
          log_id, action_id, slot_id, target_type, target_id, revision_before, revision_after,
          event_type, cause, rule_refs_json, before_json, after_json, roll_ids_json, public_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'entity_updated', ?, ?, ?, ?, '[]', ?, ?)`,
      ).bind(
        logId, input.actionId, input.slotId, current.entity_type, input.entityId,
        current.revision, next.revision, input.cause, RULE_REFS,
        JSON.stringify({ name: current.name, status: current.status, public_data: current.public_data, gm_data: current.gm_data }),
        JSON.stringify({ name: next.name, status: next.status, public_data: next.public_data, gm_data: next.gm_data }),
        JSON.stringify(input.publicSummary ?? {}), now,
      ),
      db.prepare(`UPDATE action_requests SET status = 'committed', completed_at = ? WHERE action_id = ?`)
        .bind(now, input.actionId),
      db.prepare(`DELETE FROM mutation_guards WHERE guard_id = ?`).bind(guardId),
    ]);
  } catch (error) {
    const raced = await replayIfPresent(db, input.actionId, requestHash);
    if (raced !== null) return raced;
    const latest = await requireEntity(db, input.slotId, input.entityId);
    if (latest.revision !== input.expectedRevision) {
      throw new AppError(409, "revision_conflict", "The entity changed after it was read.", {
        retryable: true,
        details: { current_revision: latest.revision },
      });
    }
    throw error;
  }
  return { status: 200, body: response };
}

export interface TransactionCreateMutation {
  kind: "create";
  clientRef: string;
  entityType: EntityType;
  parentId: string | null;
  parentClientRef?: string;
  name: string;
  status: EntityStatus;
  visibility: Visibility;
  sortOrder: number;
  publicData: Record<string, unknown>;
  gmData: Record<string, unknown>;
  publicSummary?: Record<string, unknown>;
}

export interface TransactionUpdateMutation {
  kind: "update";
  entityId: string;
  expectedRevision: number;
  name?: string;
  status?: EntityStatus;
  visibility?: Visibility;
  sortOrder?: number;
  publicData?: Record<string, unknown>;
  gmData?: Record<string, unknown>;
  publicSummary?: Record<string, unknown>;
}

export type StateMutation = TransactionCreateMutation | TransactionUpdateMutation;

/**
 * Commits one rule outcome across multiple entities in a single D1 transaction.
 * This is the state primitive for combat damage/statuses, item transfers,
 * crafting/synthesis inputs and outputs, consumables, deaths, revivals, DLC
 * activation, and any other change that must not be partially saved.
 */
export async function applyStateTransaction(
  db: D1Database,
  input: {
    actionId: string;
    slotId: string;
    cause: string;
    mutations: StateMutation[];
  },
): Promise<StoredResponse> {
  const requestHash = await hashRequest({ operation: "state_transaction", ...input });
  const replay = await replayIfPresent(db, input.actionId, requestHash);
  if (replay !== null) return replay;
  await requireSlot(db, input.slotId);
  if (input.mutations.length < 1 || input.mutations.length > 40) {
    throw new AppError(400, "invalid_transaction", "A state transaction needs 1 to 40 mutations.");
  }

  const createdIds = new Map<string, string>();
  const createIndexes = new Map<string, number>();
  const updateIds = new Set<string>();
  for (let index = 0; index < input.mutations.length; index += 1) {
    const mutation = input.mutations[index];
    if (mutation?.kind === "create") {
      if (createdIds.has(mutation.clientRef)) {
        throw new AppError(400, "invalid_transaction", "Every create client_ref must be unique.");
      }
      createdIds.set(mutation.clientRef, newEntityId(mutation.entityType));
      createIndexes.set(mutation.clientRef, index);
    } else if (mutation?.kind === "update") {
      if (updateIds.has(mutation.entityId)) {
        throw new AppError(400, "invalid_transaction", "An entity can be updated only once per transaction.");
      }
      updateIds.add(mutation.entityId);
    }
  }

  const now = new Date().toISOString();
  const resolved: Array<{
    mutation: StateMutation;
    current: GameEntity | null;
    next: GameEntity;
    logId: string;
    guardId?: string;
  }> = [];
  for (let index = 0; index < input.mutations.length; index += 1) {
    const mutation = input.mutations[index];
    if (mutation?.kind === "create") {
      if (mutation.parentClientRef !== undefined) {
        const parentIndex = createIndexes.get(mutation.parentClientRef);
        if (parentIndex === undefined || parentIndex >= index) {
          throw new AppError(400, "invalid_transaction", "A parent_client_ref must point to an earlier create mutation.");
        }
      }
      const parentId = mutation.parentClientRef === undefined
        ? mutation.parentId
        : createdIds.get(mutation.parentClientRef) ?? null;
      if (parentId !== null && ![...createdIds.values()].includes(parentId)) {
        await requireEntity(db, input.slotId, parentId);
      }
      const entityId = createdIds.get(mutation.clientRef);
      if (entityId === undefined) throw new AppError(500, "invalid_stored_state", "A transaction ID was not allocated.");
      resolved.push({
        mutation,
        current: null,
        logId: newLogId(),
        next: {
          entity_id: entityId,
          slot_id: input.slotId,
          entity_type: mutation.entityType,
          parent_id: parentId,
          name: mutation.name,
          status: mutation.status,
          visibility: mutation.visibility,
          sort_order: mutation.sortOrder,
          revision: 0,
          public_data: canonicalEntityPublic(mutation.entityType, mutation.publicData),
          gm_data: mutation.gmData,
          created_at: now,
          updated_at: now,
        },
      });
      continue;
    }
    if (mutation?.kind !== "update") {
      throw new AppError(400, "invalid_transaction", "Every mutation kind must be create or update.");
    }
    const current = await requireEntity(db, input.slotId, mutation.entityId);
    if (current.revision !== mutation.expectedRevision) {
      throw new AppError(409, "revision_conflict", `Entity ${current.name} changed after it was read.`, {
        retryable: true,
        details: { entity_id: current.entity_id, current_revision: current.revision },
      });
    }
    const next: GameEntity = {
      ...current,
      name: mutation.name ?? current.name,
      status: mutation.status ?? current.status,
      visibility: mutation.visibility ?? current.visibility,
      sort_order: mutation.sortOrder ?? current.sort_order,
      revision: current.revision + 1,
      public_data: mutation.publicData === undefined
        ? current.public_data
        : canonicalEntityPublic(current.entity_type, mutation.publicData),
      gm_data: mutation.gmData ?? current.gm_data,
      updated_at: now,
    };
    resolved.push({ mutation, current, next, logId: newLogId(), guardId: `guard_${crypto.randomUUID()}` });
  }

  const response = {
    ok: true,
    data: {
      entities: resolved.map(({ mutation, next }) => ({
        ...(mutation.kind === "create" ? { client_ref: mutation.clientRef } : {}),
        entity: next,
      })),
    },
  };
  const firstLog = resolved[0]?.logId;
  if (firstLog === undefined) throw new AppError(400, "invalid_transaction", "The transaction is empty.");
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO action_requests (
        action_id, slot_id, operation, request_hash, status, response_json, http_status,
        log_id, event_type, cause, rule_refs_json, created_at
      ) VALUES (?, ?, 'state_transaction', ?, 'processing', ?, 200, ?, 'state_transaction', ?, ?, ?)`,
    ).bind(input.actionId, input.slotId, requestHash, JSON.stringify(response), firstLog, input.cause, RULE_REFS, now),
  ];
  for (const entry of resolved) {
    const { mutation, current, next } = entry;
    if (current === null) {
      statements.push(
        db.prepare(
          `INSERT INTO game_entities (
            entity_id, slot_id, entity_type, parent_id, name, status, visibility, sort_order,
            revision, public_json, gm_json, last_action_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
        ).bind(
          next.entity_id, next.slot_id, next.entity_type, next.parent_id, next.name, next.status,
          next.visibility, next.sort_order, JSON.stringify(next.public_data), JSON.stringify(next.gm_data),
          input.actionId, now, now,
        ),
        db.prepare(
          `INSERT INTO action_logs (
            log_id, action_id, slot_id, target_type, target_id, revision_before, revision_after,
            event_type, cause, rule_refs_json, before_json, after_json, roll_ids_json, public_json, created_at
          ) VALUES (?, ?, ?, ?, ?, NULL, 0, 'entity_created', ?, ?, NULL, ?, '[]', ?, ?)`,
        ).bind(
          entry.logId, input.actionId, input.slotId, next.entity_type, next.entity_id, input.cause,
          RULE_REFS, JSON.stringify({ name: next.name, status: next.status, public_data: next.public_data, gm_data: next.gm_data }),
          JSON.stringify(mutation.publicSummary ?? {}), now,
        ),
      );
      continue;
    }
    statements.push(
      db.prepare(
        `UPDATE game_entities
         SET name = ?, status = ?, visibility = ?, sort_order = ?, revision = revision + 1,
             public_json = ?, gm_json = ?, last_action_id = ?, updated_at = ?
         WHERE slot_id = ? AND entity_id = ? AND revision = ?`,
      ).bind(
        next.name, next.status, next.visibility, next.sort_order, JSON.stringify(next.public_data),
        JSON.stringify(next.gm_data), input.actionId, now, input.slotId, next.entity_id, current.revision,
      ),
      db.prepare(
        `INSERT INTO mutation_guards (guard_id, ok)
         SELECT ?, CASE WHEN EXISTS (
           SELECT 1 FROM game_entities WHERE entity_id = ? AND last_action_id = ? AND revision = ?
         ) THEN 1 ELSE 0 END`,
      ).bind(entry.guardId, next.entity_id, input.actionId, next.revision),
      db.prepare(
        `INSERT INTO action_logs (
          log_id, action_id, slot_id, target_type, target_id, revision_before, revision_after,
          event_type, cause, rule_refs_json, before_json, after_json, roll_ids_json, public_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'entity_updated', ?, ?, ?, ?, '[]', ?, ?)`,
      ).bind(
        entry.logId, input.actionId, input.slotId, next.entity_type, next.entity_id, current.revision,
        next.revision, input.cause, RULE_REFS,
        JSON.stringify({ name: current.name, status: current.status, public_data: current.public_data, gm_data: current.gm_data }),
        JSON.stringify({ name: next.name, status: next.status, public_data: next.public_data, gm_data: next.gm_data }),
        JSON.stringify(mutation.publicSummary ?? {}), now,
      ),
    );
  }
  statements.push(
    db.prepare(`UPDATE action_requests SET status = 'committed', completed_at = ? WHERE action_id = ?`).bind(now, input.actionId),
    ...resolved
      .filter((entry) => entry.guardId !== undefined)
      .map((entry) => db.prepare(`DELETE FROM mutation_guards WHERE guard_id = ?`).bind(entry.guardId)),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    const raced = await replayIfPresent(db, input.actionId, requestHash);
    if (raced !== null) return raced;
    throw error;
  }
  return { status: 200, body: response };
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function rotatePartyAccess(
  db: D1Database,
  input: { actionId: string; slotId: string; cause: string },
): Promise<StoredResponse> {
  await requireSlot(db, input.slotId);
  const requestHash = await hashRequest({ operation: "rotate_party_access", ...input });
  const existing = await getAction(db, input.actionId);
  if (existing !== null) return replayAction(existing, requestHash);
  const token = randomToken();
  const tokenHash = await sha256Hex(token);
  const hint = token.slice(-6);
  const now = new Date().toISOString();
  const logId = newLogId();
  const storedResponse = { ok: true, data: { rotated: true, token_hint: hint } };
  await db.batch([
    db.prepare(
      `INSERT INTO action_requests (
        action_id, slot_id, operation, request_hash, status, response_json, http_status,
        log_id, event_type, cause, rule_refs_json, created_at, completed_at
      ) VALUES (?, ?, 'rotate_party_access', ?, 'committed', ?, 200, ?, 'party_access_rotated', ?, ?, ?, ?)`,
    ).bind(input.actionId, input.slotId, requestHash, JSON.stringify(storedResponse), logId, input.cause, RULE_REFS, now, now),
    db.prepare(
      `INSERT INTO party_access (slot_id, token_hash, token_hint, revision, active, created_at, updated_at)
       VALUES (?, ?, ?, 0, 1, ?, ?)
       ON CONFLICT(slot_id) DO UPDATE SET
         token_hash = excluded.token_hash,
         token_hint = excluded.token_hint,
         revision = party_access.revision + 1,
         active = 1,
         updated_at = excluded.updated_at`,
    ).bind(input.slotId, tokenHash, hint, now, now),
    db.prepare(
      `INSERT INTO action_logs (
        log_id, action_id, slot_id, target_type, target_id, revision_before, revision_after,
        event_type, cause, rule_refs_json, before_json, after_json, roll_ids_json, public_json, created_at
      ) VALUES (?, ?, ?, 'party_access', ?, NULL, 0, 'party_access_rotated', ?, ?, NULL, ?, '[]', '{}', ?)`,
    ).bind(logId, input.actionId, input.slotId, input.slotId, input.cause, RULE_REFS, JSON.stringify({ token_hint: hint }), now),
  ]);
  return { status: 200, body: { ok: true, data: { access_token: token, token_hint: hint } } };
}

interface PublicRollRow {
  public_json: string;
  created_at: string;
}

export async function getPartyViewByToken(db: D1Database, token: string): Promise<Record<string, unknown>> {
  const tokenHash = await sha256Hex(token);
  const access = await db
    .prepare(`SELECT slot_id FROM party_access WHERE token_hash = ? AND active = 1`)
    .bind(tokenHash)
    .first<{ slot_id: string }>();
  if (access === null) throw new AppError(401, "invalid_party_access", "The party access code is invalid.");
  const slot = await requireSlot(db, access.slot_id);
  const entities = await listEntities(db, access.slot_id);
  const visible = entities.filter((entity) => entity.visibility === "public" || entity.visibility === "discovered");
  const characters = visible.filter((entity) => entity.entity_type === "character");
  const items = visible.filter((entity) => entity.entity_type === "item");
  const skills = visible.filter((entity) => entity.entity_type === "skill");
  const characterViews = characters.map((character) => ({
    name: character.name,
    ...character.public_data,
    items: items.filter((item) => item.parent_id === character.entity_id).map((item) => ({ name: item.name, ...item.public_data })),
    skills: skills.filter((skill) => skill.parent_id === character.entity_id).map((skill) => ({ name: skill.name, ...skill.public_data })),
  }));
  const partyEntities = visible
    .filter((entity) => !["character", "item", "skill"].includes(entity.entity_type))
    .map((entity) => ({ type: entity.entity_type, name: entity.name, status: entity.status, ...entity.public_data }));
  const rollResult = await db
    .prepare(
      `SELECT public_json, created_at FROM rolls
       WHERE slot_id = ? AND public_json <> '{}'
       ORDER BY created_at DESC LIMIT 20`,
    )
    .bind(access.slot_id)
    .all<PublicRollRow>();
  const recentRolls = rollResult.results.map((row) => ({
    ...parseStoredObject(row.public_json, "roll.public_json"),
    created_at: row.created_at,
  }));
  return {
    party: { title: slot.title, status: slot.status, updated_at: slot.updated_at },
    characters: characterViews,
    state: partyEntities,
    recent_rolls: recentRolls,
  };
}

export async function completedMissionCount(db: D1Database, slotId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT completed_missions FROM slot_counters WHERE slot_id = ?`)
    .bind(slotId)
    .first<{ completed_missions: number }>();
  return row?.completed_missions ?? 0;
}

export async function maxPartyLevel(db: D1Database, slotId: string): Promise<number> {
  const result = await db
    .prepare(`SELECT public_json FROM game_entities WHERE slot_id = ? AND entity_type = 'character' AND status = 'active'`)
    .bind(slotId)
    .all<{ public_json: string }>();
  let maximum = 1;
  for (const row of result.results) {
    const data = parseStoredObject(row.public_json, "character.public_json");
    if (typeof data.level === "number" && Number.isInteger(data.level)) maximum = Math.max(maximum, data.level);
  }
  return maximum;
}

export async function recordRoll(
  db: D1Database,
  input: {
    actionId: string;
    slotId: string;
    operation: string;
    resolutionType: string;
    diceExpression: string;
    lockedContext: Record<string, unknown>;
    rawResults: Record<string, unknown>;
    outcome: Record<string, unknown>;
    publicResult: Record<string, unknown>;
    gmResult?: Record<string, unknown>;
    visibility: "public" | "hidden";
    cause: string;
  },
): Promise<StoredResponse> {
  await requireSlot(db, input.slotId);
  const requestHash = await hashRequest({ ...input, rawResults: undefined, outcome: undefined, gmResult: undefined });
  const replay = await replayIfPresent(db, input.actionId, requestHash);
  if (replay !== null) return replay;
  const rollId = `roll_${crypto.randomUUID()}`;
  const logId = newLogId();
  const now = new Date().toISOString();
  const response = {
    ok: true,
    data: {
      roll: input.publicResult,
      ...(input.gmResult === undefined ? {} : { gm_result: input.gmResult }),
    },
  };
  await db.batch([
    db.prepare(
      `INSERT INTO action_requests (
        action_id, slot_id, operation, request_hash, status, response_json, http_status,
        log_id, event_type, cause, rule_refs_json, created_at, completed_at
      ) VALUES (?, ?, ?, ?, 'committed', ?, 200, ?, 'roll_resolved', ?, ?, ?, ?)`,
    ).bind(input.actionId, input.slotId, input.operation, requestHash, JSON.stringify(response), logId, input.cause, RULE_REFS, now, now),
    db.prepare(
      `INSERT INTO rolls (
        roll_id, slot_id, action_id, resolution_type, dice_expression, locked_context_json,
        raw_results_json, outcome_json, rng_method, visibility, public_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'web_crypto_rejection_sampling', ?, ?, ?)`,
    ).bind(
      rollId, input.slotId, input.actionId, input.resolutionType, input.diceExpression,
      JSON.stringify(input.lockedContext), JSON.stringify(input.rawResults), JSON.stringify(input.outcome),
      input.visibility, JSON.stringify(input.publicResult), now,
    ),
    db.prepare(
      `INSERT INTO action_logs (
        log_id, action_id, slot_id, target_type, target_id, revision_before, revision_after,
        event_type, cause, rule_refs_json, before_json, after_json, roll_ids_json, public_json, created_at
      ) VALUES (?, ?, ?, 'roll', ?, NULL, 0, 'roll_resolved', ?, ?, NULL, ?, ?, ?, ?)`,
    ).bind(
      logId, input.actionId, input.slotId, rollId, input.cause, RULE_REFS,
      JSON.stringify({ locked_context: input.lockedContext, raw_results: input.rawResults, outcome: input.outcome }),
      JSON.stringify([rollId]), JSON.stringify(input.publicResult), now,
    ),
  ]);
  return { status: 200, body: response };
}

export async function completeMission(
  db: D1Database,
  input: {
    actionId: string;
    slotId: string;
    missionId: string;
    missionExpectedRevision: number;
    danger: number;
    characterRevisions: Array<{ entityId: string; expectedRevision: number }>;
    cause: string;
    levelGain: number;
  },
): Promise<StoredResponse> {
  const requestHash = await hashRequest({ operation: "complete_mission", ...input });
  const replay = await replayIfPresent(db, input.actionId, requestHash);
  if (replay !== null) return replay;
  const mission = await requireEntity(db, input.slotId, input.missionId, "mission");
  if (mission.revision !== input.missionExpectedRevision) {
    throw new AppError(409, "revision_conflict", "The mission changed after it was read.");
  }
  if (mission.status === "completed") throw new AppError(409, "mission_already_completed", "The mission is already complete.");
  const characters: GameEntity[] = [];
  for (const target of input.characterRevisions) {
    const character = await requireEntity(db, input.slotId, target.entityId, "character");
    if (character.revision !== target.expectedRevision) {
      throw new AppError(409, "revision_conflict", `Character ${character.name} changed after it was read.`);
    }
    characters.push(character);
  }
  if (characters.length === 0) throw new AppError(400, "invalid_request", "At least one participant is required.");
  const now = new Date().toISOString();
  const missionLogId = newLogId();
  const responseCharacters = characters.map((character) => {
    const currentLevel = typeof character.public_data.level === "number" ? character.public_data.level : 1;
    const nextPublic = canonicalCharacterPublic({
      ...character.public_data,
      level: Math.min(99, currentLevel + input.levelGain),
    });
    return { character, nextPublic };
  });
  const response = {
    ok: true,
    data: {
      mission: { entity_id: mission.entity_id, status: "completed", revision: mission.revision + 1 },
      characters: responseCharacters.map(({ character, nextPublic }) => ({
        entity_id: character.entity_id,
        name: character.name,
        revision: character.revision + 1,
        level: nextPublic.level,
        rank: nextPublic.rank,
        stats: nextPublic.stats,
      })),
      level_gain: input.levelGain,
    },
  };
  const statements: D1PreparedStatement[] = [
    db.prepare(
      `INSERT INTO action_requests (
        action_id, slot_id, operation, request_hash, status, response_json, http_status,
        log_id, event_type, cause, rule_refs_json, target_revision, created_at
      ) VALUES (?, ?, 'complete_mission', ?, 'processing', ?, 200, ?, 'mission_completed', ?, ?, ?, ?)`,
    ).bind(
      input.actionId, input.slotId, requestHash, JSON.stringify(response), missionLogId, input.cause,
      RULE_REFS, mission.revision + 1, now,
    ),
    db.prepare(
      `UPDATE game_entities SET status = 'completed', revision = revision + 1,
        public_json = json_set(public_json, '$.completion_status', 'completed'),
        last_action_id = ?, updated_at = ?
       WHERE entity_id = ? AND slot_id = ? AND revision = ?`,
    ).bind(input.actionId, now, mission.entity_id, input.slotId, mission.revision),
  ];
  const missionGuard = `guard_${crypto.randomUUID()}`;
  statements.push(
    db.prepare(
      `INSERT INTO mutation_guards (guard_id, ok)
       SELECT ?, CASE WHEN EXISTS (
         SELECT 1 FROM game_entities WHERE entity_id = ? AND last_action_id = ? AND revision = ?
       ) THEN 1 ELSE 0 END`,
    ).bind(missionGuard, mission.entity_id, input.actionId, mission.revision + 1),
    db.prepare(
      `INSERT INTO action_logs (
        log_id, action_id, slot_id, target_type, target_id, revision_before, revision_after,
        event_type, cause, rule_refs_json, before_json, after_json, roll_ids_json, public_json, created_at
      ) VALUES (?, ?, ?, 'mission', ?, ?, ?, 'mission_completed', ?, ?, ?, ?, '[]', ?, ?)`,
    ).bind(
      missionLogId, input.actionId, input.slotId, mission.entity_id, mission.revision,
      mission.revision + 1, input.cause, RULE_REFS, JSON.stringify({ status: mission.status }),
      JSON.stringify({ status: "completed" }), JSON.stringify({ event: "임무 완료", mission: mission.name }), now,
    ),
  );
  for (const { character, nextPublic } of responseCharacters) {
    const guardId = `guard_${crypto.randomUUID()}`;
    const logId = newLogId();
    statements.push(
      db.prepare(
        `UPDATE game_entities SET revision = revision + 1, public_json = ?, last_action_id = ?, updated_at = ?
         WHERE entity_id = ? AND slot_id = ? AND revision = ?`,
      ).bind(JSON.stringify(nextPublic), input.actionId, now, character.entity_id, input.slotId, character.revision),
      db.prepare(
        `INSERT INTO mutation_guards (guard_id, ok)
         SELECT ?, CASE WHEN EXISTS (
           SELECT 1 FROM game_entities WHERE entity_id = ? AND last_action_id = ? AND revision = ?
         ) THEN 1 ELSE 0 END`,
      ).bind(guardId, character.entity_id, input.actionId, character.revision + 1),
      db.prepare(
        `INSERT INTO action_logs (
          log_id, action_id, slot_id, target_type, target_id, revision_before, revision_after,
          event_type, cause, rule_refs_json, before_json, after_json, roll_ids_json, public_json, created_at
        ) VALUES (?, ?, ?, 'character', ?, ?, ?, 'character_leveled', ?, ?, ?, ?, '[]', ?, ?)`,
      ).bind(
        logId, input.actionId, input.slotId, character.entity_id, character.revision,
        character.revision + 1, input.cause, RULE_REFS,
        JSON.stringify({ level: character.public_data.level, rank: character.public_data.rank, stats: character.public_data.stats }),
        JSON.stringify({ level: nextPublic.level, rank: nextPublic.rank, stats: nextPublic.stats }),
        JSON.stringify({ event: "레벨 상승", character: character.name, level: nextPublic.level, rank: nextPublic.rank }), now,
      ),
      db.prepare(`DELETE FROM mutation_guards WHERE guard_id = ?`).bind(guardId),
    );
  }
  statements.push(
    db.prepare(`UPDATE slot_counters SET completed_missions = completed_missions + 1 WHERE slot_id = ?`).bind(input.slotId),
    db.prepare(`UPDATE action_requests SET status = 'committed', completed_at = ? WHERE action_id = ?`).bind(now, input.actionId),
    db.prepare(`DELETE FROM mutation_guards WHERE guard_id = ?`).bind(missionGuard),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    const raced = await replayIfPresent(db, input.actionId, requestHash);
    if (raced !== null) return raced;
    throw error;
  }
  return { status: 200, body: response };
}
