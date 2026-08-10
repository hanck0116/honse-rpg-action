import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

const API_KEY = "test-action-key";

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${API_KEY}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return exports.default.fetch(`https://example.com${path}`, { ...init, headers });
}

async function resetDb(): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM mutation_guards"),
    env.DB.prepare("DELETE FROM party_access"),
    env.DB.prepare("DELETE FROM game_entities"),
    env.DB.prepare("DELETE FROM slot_counters"),
    env.DB.prepare("DELETE FROM rolls"),
    env.DB.prepare("DELETE FROM world_states"),
    env.DB.prepare("DELETE FROM characters"),
    env.DB.prepare("DELETE FROM action_logs"),
    env.DB.prepare("DELETE FROM save_slots"),
    env.DB.prepare("DELETE FROM action_requests"),
  ]);
}

async function createSlot(): Promise<string> {
  const response = await api("/v1/save-slots", {
    method: "POST",
    body: JSON.stringify({ action_id: "ACT:game:slot:create", title: "네 사람의 혼세" }),
  });
  const body = (await response.json()) as { data: { slot: { slot_id: string } } };
  return body.data.slot.slot_id;
}

function characterData(level = 1): Record<string, unknown> {
  return {
    player_label: "플레이어 1",
    race: "인간",
    job: "전사",
    level,
    hp: { current: 20, max: 20 },
    base_stats_percent: {
      strength: 80,
      agility: 60,
      endurance: 70,
      intelligence: 40,
      wisdom: 50,
      appearance: 55,
    },
    bonuses: {
      race: { strength: 5 },
      job: { strength: 3 },
      equipment: { strength: 2 },
      skill_state: {},
    },
    statuses: [],
  };
}

