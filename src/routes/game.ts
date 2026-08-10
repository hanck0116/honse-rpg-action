import { AppError } from "../domain/errors";
import {
  BOX_CATEGORY_TABLE,
  BOX_ROLL_COUNT,
  coinRoll,
  CONSUMABLES,
  contentGrade,
  difficultyStrength,
  DROP_CHANCE,
  effectiveStat,
  EQUIPMENT,
  levelGainForDanger,
  lowerGrade,
  MATERIALS,
  opposedStrength,
  optionalInteger,
  optionalObject,
  parseEntityType,
  parseGrade,
  parseStatKey,
  parseVisibility,
  randomDie,
  requireArray,
  requireBoolean,
  requireEnum,
  requireInteger,
  requireObject,
  RUNES,
  validateMissionBoard,
  type EntityStatus,
  type Grade,
} from "../domain/game";
import { assertActionId, assertSlotId } from "../domain/ids";
import {
  optionalString,
  readJsonObject,
  requireRevision,
  requireString,
} from "../domain/validation";
import { jsonResponse, storedResponse } from "../http";
import {
  applyStateTransaction,
  completeMission,
  completedMissionCount,
  createEntity,
  findEntity,
  getPartyViewByToken,
  listEntities,
  maxPartyLevel,
  recordRoll,
  requireEntity,
  rotatePartyAccess,
  updateEntity,
  type StateMutation,
} from "../repositories/game";

const ENTITY_STATUSES: readonly EntityStatus[] = [
  "active", "inactive", "accepted", "completed", "failed", "paused",
  "archived", "replaced", "consumed", "destroyed",
];

function actionId(body: Record<string, unknown>): string {
  const value = requireString(body, "action_id", { min: 8, max: 128 });
  assertActionId(value);
  return value;
}

function cause(body: Record<string, unknown>, fallback: string): string {
  return optionalString(body, "cause", 240) ?? fallback;
}

function parseStatus(value: unknown, fallback: EntityStatus): EntityStatus {
  return value === undefined ? fallback : requireEnum(value, "status", ENTITY_STATUSES);
}

function modifiers(value: unknown): Array<{ label: string; amount: number }> {
  if (value === undefined) return [];
  return requireArray(value, "modifiers", 30).map((raw, index) => {
    const row = requireObject(raw, `modifiers[${index}]`);
    return {
      label: requireString(row, "label", { min: 1, max: 80 }),
      amount: requireInteger(row.amount, `modifiers[${index}].amount`, -999, 999),
    };
  });
}

async function createGenericEntity(
  request: Request,
  env: Env,
  slotId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  const entityType = parseEntityType(body.entity_type);
  const parentId = body.parent_id === undefined || body.parent_id === null
    ? null
    : requireString(body, "parent_id", { min: 8, max: 100 });
  return storedResponse(await createEntity(env.DB, {
    actionId: actionId(body),
    slotId,
    entityType,
    parentId,
    name: requireString(body, "name", { min: 1, max: 120 }),
    status: parseStatus(body.status, entityType === "mission" ? "accepted" : "active"),
    visibility: parseVisibility(body.visibility),
    sortOrder: optionalInteger(body.sort_order, "sort_order", -10_000, 10_000, 0),
    publicData: optionalObject(body.public_data, "public_data"),
    gmData: optionalObject(body.gm_data, "gm_data"),
    cause: cause(body, `${entityType} 생성`),
    publicSummary: optionalObject(body.public_summary, "public_summary"),
  }));
}

async function patchGenericEntity(
  request: Request,
  env: Env,
  slotId: string,
  entityId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  return storedResponse(await updateEntity(env.DB, {
    actionId: actionId(body),
    slotId,
    entityId,
    expectedRevision: requireRevision(body),
    ...(body.name === undefined ? {} : { name: requireString(body, "name", { min: 1, max: 120 }) }),
    ...(body.status === undefined ? {} : { status: parseStatus(body.status, "active") }),
    ...(body.visibility === undefined ? {} : { visibility: parseVisibility(body.visibility) }),
    ...(body.sort_order === undefined
      ? {}
      : { sortOrder: requireInteger(body.sort_order, "sort_order", -10_000, 10_000) }),
    ...(body.public_data === undefined ? {} : { publicData: requireObject(body.public_data, "public_data") }),
    ...(body.gm_data === undefined ? {} : { gmData: requireObject(body.gm_data, "gm_data") }),
    cause: cause(body, "확정 상태 갱신"),
    publicSummary: optionalObject(body.public_summary, "public_summary"),
  }));
}

