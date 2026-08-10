import { AppError } from "./errors";

export const ENTITY_TYPES = [
  "character",
  "item",
  "skill",
  "mission_board",
  "mission",
  "npc",
  "monster",
  "named",
  "location",
  "world",
  "crisis",
  "gimmick",
  "hazard",
  "combat",
  "drop_table",
  "dlc",
  "note",
] as const;

export type EntityType = (typeof ENTITY_TYPES)[number];
export type Visibility = "public" | "discovered" | "hidden" | "sealed" | "gm";
export type EntityStatus =
  | "active"
  | "inactive"
  | "accepted"
  | "completed"
  | "failed"
  | "paused"
  | "archived"
  | "replaced"
  | "consumed"
  | "destroyed";

export const STAT_KEYS = [
  "strength",
  "agility",
  "endurance",
  "intelligence",
  "wisdom",
  "appearance",
] as const;

export type StatKey = (typeof STAT_KEYS)[number];
export type Grade = "F" | "E" | "D" | "C" | "B" | "A" | "S" | "SS" | "SSS" | "EX";

const GRADES: readonly Grade[] = ["F", "E", "D", "C", "B", "A", "S", "SS", "SSS", "EX"];
const VISIBILITIES: readonly Visibility[] = ["public", "discovered", "hidden", "sealed", "gm"];
const STAT_LABELS: Record<StatKey, string> = {
  strength: "힘",
  agility: "민첩",
  endurance: "체력",
  intelligence: "지능",
  wisdom: "지혜",
  appearance: "외모",
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new AppError(400, "invalid_request", `${field} must be an object.`);
  return value;
}

export function optionalObject(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined) return {};
  return requireObject(value, field);
}

export function requireArray(value: unknown, field: string, max = 100): unknown[] {
  if (!Array.isArray(value) || value.length > max) {
    throw new AppError(400, "invalid_request", `${field} must be an array with at most ${max} entries.`);
  }
  return value;
}