async function createCharacter(slotId: string, action: string, name: string): Promise<{ id: string; revision: number }> {
  const response = await api(`/v2/slots/${slotId}/entities`, {
    method: "POST",
    body: JSON.stringify({
      action_id: action,
      entity_type: "character",
      name,
      public_data: characterData(),
      gm_data: { private_origin: "플레이어에게 숨김" },
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: { entity: { entity_id: string; revision: number } } };
  return { id: body.data.entity.entity_id, revision: body.data.entity.revision };
}

function safeMission(index: number): Record<string, unknown> {
  return {
    key: `safe-${index}`,
    public: {
      title: `마을 심부름 ${index}`,
      rank: "F",
      danger: index % 2 === 0 ? 1 : 2,
      client: "첫불 마을 주민",
      goal: "물건을 안전하게 전달한다",
      reward: "10 코인",
      cautions: "길을 잃지 말 것",
    },
    gm: {
      planned_combat: false,
      has_named: false,
      success_conditions: ["전달 완료"],
      failure_conditions: ["기한 초과"],
      locations: ["첫불 광장"],
      stages: ["전달"],
      enemy_roster: [],
      rewards: ["10 코인"],
      predeclared_triggers: [],
      core_difficulties: [],
    },
  };
}

beforeEach(resetDb);

describe("complete TRPG state engine", () => {
  it("calculates character stats and exposes a clean multi-player party view", async () => {
    const slotId = await createSlot();
    const first = await createCharacter(slotId, "ACT:game:char:first", "가온");
    await createCharacter(slotId, "ACT:game:char:second", "나래");

    const item = await api(`/v2/slots/${slotId}/entities`, {
      method: "POST",
      body: JSON.stringify({
        action_id: "ACT:game:item:create",
        entity_type: "item",
        parent_id: first.id,
        name: "강철 검",
        public_data: { grade: "F", category: "일반 아이템", equipped: true, item_skill: "none" },
        gm_data: { source_revision: 7 },
      }),
    });
    expect(item.status).toBe(201);

    const rotate = await api(`/v2/slots/${slotId}/party-access/rotate`, {
      method: "POST",
      body: JSON.stringify({ action_id: "ACT:game:party:rotate" }),
    });
    const rotateBody = (await rotate.json()) as { data: { access_token: string } };
    const publicResponse = await exports.default.fetch("https://example.com/public/party", {
      headers: { authorization: `Bearer ${rotateBody.data.access_token}` },
    });
    expect(publicResponse.status).toBe(200);
    expect(publicResponse.headers.get("access-control-allow-origin")).toBe("*");
    const publicText = await publicResponse.text();
    const publicBody = JSON.parse(publicText) as { data: { characters: Array<Record<string, unknown>> } };
    expect(publicBody.data.characters).toHaveLength(2);
    expect(publicText).toContain("강철 검");
    expect(publicText).toContain('"effective":27');
    expect(publicText).not.toContain("entity_id");
    expect(publicText).not.toContain("revision");
    expect(publicText).not.toContain("private_origin");
    expect(publicText).not.toContain("gm_data");
  });

  it("uses cryptographic rolls and publishes every die and raw result", async () => {
    const slotId = await createSlot();
    const character = await createCharacter(slotId, "ACT:game:char:roll", "다온");
    const response = await api(`/v2/slots/${slotId}/rolls/difficulty`, {
      method: "POST",
      body: JSON.stringify({
        action_id: "ACT:game:roll:difficulty",
        character_id: character.id,
        stat: "strength",
        modifiers: [{ label: "좋은 도구", amount: 2 }],
        difficulty: 40,
        purpose: "문을 밀어 연다",
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { roll: { die: string; raw_result: number; final_effective: number } } };
    expect(body.data.roll.die).toBe("1d40");
    expect(body.data.roll.raw_result).toBeGreaterThanOrEqual(1);
    expect(body.data.roll.raw_result).toBeLessThanOrEqual(40);
    expect(body.data.roll.final_effective).toBe(29);
    const stored = await env.DB.prepare("SELECT rng_method, public_json FROM rolls").first<{
      rng_method: string;
      public_json: string;
    }>();
    expect(stored?.rng_method).toBe("web_crypto_rejection_sampling");
    expect(stored?.public_json).toContain("raw_result");

    const statsResponse = await api(`/v2/slots/${slotId}/rolls/table`, {
      method: "POST",
      body: JSON.stringify({
        action_id: "ACT:game:roll:base-stats",
        purpose: "캐릭터 기본 스탯 퍼센트 6종 생성",
        rolls: ["힘", "민첩", "체력", "지능", "지혜", "외모"].map((label) => ({ label, sides: 100 })),
      }),
    });
    expect(statsResponse.status).toBe(200);
    const statsBody = (await statsResponse.json()) as { data: { roll: { rolls: Array<{ die: string; raw_result: number }> } } };
    expect(statsBody.data.roll.rolls).toHaveLength(6);
    expect(statsBody.data.roll.rolls.every((roll) => roll.die === "1d100" && roll.raw_result >= 1 && roll.raw_result <= 100)).toBe(true);
  });

  it("locks a safe ten-mission board, accepts a mission, and levels all participants", async () => {
    const slotId = await createSlot();
    const character = await createCharacter(slotId, "ACT:game:char:mission", "라온");
    const boardResponse = await api(`/v2/slots/${slotId}/mission-boards`, {
      method: "POST",
      body: JSON.stringify({
        action_id: "ACT:game:board:create",
        rank: "F",
        missions: Array.from({ length: 10 }, (_, index) => safeMission(index + 1)),
      }),
    });
    expect(boardResponse.status).toBe(201);
    const board = (await boardResponse.json()) as { data: { entity: { entity_id: string } } };

    const acceptResponse = await api(`/v2/slots/${slotId}/missions/accept`, {
      method: "POST",
      body: JSON.stringify({
        action_id: "ACT:game:mission:accept",
        board_id: board.data.entity.entity_id,
        mission_key: "safe-1",
        character_ids: [character.id],
      }),
    });
    expect(acceptResponse.status).toBe(201);
    const accepted = (await acceptResponse.json()) as { data: { entity: { entity_id: string; revision: number } } };

    const completeResponse = await api(
      `/v2/slots/${slotId}/missions/${accepted.data.entity.entity_id}/complete`,
      {
        method: "POST",
        body: JSON.stringify({
          action_id: "ACT:game:mission:complete",
          expected_revision: accepted.data.entity.revision,
          characters: [{ entity_id: character.id, expected_revision: character.revision }],
        }),
      },
    );
    expect(completeResponse.status).toBe(200);
    await expect(completeResponse.json()).resolves.toMatchObject({
      data: { level_gain: 2, characters: [{ name: "라온", level: 3, rank: "F" }] },
    });
    const counter = await env.DB.prepare("SELECT completed_missions FROM slot_counters WHERE slot_id = ?")
      .bind(slotId)
      .first<{ completed_missions: number }>();
    expect(counter?.completed_missions).toBe(1);
  });

  it("enforces random-box-only monster drops and the fixed box content tables", async () => {
    const slotId = await createSlot();
    const character = await createCharacter(slotId, "ACT:game:char:drop", "마루");
    const monsterResponse = await api(`/v2/slots/${slotId}/entities`, {
      method: "POST",
      body: JSON.stringify({
        action_id: "ACT:game:monster:create",
        entity_type: "monster",
        name: "잿빛 들쥐",
        visibility: "discovered",
        public_data: { rank: "F" },
        gm_data: { drop_table: { drop_type: "random_box_only", locked_revision: 0 } },
      }),
    });
    const monster = (await monsterResponse.json()) as { data: { entity: { entity_id: string } } };
    const dropResponse = await api(`/v2/slots/${slotId}/drops/resolve`, {
      method: "POST",
      body: JSON.stringify({
        action_id: "ACT:game:drop:resolve",
        source_entity_id: monster.data.entity.entity_id,
        recovered: true,
        scene_risk: 1,
      }),
    });
    const dropText = await dropResponse.text();
    expect(dropResponse.status).toBe(200);
    expect(dropText).toContain("랜덤 박스");
    expect(dropText).toContain("1d100");

    const boxResponse = await api(`/v2/slots/${slotId}/entities`, {
      method: "POST",
      body: JSON.stringify({
        action_id: "ACT:game:box:create",
        entity_type: "item",
        parent_id: character.id,
        name: "랜덤 박스",
        public_data: { grade: "F", category: "랜덤 박스", item_skill: "none", content_table_revision: "2026-07-16" },
        gm_data: {},
      }),
    });
    const box = (await boxResponse.json()) as { data: { entity: { entity_id: string } } };
    const openResponse = await api(`/v2/slots/${slotId}/random-boxes/open`, {
      method: "POST",
      body: JSON.stringify({ action_id: "ACT:game:box:open", box_entity_id: box.data.entity.entity_id }),
    });
    expect(openResponse.status).toBe(200);
    const openText = await openResponse.text();
    expect(openText).toContain("랜덤 박스 개봉");
    expect(openText).toContain('"category"');
    expect(openText).toContain('"contents"');
  });

  it("commits four-player creation and multi-entity rule outcomes atomically", async () => {
    const slotId = await createSlot();
    const createBody = {
      action_id: "ACT:game:transaction:party",
      cause: "4인 파티와 시작 장비 일괄 생성",
      mutations: [
        ...["가온", "나래", "다온", "라온"].map((name, index) => ({
          kind: "create",
          client_ref: `player-${index + 1}`,
          entity_type: "character",
          name,
          public_data: { ...characterData(), player_label: `플레이어 ${index + 1}` },
          gm_data: { secret: `hidden-${index + 1}` },
        })),
        {
          kind: "create",
          client_ref: "starter-item",
          parent_client_ref: "player-1",
          entity_type: "item",
          name: "여행자의 검",
          public_data: { grade: "F", category: "일반 아이템", item_skill: "none", equipped: true },
          gm_data: {},
        },
      ],
    };
    const first = await api(`/v2/slots/${slotId}/transactions`, {
      method: "POST",
      body: JSON.stringify(createBody),
    });
    expect(first.status).toBe(200);
    const firstJson = (await first.json()) as { data: { entities: Array<{ entity: { entity_id: string } }> } };
    expect(firstJson.data.entities).toHaveLength(5);
    const replay = await api(`/v2/slots/${slotId}/transactions`, {
      method: "POST",
      body: JSON.stringify(createBody),
    });
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual(firstJson);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM game_entities WHERE slot_id = ?")
      .bind(slotId)
      .first<{ count: number }>();
    expect(count?.count).toBe(5);
  });
});