async function commitStateTransaction(request: Request, env: Env, slotId: string): Promise<Response> {
  const body = await readJsonObject(request);
  const mutations: StateMutation[] = requireArray(body.mutations, "mutations", 40).map((raw, index) => {
    const row = requireObject(raw, `mutations[${index}]`);
    const kind = requireEnum(row.kind, `mutations[${index}].kind`, ["create", "update"] as const);
    const publicSummary = row.public_summary === undefined
      ? undefined
      : requireObject(row.public_summary, `mutations[${index}].public_summary`);
    if (kind === "create") {
      const parentId = row.parent_id === undefined || row.parent_id === null
        ? null
        : requireString(row, "parent_id", { min: 8, max: 100 });
      const parentClientRef = row.parent_client_ref === undefined
        ? undefined
        : requireString(row, "parent_client_ref", { min: 1, max: 80 });
      if (parentId !== null && parentClientRef !== undefined) {
        throw new AppError(400, "invalid_transaction", "Use either parent_id or parent_client_ref, not both.");
      }
      return {
        kind: "create",
        clientRef: requireString(row, "client_ref", { min: 1, max: 80 }),
        entityType: parseEntityType(row.entity_type),
        parentId,
        ...(parentClientRef === undefined ? {} : { parentClientRef }),
        name: requireString(row, "name", { min: 1, max: 120 }),
        status: parseStatus(row.status, "active"),
        visibility: parseVisibility(row.visibility),
        sortOrder: optionalInteger(row.sort_order, `mutations[${index}].sort_order`, -10_000, 10_000, 0),
        publicData: optionalObject(row.public_data, `mutations[${index}].public_data`),
        gmData: optionalObject(row.gm_data, `mutations[${index}].gm_data`),
        ...(publicSummary === undefined ? {} : { publicSummary }),
      };
    }
    return {
      kind: "update",
      entityId: requireString(row, "entity_id", { min: 8, max: 100 }),
      expectedRevision: requireInteger(row.expected_revision, `mutations[${index}].expected_revision`, 0, 1_000_000),
      ...(row.name === undefined ? {} : { name: requireString(row, "name", { min: 1, max: 120 }) }),
      ...(row.status === undefined ? {} : { status: parseStatus(row.status, "active") }),
      ...(row.visibility === undefined ? {} : { visibility: parseVisibility(row.visibility) }),
      ...(row.sort_order === undefined
        ? {}
        : { sortOrder: requireInteger(row.sort_order, `mutations[${index}].sort_order`, -10_000, 10_000) }),
      ...(row.public_data === undefined
        ? {}
        : { publicData: requireObject(row.public_data, `mutations[${index}].public_data`) }),
      ...(row.gm_data === undefined
        ? {}
        : { gmData: requireObject(row.gm_data, `mutations[${index}].gm_data`) }),
      ...(publicSummary === undefined ? {} : { publicSummary }),
    };
  });
  return storedResponse(await applyStateTransaction(env.DB, {
    actionId: actionId(body),
    slotId,
    cause: cause(body, "규칙 결과 일괄 저장"),
    mutations,
  }));
}