export function requireInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new AppError(400, "invalid_request", `${field} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

export function optionalInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  return value === undefined ? fallback : requireInteger(value, field, min, max);
}

export function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new AppError(400, "invalid_request", `${field} must be boolean.`);
  return value;
}

export function requireEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new AppError(400, "invalid_request", `${field} has an unsupported value.`);
  }
  return value as T;
}

export function parseEntityType(value: unknown): EntityType {
  return requireEnum(value, "entity_type", ENTITY_TYPES);
}

export function parseVisibility(value: unknown, fallback: Visibility = "public"): Visibility {
  return value === undefined ? fallback : requireEnum(value, "visibility", VISIBILITIES);
}

export function parseGrade(value: unknown, field = "grade"): Grade {
  return requireEnum(value, field, GRADES);
}

export function parseStatKey(value: unknown, field = "stat"): StatKey {
  return requireEnum(value, field, STAT_KEYS);
}

export function rankForLevel(level: number): Grade {
  const capped = Math.max(1, Math.min(99, level));
  return GRADES[Math.min(9, Math.floor((capped - 1) / 10))] ?? "F";
}

export function levelGainForDanger(danger: number): number {
  if (danger <= 2) return 2;
  if (danger <= 4) return 3;
  if (danger <= 6) return 4;
  if (danger <= 8) return 5;
  return 7;
}

function numberMap(value: unknown, field: string, min = -999, max = 999): Record<StatKey, number> {
  const object = value === undefined ? {} : requireObject(value, field);
  const result = {} as Record<StatKey, number>;
  for (const stat of STAT_KEYS) {
    const raw = object[stat];
    result[stat] = raw === undefined ? 0 : requireInteger(raw, `${field}.${stat}`, min, max);
  }
  return result;
}

export function canonicalCharacterPublic(input: Record<string, unknown>): Record<string, unknown> {
  const level = requireInteger(input.level, "public_data.level", 1, 99);
  const percentages = numberMap(input.base_stats_percent, "public_data.base_stats_percent", 1, 100);
  const bonusInput = optionalObject(input.bonuses, "public_data.bonuses");
  const race = numberMap(bonusInput.race, "public_data.bonuses.race");
  const job = numberMap(bonusInput.job, "public_data.bonuses.job");
  const equipment = numberMap(bonusInput.equipment, "public_data.bonuses.equipment");
  const skillState = numberMap(bonusInput.skill_state, "public_data.bonuses.skill_state");
  const hpInput = requireObject(input.hp, "public_data.hp");
  const maxHp = requireInteger(hpInput.max, "public_data.hp.max", 1, 999_999);
  const currentHp = requireInteger(hpInput.current, "public_data.hp.current", 0, maxHp);
  const stats: Record<string, unknown> = {};

  for (const stat of STAT_KEYS) {
    const baseAbsolute = Math.max(1, Math.round(((level + 20) * percentages[stat]) / 100));
    const effective = Math.max(
      1,
      baseAbsolute + race[stat] + job[stat] + equipment[stat] + skillState[stat],
    );
    stats[stat] = {
      label: STAT_LABELS[stat],
      base_percent: percentages[stat],
      base_absolute: baseAbsolute,
      race_bonus: race[stat],
      job_bonus: job[stat],
      equipment_bonus: equipment[stat],
      skill_state_bonus: skillState[stat],
      effective,
    };
  }

  const statuses = input.statuses === undefined ? [] : requireArray(input.statuses, "public_data.statuses", 30);
  const playerLabel = typeof input.player_label === "string" ? input.player_label.trim().slice(0, 40) : "플레이어";
  const raceName = typeof input.race === "string" ? input.race.trim().slice(0, 60) : "미정";
  const jobName = typeof input.job === "string" ? input.job.trim().slice(0, 60) : "미정";

  return {
    ...input,
    player_label: playerLabel || "플레이어",
    race: raceName || "미정",
    job: jobName || "미정",
    level,
    rank: rankForLevel(level),
    hp: { current: currentHp, max: maxHp },
    base_stats_percent: percentages,
    bonuses: { race, job, equipment, skill_state: skillState },
    stats,
    statuses,
  };
}

export function canonicalEntityPublic(
  entityType: EntityType,
  input: Record<string, unknown>,
): Record<string, unknown> {
  if (entityType === "character") return canonicalCharacterPublic(input);
  if (entityType === "item") {
    const grade = parseGrade(input.grade);
    const category = typeof input.category === "string" ? input.category.trim().slice(0, 40) : "일반 아이템";
    const itemSkill = input.item_skill ?? null;
    if (category === "일반 아이템" && itemSkill !== null && itemSkill !== "none") {
      throw new AppError(400, "invalid_item", "A normal item cannot have a natural item skill.");
    }
    return { ...input, grade, category };
  }
  return input;
}

export function effectiveStat(characterPublic: Record<string, unknown>, stat: StatKey): number {
  const stats = requireObject(characterPublic.stats, "character.stats");
  const row = requireObject(stats[stat], `character.stats.${stat}`);
  return requireInteger(row.effective, `character.stats.${stat}.effective`, 1, 999_999);
}

export function randomDie(sides: number): number {
  requireInteger(sides, "dice sides", 1, 1_000_000);
  const range = 0x1_0000_0000;
  const limit = Math.floor(range / sides) * sides;
  const buffer = new Uint32Array(1);
  let value = range;
  while (value >= limit) {
    crypto.getRandomValues(buffer);
    value = buffer[0] ?? range;
  }
  return (value % sides) + 1;
}

export function difficultyStrength(delta: number, success: boolean): string {
  if (success) {
    if (delta === 0) return "간신히 성공";
    if (delta <= 9) return "약한 성공";
    if (delta <= 24) return "일반 성공";
    if (delta <= 49) return "강한 성공";
    return "압도적 성공";
  }
  if (delta <= 9) return "아슬아슬한 실패";
  if (delta <= 24) return "일반 실패";
  if (delta <= 49) return "큰 실패";
  return "치명적 실패";
}

export function opposedStrength(delta: number): string {
  if (delta === 0) return "스탯 우위의 가장 약한 승리";
  if (delta <= 4) return "근소한 승리";
  if (delta <= 14) return "일반 승리";
  if (delta <= 29) return "강한 승리";
  return "압도적 승리";
}

const DANGER_BY_RANK: Record<Grade, readonly [number, number]> = {
  F: [1, 2], E: [1, 3], D: [2, 5], C: [3, 6], B: [4, 7],
  A: [5, 8], S: [6, 9], SS: [7, 10], SSS: [8, 10], EX: [9, 10],
};

const BOARD_COMBAT: Record<Grade, readonly [number, number]> = {
  F: [0, 0], E: [0, 1], D: [4, 6], C: [6, 8], B: [8, 10],
  A: [9, 10], S: [10, 10], SS: [10, 10], SSS: [10, 10], EX: [10, 10],
};

const BOARD_NAMED: Record<Grade, readonly [number, number]> = {
  F: [0, 0], E: [0, 0], D: [0, 0], C: [0, 0], B: [3, 5],
  A: [6, 8], S: [7, 9], SS: [8, 10], SSS: [9, 10], EX: [10, 10],
};

export interface MissionEntry {
  key: string;
  public: Record<string, unknown>;
  gm: Record<string, unknown>;
}

export function validateMissionBoard(
  rankValue: unknown,
  missionsValue: unknown,
  earlyProtection: boolean,
): { rank: Grade; missions: MissionEntry[] } {
  const rank = parseGrade(rankValue, "rank");
  const rawMissions = requireArray(missionsValue, "missions", 10);
  if (rawMissions.length !== 10) {
    throw new AppError(400, "invalid_mission_board", "A mission board must contain exactly 10 missions.");
  }

  const missions: MissionEntry[] = [];
  const keys = new Set<string>();
  let combatCount = 0;
  let namedCount = 0;
  for (let index = 0; index < rawMissions.length; index += 1) {
    const row = requireObject(rawMissions[index], `missions[${index}]`);
    const key = typeof row.key === "string" ? row.key.trim() : "";
    if (!/^[A-Za-z0-9._:-]{3,80}$/.test(key) || keys.has(key)) {
      throw new AppError(400, "invalid_mission_board", "Every mission needs a unique stable key.");
    }
    keys.add(key);
    const publicData = requireObject(row.public, `missions[${index}].public`);
    const gmData = requireObject(row.gm, `missions[${index}].gm`);
    if (publicData.rank !== rank) {
      throw new AppError(400, "invalid_mission_board", "Every mission rank must match the board rank.");
    }
    const danger = requireInteger(publicData.danger, `missions[${index}].public.danger`, 1, 10);
    const range = DANGER_BY_RANK[rank];
    if (danger < range[0] || danger > range[1]) {
      throw new AppError(400, "invalid_mission_board", "A mission danger is outside its rank range.");
    }
    const requiredPublic = ["title", "client", "goal", "reward", "cautions"];
    for (const field of requiredPublic) {
      if (typeof publicData[field] !== "string" && !Array.isArray(publicData[field])) {
        throw new AppError(400, "invalid_mission_board", `Mission public field ${field} is required.`);
      }
    }
    const plannedCombat = requireBoolean(gmData.planned_combat, `missions[${index}].gm.planned_combat`);
    const hasNamed = requireBoolean(gmData.has_named, `missions[${index}].gm.has_named`);
    if (hasNamed && !plannedCombat) {
      throw new AppError(400, "invalid_mission_board", "A named mission must also be a combat mission.");
    }
    if (plannedCombat) combatCount += 1;
    if (hasNamed) namedCount += 1;
    const requiredGm = [
      "success_conditions", "failure_conditions", "locations", "stages", "enemy_roster",
      "rewards", "predeclared_triggers", "core_difficulties",
    ];
    for (const field of requiredGm) requireArray(gmData[field], `missions[${index}].gm.${field}`, 80);
    if (earlyProtection) {
      if (danger > 2 || plannedCombat || hasNamed || requireArray(gmData.stages, "stages", 80).length > 1) {
        throw new AppError(400, "early_protection_violation", "Early-game missions must be safe one-stage errands without combat or named enemies.");
      }
      if (requireArray(gmData.locations, "locations", 80).length > 2) {
        throw new AppError(400, "early_protection_violation", "Early-game missions may use at most two locations.");
      }
    }
    missions.push({ key, public: publicData, gm: gmData });
  }

  const combatRange = BOARD_COMBAT[rank];
  const namedRange = BOARD_NAMED[rank];
  if (combatCount < combatRange[0] || combatCount > combatRange[1]) {
    throw new AppError(400, "invalid_mission_board", "The board combat mission count violates the rank rule.");
  }
  if (namedCount < namedRange[0] || namedCount > namedRange[1]) {
    throw new AppError(400, "invalid_mission_board", "The board named mission count violates the rank rule.");
  }
  return { rank, missions };
}

export const BOX_CATEGORY_TABLE: Record<Grade, readonly [number, number, number, number]> = {
  F: [30, 60, 80, 90], E: [27, 55, 77, 90], D: [24, 49, 75, 90],
  C: [20, 42, 72, 90], B: [17, 35, 69, 90], A: [14, 30, 67, 90],
  S: [12, 26, 66, 90], SS: [10, 22, 64, 90], SSS: [8, 18, 62, 90],
  EX: [5, 13, 60, 90],
};

export const BOX_ROLL_COUNT: Record<Grade, number> = {
  F: 1, E: 1, D: 1, C: 1, B: 1, A: 1, S: 2, SS: 2, SSS: 3, EX: 4,
};

export const DROP_CHANCE: Record<number, number> = {
  1: 20, 2: 30, 3: 40, 4: 50, 5: 60, 6: 70, 7: 80, 8: 85, 9: 90, 10: 95,
};

export function lowerGrade(grade: Grade): Grade {
  const index = GRADES.indexOf(grade);
  return GRADES[Math.max(0, index - 1)] ?? "F";
}

export function contentGrade(boxGrade: Grade): Grade {
  return GRADES.indexOf(boxGrade) > GRADES.indexOf("A") ? "A" : boxGrade;
}

export const CONSUMABLES = ["물약", "붕대", "해독제", "식량", "횃불"] as const;
export const MATERIALS = ["나무", "천", "광석", "가죽", "씨앗"] as const;
export const EQUIPMENT = ["검", "창", "활", "방패", "갑옷", "장갑", "장화", "도구"] as const;
export const RUNES = [
  "불의 룬", "물의 룬", "바람의 룬", "흙의 룬", "번개의 룬", "얼음의 룬",
  "빛의 룬", "어둠의 룬", "회전의 룬", "진동의 룬", "가속의 룬", "감속의 룬",
  "충격의 룬", "밀어냄의 룬", "끌어당김의 룬", "무게의 룬", "탄성의 룬",
  "압축의 룬", "안개의 룬", "연기의 룬", "열의 룬", "냉기의 룬", "소리의 룬",
  "점착의 룬", "건조의 룬", "습기의 룬",
] as const;

export function coinRoll(grade: Grade): { sides: number; add: number } {
  const table: Record<Grade, readonly [number, number]> = {
    F: [6, 4], E: [11, 9], D: [21, 19], C: [41, 39], B: [71, 79],
    A: [151, 149], S: [201, 299], SS: [301, 499], SSS: [401, 799], EX: [801, 1199],
  };
  const row = table[grade];
  return { sides: row[0], add: row[1] };
}