async function resolveTableRoll(request: Request, env: Env, slotId: string): Promise<Response> {
  const body = await readJsonObject(request);
  const purpose = requireString(body, "purpose", { min: 1, max: 160 });
  const hidden = body.hidden === undefined ? false : requireBoolean(body.hidden, "hidden");
  const requested = requireArray(body.rolls, "rolls", 20);
  if (requested.length === 0) throw new AppError(400, "invalid_request", "At least one die is required.");
  const internalResults = requested.map((raw, index) => {
    const row = requireObject(raw, `rolls[${index}]`);
    const label = requireString(row, "label", { min: 1, max: 80 });
    const sides = requireInteger(row.sides, `rolls[${index}].sides`, 1, 1_000_000);
    const options = row.options === undefined ? undefined : requireArray(row.options, `rolls[${index}].options`, 200);
    if (options !== undefined && options.length !== sides) {
      throw new AppError(400, "invalid_request", `rolls[${index}].options must have exactly ${sides} entries.`);
    }
    const result = randomDie(sides);
    return {
      label,
      die: `1d${sides}`,
      raw_result: result,
      ...(options === undefined ? {} : { selected: options[result - 1] }),
    };
  });
  const publicRolls = hidden
    ? internalResults.map((result, index) => ({
        label: `비공개 굴림 ${index + 1}`,
        die: result.die,
        raw_result: result.raw_result,
        result: result.selected === undefined ? "원시 결과 확정" : "비공개 표 항목 확정",
      }))
    : internalResults;
  const publicResult = {
    type: hidden ? "숨은 표 판정" : "표 판정",
    purpose: hidden ? "아직 공개되지 않은 판정" : purpose,
    rolls: publicRolls,
  };
  return storedResponse(await recordRoll(env.DB, {
    actionId: actionId(body),
    slotId,
    operation: "table_roll",
    resolutionType: "table",
    diceExpression: internalResults.map((result) => result.die).join(" + "),
    lockedContext: { purpose, requested },
    rawResults: { rolls: internalResults },
    outcome: { rolls: internalResults },
    publicResult,
    ...(hidden ? { gmResult: { purpose, rolls: internalResults } } : {}),
    visibility: hidden ? "hidden" : "public",
    cause: cause(body, purpose),
  }));
}

async function resolveDifficulty(request: Request, env: Env, slotId: string): Promise<Response> {
  const body = await readJsonObject(request);
  const characterId = requireString(body, "character_id", { min: 8, max: 100 });
  const character = await requireEntity(env.DB, slotId, characterId, "character");
  const stat = parseStatKey(body.stat);
  const applied = modifiers(body.modifiers);
  const base = effectiveStat(character.public_data, stat);
  const modifierTotal = applied.reduce((sum, entry) => sum + entry.amount, 0);
  const finalEffective = Math.max(1, base + modifierTotal);
  const difficulty = requireInteger(body.difficulty, "difficulty", 1, 100_000);
  const result = randomDie(difficulty);
  const success = result <= finalEffective;
  const delta = Math.abs(finalEffective - result);
  const strength = success && result === 1 ? "압도적 성공" : difficultyStrength(delta, success);
  const purpose = requireString(body, "purpose", { min: 1, max: 160 });
  const hidden = body.hidden === undefined ? false : requireBoolean(body.hidden, "hidden");
  const publicResult = hidden
    ? {
        type: "숨은 난이도 판정",
        purpose: "아직 공개되지 않은 판정",
        die: `1d${difficulty}`,
        raw_result: result,
        comparison: `${result} ${success ? "≤" : ">"} ${finalEffective}`,
        delta,
        outcome: strength,
      }
    : {
        type: "난이도 판정",
        purpose,
        actor: character.name,
        stat,
        base_effective: base,
        modifiers: applied,
        final_effective: finalEffective,
        die: `1d${difficulty}`,
        raw_result: result,
        comparison: `${result} ${success ? "≤" : ">"} ${finalEffective}`,
        delta,
        outcome: strength,
      };
  return storedResponse(await recordRoll(env.DB, {
    actionId: actionId(body),
    slotId,
    operation: "difficulty_roll",
    resolutionType: "difficulty",
    diceExpression: `1d${difficulty}`,
    lockedContext: { purpose, actor_id: characterId, actor_name: character.name, stat, base, modifiers: applied, final_effective: finalEffective, difficulty },
    rawResults: { result },
    outcome: { success, delta, strength },
    publicResult,
    visibility: hidden ? "hidden" : "public",
    cause: cause(body, purpose),
  }));
}

async function resolveOpposed(request: Request, env: Env, slotId: string): Promise<Response> {
  const body = await readJsonObject(request);
  const actorInput = requireObject(body.actor, "actor");
  const targetInput = requireObject(body.target, "target");
  const actor = await requireEntity(
    env.DB,
    slotId,
    requireString(actorInput, "entity_id", { min: 8, max: 100 }),
  );
  const target = await requireEntity(
    env.DB,
    slotId,
    requireString(targetInput, "entity_id", { min: 8, max: 100 }),
  );
  const actorStat = parseStatKey(actorInput.stat, "actor.stat");
  const targetStat = parseStatKey(targetInput.stat, "target.stat");
  const actorMods = modifiers(actorInput.modifiers);
  const targetMods = modifiers(targetInput.modifiers);
  const actorBase = effectiveStat(actor.public_data, actorStat);
  const targetBase = effectiveStat(target.public_data, targetStat);
  const actorEffective = Math.max(1, actorBase + actorMods.reduce((sum, item) => sum + item.amount, 0));
  const targetEffective = Math.max(1, targetBase + targetMods.reduce((sum, item) => sum + item.amount, 0));
  const actorRoll = randomDie(actorEffective);
  const targetRoll = randomDie(targetEffective);
  let winner: "actor" | "target" | "draw";
  if (actorRoll !== targetRoll) winner = actorRoll > targetRoll ? "actor" : "target";
  else if (actorEffective !== targetEffective) winner = actorEffective > targetEffective ? "actor" : "target";
  else winner = "draw";
  const delta = Math.abs(actorRoll - targetRoll);
  const strength = winner === "draw" ? "완전 동률" : opposedStrength(delta);
  const purpose = requireString(body, "purpose", { min: 1, max: 160 });
  const hidden = body.hidden === undefined ? false : requireBoolean(body.hidden, "hidden");
  const publicResult = hidden
    ? {
        type: "숨은 상대 판정",
        purpose: "아직 공개되지 않은 판정",
        actor_die: `1d${actorEffective}`,
        actor_raw_result: actorRoll,
        target_die: `1d${targetEffective}`,
        target_raw_result: targetRoll,
        delta,
        outcome: winner === "draw" ? "무승부" : strength,
      }
    : {
        type: "상대 판정",
        purpose,
        actor: { name: actor.name, stat: actorStat, base_effective: actorBase, modifiers: actorMods, effective: actorEffective, die: `1d${actorEffective}`, raw_result: actorRoll },
        target: { name: target.name, stat: targetStat, base_effective: targetBase, modifiers: targetMods, effective: targetEffective, die: `1d${targetEffective}`, raw_result: targetRoll },
        comparison: `${actorRoll} 대 ${targetRoll}`,
        delta,
        winner: winner === "actor" ? actor.name : winner === "target" ? target.name : "무승부",
        outcome: strength,
      };
  return storedResponse(await recordRoll(env.DB, {
    actionId: actionId(body),
    slotId,
    operation: "opposed_roll",
    resolutionType: "opposed",
    diceExpression: `1d${actorEffective} vs 1d${targetEffective}`,
    lockedContext: {
      purpose,
      actor: { id: actor.entity_id, name: actor.name, stat: actorStat, base: actorBase, modifiers: actorMods, effective: actorEffective },
      target: { id: target.entity_id, name: target.name, stat: targetStat, base: targetBase, modifiers: targetMods, effective: targetEffective },
    },
    rawResults: { actor: actorRoll, target: targetRoll },
    outcome: { winner, delta, strength },
    publicResult,
    visibility: hidden ? "hidden" : "public",
    cause: cause(body, purpose),
  }));
}

async function createMissionBoard(request: Request, env: Env, slotId: string): Promise<Response> {
  const body = await readJsonObject(request);
  const [completed, maxLevel] = await Promise.all([
    completedMissionCount(env.DB, slotId),
    maxPartyLevel(env.DB, slotId),
  ]);
  const earlyProtection = completed < 3 || maxLevel <= 5;
  const board = validateMissionBoard(body.rank, body.missions, earlyProtection);
  return storedResponse(await createEntity(env.DB, {
    actionId: actionId(body),
    slotId,
    entityType: "mission_board",
    parentId: null,
    name: `${board.rank}급 임무 게시판`,
    status: "active",
    visibility: "public",
    sortOrder: 0,
    publicData: {
      rank: board.rank,
      early_protection: earlyProtection,
      missions: board.missions.map((mission) => ({ key: mission.key, ...mission.public })),
    },
    gmData: {
      generated_at: new Date().toISOString(),
      missions: board.missions,
      immutable: true,
    },
    cause: cause(body, `${board.rank}급 임무 게시판 생성`),
    publicSummary: { event: "임무 게시판 생성", rank: board.rank, count: 10 },
  }));
}

async function acceptMission(request: Request, env: Env, slotId: string): Promise<Response> {
  const body = await readJsonObject(request);
  const board = await requireEntity(
    env.DB,
    slotId,
    requireString(body, "board_id", { min: 8, max: 100 }),
    "mission_board",
  );
  const missionKey = requireString(body, "mission_key", { min: 3, max: 80 });
  const gmMissions = requireArray(board.gm_data.missions, "board.gm_data.missions", 10);
  const selected = gmMissions.find((raw) => {
    if (!requireObject(raw, "mission").key) return false;
    return requireObject(raw, "mission").key === missionKey;
  });
  if (selected === undefined) throw new AppError(404, "mission_not_found", "The mission is not on this board.");
  const mission = requireObject(selected, "mission");
  const publicData = requireObject(mission.public, "mission.public");
  const gmData = requireObject(mission.gm, "mission.gm");
  const participants = requireArray(body.character_ids, "character_ids", 8).map((raw, index) => {
    if (typeof raw !== "string") {
      throw new AppError(400, "invalid_request", `character_ids[${index}] must be a character ID.`);
    }
    return raw;
  });
  if (participants.length === 0) throw new AppError(400, "invalid_request", "At least one participant is required.");
  if (new Set(participants).size !== participants.length) {
    throw new AppError(400, "invalid_request", "A character cannot be listed twice.");
  }
  const missionRank = parseGrade(publicData.rank, "mission.rank");
  for (let index = 0; index < participants.length; index += 1) {
    const rawId = participants[index];
    const id = typeof rawId === "string" ? rawId : "";
    const character = await requireEntity(env.DB, slotId, id, "character");
    if (character.public_data.rank !== missionRank) {
      throw new AppError(400, "rank_mismatch", "Every participant rank must exactly match the mission rank.");
    }
  }
  return storedResponse(await createEntity(env.DB, {
    actionId: actionId(body),
    slotId,
    entityType: "mission",
    parentId: board.entity_id,
    name: typeof publicData.title === "string" ? publicData.title : "임무",
    status: "accepted",
    visibility: "public",
    sortOrder: 0,
    publicData: { ...publicData, progress: { stage: 0, discovered: [], status: "accepted" } },
    gmData: { immutable_snapshot: gmData, participant_ids: participants, accepted_from: { board_id: board.entity_id, mission_key: missionKey } },
    cause: cause(body, "임무 수락 및 불변 스냅샷 잠금"),
    publicSummary: { event: "임무 수락", title: publicData.title, rank: missionRank, danger: publicData.danger },
  }));
}

async function finishMission(
  request: Request,
  env: Env,
  slotId: string,
  missionId: string,
): Promise<Response> {
  const body = await readJsonObject(request);
  const mission = await requireEntity(env.DB, slotId, missionId, "mission");
  const danger = requireInteger(mission.public_data.danger, "mission.public_data.danger", 1, 10);
  const lockedParticipants = requireArray(
    mission.gm_data.participant_ids,
    "mission.gm_data.participant_ids",
    8,
  ).map((raw, index) => {
    if (typeof raw !== "string") {
      throw new AppError(500, "invalid_stored_state", `mission participant ${index} is invalid.`);
    }
    return raw;
  });
  const participants = requireArray(body.characters, "characters", 8).map((raw, index) => {
    const row = requireObject(raw, `characters[${index}]`);
    return {
      entityId: requireString(row, "entity_id", { min: 8, max: 100 }),
      expectedRevision: requireInteger(row.expected_revision, `characters[${index}].expected_revision`, 0, 1_000_000),
    };
  });
  const submittedIds = participants.map((participant) => participant.entityId);
  if (
    new Set(submittedIds).size !== submittedIds.length
    || submittedIds.length !== lockedParticipants.length
    || submittedIds.some((id) => !lockedParticipants.includes(id))
  ) {
    throw new AppError(400, "participant_mismatch", "Mission completion must update exactly the participants locked at acceptance.");
  }
  return storedResponse(await completeMission(env.DB, {
    actionId: actionId(body),
    slotId,
    missionId,
    missionExpectedRevision: requireRevision(body),
    danger,
    characterRevisions: participants,
    cause: cause(body, "임무 성공·레벨 상승·자동 승급"),
    levelGain: levelGainForDanger(danger),
  }));
}

function rankFromEntity(entity: Awaited<ReturnType<typeof requireEntity>>): Grade {
  const value = entity.public_data.rank ?? entity.gm_data.rank ?? entity.public_data.grade;
  return parseGrade(value, "entity rank");
}

async function resolveDrop(request: Request, env: Env, slotId: string): Promise<Response> {
  const body = await readJsonObject(request);
  const source = await requireEntity(
    env.DB,
    slotId,
    requireString(body, "source_entity_id", { min: 8, max: 100 }),
  );
  if (source.entity_type !== "monster" && source.entity_type !== "named") {
    throw new AppError(400, "invalid_drop_source", "Drops can only be resolved for a monster or named entity.");
  }
  const recovered = requireBoolean(body.recovered, "recovered");
  const grade = rankFromEntity(source);
  let publicResult: Record<string, unknown>;
  let rawResults: Record<string, unknown>;
  if (!recovered) {
    publicResult = { type: "드롭 판정", source: source.name, recovered: false, result: "회수 조건 미충족" };
    rawResults = {};
  } else if (source.entity_type === "named") {
    const dropTable = requireObject(source.gm_data.drop_table, "named.gm_data.drop_table");
    const item = requireObject(dropTable.named_item, "drop_table.named_item");
    publicResult = {
      type: "네임드 드롭",
      source: source.name,
      die: "판정 없음",
      result: "고정 회수 조건 충족",
      item: { name: item.name, grade: item.grade },
    };
    rawResults = {};
  } else {
    const risk = requireInteger(body.scene_risk, "scene_risk", 1, 10);
    const chance = DROP_CHANCE[risk] ?? 20;
    const roll = randomDie(100);
    const success = roll <= chance;
    const boxGrade = success ? grade : lowerGrade(grade);
    publicResult = {
      type: "일반 몬스터 드롭",
      source: source.name,
      die: "1d100",
      raw_result: roll,
      comparison: `${roll} ${success ? "≤" : ">"} ${chance}`,
      result: success ? "같은 급수 랜덤 박스" : "보장 랜덤 박스",
      item: { name: "랜덤 박스", grade: boxGrade, content_table_revision: "2026-07-16" },
    };
    rawResults = { probability_roll: roll };
  }
  return storedResponse(await recordRoll(env.DB, {
    actionId: actionId(body),
    slotId,
    operation: "resolve_drop",
    resolutionType: "drop",
    diceExpression: source.entity_type === "monster" && recovered ? "1d100" : "none",
    lockedContext: { source_id: source.entity_id, source_type: source.entity_type, grade, recovered, drop_table: source.gm_data.drop_table ?? null },
    rawResults,
    outcome: publicResult,
    publicResult,
    visibility: "public",
    cause: cause(body, "최초 고정 드롭표 판정"),
  }));
}

function boxCategory(roll: number, grade: Grade): "consumable" | "material" | "equipment" | "rune" | "coin" {
  const row = BOX_CATEGORY_TABLE[grade];
  if (roll <= row[0]) return "consumable";
  if (roll <= row[1]) return "material";
  if (roll <= row[2]) return "equipment";
  if (roll <= row[3]) return "rune";
  return "coin";
}

async function openRandomBox(request: Request, env: Env, slotId: string): Promise<Response> {
  const body = await readJsonObject(request);
  const box = await requireEntity(
    env.DB,
    slotId,
    requireString(body, "box_entity_id", { min: 8, max: 100 }),
    "item",
  );
  if (box.public_data.category !== "랜덤 박스" || box.name !== "랜덤 박스" || box.status !== "active") {
    throw new AppError(400, "invalid_random_box", "The item is not an unopened random box.");
  }
  const grade = parseGrade(box.public_data.grade, "box grade");
  const outputGrade = contentGrade(grade);
  const results: Array<Record<string, unknown>> = [];
  const rawRolls: Array<Record<string, unknown>> = [];
  for (let index = 0; index < BOX_ROLL_COUNT[grade]; index += 1) {
    const categoryRoll = randomDie(100);
    const category = boxCategory(categoryRoll, grade);
    if (category === "coin") {
      const coin = coinRoll(grade);
      const detailRoll = randomDie(coin.sides);
      results.push({ category: "코인", quantity: detailRoll + coin.add, grade: outputGrade });
      rawRolls.push({ category: categoryRoll, detail_die: `1d${coin.sides}+${coin.add}`, detail: detailRoll });
      continue;
    }
    const list = category === "consumable" ? CONSUMABLES
      : category === "material" ? MATERIALS
      : category === "equipment" ? EQUIPMENT
      : RUNES;
    const detailRoll = randomDie(list.length);
    results.push({
      category: category === "consumable" ? "소모품" : category === "material" ? "재료" : category === "equipment" ? "일반 장비" : "룬",
      name: list[detailRoll - 1],
      grade: outputGrade,
      item_skill: "none",
    });
    rawRolls.push({ category: categoryRoll, detail_die: `1d${list.length}`, detail: detailRoll });
  }
  const publicResult = {
    type: "랜덤 박스 개봉",
    box: { name: "랜덤 박스", grade, content_table_revision: box.public_data.content_table_revision ?? "2026-07-16" },
    rolls: rawRolls,
    contents: results,
    instruction: "이 결과를 인벤토리에 저장한 뒤 박스를 consumed 상태로 변경해야 합니다.",
  };
  return storedResponse(await recordRoll(env.DB, {
    actionId: actionId(body),
    slotId,
    operation: "open_random_box",
    resolutionType: "random_box",
    diceExpression: `${BOX_ROLL_COUNT[grade]}x(1d100 + category die)`,
    lockedContext: { box_id: box.entity_id, grade, content_table_revision: box.public_data.content_table_revision ?? "2026-07-16" },
    rawResults: { rolls: rawRolls },
    outcome: { contents: results },
    publicResult,
    visibility: "public",
    cause: cause(body, "랜덤 박스 고정표 개봉"),
  }));
}

export async function handlePublicPartyRoute(request: Request, env: Env): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });
  if (request.method !== "GET") throw new AppError(405, "method_not_allowed", "Use GET for the party view.");
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (token.length < 32 || token.length > 256) throw new AppError(401, "invalid_party_access", "A party access code is required.");
  return jsonResponse({ ok: true, data: await getPartyViewByToken(env.DB, token) });
}

export async function handleGameRoute(
  request: Request,
  env: Env,
  parts: string[],
  url: URL,
): Promise<Response> {
  const slotId = parts[2] ?? "";
  assertSlotId(slotId);
  if (parts[3] === "entities") {
    if (parts.length === 4 && request.method === "GET") {
      const typeValue = url.searchParams.get("type");
      const type = typeValue === null ? undefined : parseEntityType(typeValue);
      const includeArchived = url.searchParams.get("include_archived") === "true";
      return jsonResponse({ ok: true, data: { entities: await listEntities(env.DB, slotId, { ...(type === undefined ? {} : { type }), includeArchived }) } });
    }
    if (parts.length === 4 && request.method === "POST") return createGenericEntity(request, env, slotId);
    const entityId = parts[4];
    if (parts.length === 5 && entityId !== undefined && request.method === "GET") {
      const entity = await findEntity(env.DB, slotId, entityId);
      if (entity === null) throw new AppError(404, "entity_not_found", "The state entity does not exist.");
      return jsonResponse({ ok: true, data: { entity } });
    }
    if (parts.length === 5 && entityId !== undefined && request.method === "PATCH") {
      return patchGenericEntity(request, env, slotId, entityId);
    }
  }
  if (parts[3] === "party-access" && parts[4] === "rotate" && request.method === "POST") {
    const body = await readJsonObject(request);
    return storedResponse(await rotatePartyAccess(env.DB, { actionId: actionId(body), slotId, cause: cause(body, "파티 읽기 전용 접근 코드 교체") }));
  }
  if (parts[3] === "transactions" && parts.length === 4 && request.method === "POST") {
    return commitStateTransaction(request, env, slotId);
  }
  if (parts[3] === "rolls" && parts[4] === "difficulty" && request.method === "POST") {
    return resolveDifficulty(request, env, slotId);
  }
  if (parts[3] === "rolls" && parts[4] === "table" && request.method === "POST") {
    return resolveTableRoll(request, env, slotId);
  }
  if (parts[3] === "rolls" && parts[4] === "opposed" && request.method === "POST") {
    return resolveOpposed(request, env, slotId);
  }
  if (parts[3] === "mission-boards" && parts.length === 4 && request.method === "POST") {
    return createMissionBoard(request, env, slotId);
  }
  if (parts[3] === "missions" && parts[4] === "accept" && request.method === "POST") {
    return acceptMission(request, env, slotId);
  }
  if (parts[3] === "missions" && parts[5] === "complete" && parts[4] !== undefined && request.method === "POST") {
    return finishMission(request, env, slotId, parts[4]);
  }
  if (parts[3] === "drops" && parts[4] === "resolve" && request.method === "POST") {
    return resolveDrop(request, env, slotId);
  }
  if (parts[3] === "random-boxes" && parts[4] === "open" && request.method === "POST") {
    return openRandomBox(request, env, slotId);
  }
  throw new AppError(404, "route_not_found", "The requested game route does not exist.");
}
