import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

const API_KEY = "test-action-key";

function apiRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${API_KEY}`);
  if (init.body !== undefined) headers.set("content-type", "application/json");
  return exports.default.fetch(`https://example.com${path}`, { ...init, headers });
}

async function createSlot(actionId: string, title: string): Promise<Response> {
  return apiRequest("/v1/save-slots", {
    method: "POST",
    body: JSON.stringify({ action_id: actionId, title }),
  });
}

beforeEach(async () => {
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
});

describe("health and authentication", () => {
  it("returns health without authentication", async () => {
    const response = await exports.default.fetch("https://example.com/health");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true });
  });

  it("rejects protected routes without the API key", async () => {
    const response = await exports.default.fetch("https://example.com/v1/save-slots");
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "unauthorized" },
    });
  });
});

describe("save slots", () => {
  it("creates, lists, and loads isolated slots", async () => {
    const first = await createSlot("ACT:test:create:A", "첫 번째 세계");
    const second = await createSlot("ACT:test:create:B", "두 번째 세계");
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const firstBody = (await first.json()) as { data: { slot: { slot_id: string } } };
    const secondBody = (await second.json()) as { data: { slot: { slot_id: string } } };
    expect(firstBody.data.slot.slot_id).not.toBe(secondBody.data.slot.slot_id);

    const list = await apiRequest("/v1/save-slots");
    const listBody = (await list.json()) as { data: { slots: Array<{ title: string }> } };
    expect(listBody.data.slots.map((slot) => slot.title).sort()).toEqual([
      "두 번째 세계",
      "첫 번째 세계",
    ]);

    const loaded = await apiRequest(`/v1/save-slots/${firstBody.data.slot.slot_id}`);
    const loadedText = await loaded.text();
    expect(loadedText).toContain("첫 번째 세계");
    expect(loadedText).not.toContain("두 번째 세계");
  });

  it("replays the same action and rejects a mismatched duplicate", async () => {
    const first = await createSlot("ACT:test:idempotent", "재시도 세계");
    const replay = await createSlot("ACT:test:idempotent", "재시도 세계");
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(await replay.text()).toBe(await first.text());

    const mismatch = await createSlot("ACT:test:idempotent", "다른 세계");
    expect(mismatch.status).toBe(409);
    await expect(mismatch.json()).resolves.toMatchObject({
      error: { code: "duplicate_action_mismatch" },
    });

    const count = await env.DB.prepare("SELECT count(*) AS count FROM save_slots").first<{
      count: number;
    }>();
    expect(count?.count).toBe(1);
  });

  it("renames with revision protection and records the change log", async () => {
    const created = await createSlot("ACT:test:create:rename", "이름 전");
    const createdBody = (await created.json()) as {
      data: { slot: { slot_id: string; revision: number } };
    };

    const renamed = await apiRequest(`/v1/save-slots/${createdBody.data.slot.slot_id}/title`, {
      method: "PATCH",
      body: JSON.stringify({
        action_id: "ACT:test:rename:ok",
        expected_revision: createdBody.data.slot.revision,
        title: "이름 후",
      }),
    });
    expect(renamed.status).toBe(200);
    await expect(renamed.json()).resolves.toMatchObject({
      data: { slot: { title: "이름 후", revision: 1 } },
    });

    const conflict = await apiRequest(`/v1/save-slots/${createdBody.data.slot.slot_id}/title`, {
      method: "PATCH",
      body: JSON.stringify({
        action_id: "ACT:test:rename:stale",
        expected_revision: 0,
        title: "덮어쓰면 안 됨",
      }),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "revision_conflict" },
    });

    const log = await env.DB
      .prepare(
        `SELECT revision_before, revision_after, before_json, after_json
         FROM action_logs WHERE action_id = ?`,
      )
      .bind("ACT:test:rename:ok")
      .first<{
        revision_before: number;
        revision_after: number;
        before_json: string;
        after_json: string;
      }>();
    expect(log).toMatchObject({ revision_before: 0, revision_after: 1 });
    expect(JSON.parse(log?.before_json ?? "{}")).toEqual({ title: "이름 전" });
    expect(JSON.parse(log?.after_json ?? "{}")).toEqual({ title: "이름 후" });
  });

  it("archives without deletion and can restore the slot", async () => {
    const created = await createSlot("ACT:test:create:archive", "보관할 세계");
    const body = (await created.json()) as {
      data: { slot: { slot_id: string; revision: number } };
    };

    const archived = await apiRequest(`/v1/save-slots/${body.data.slot.slot_id}/archive`, {
      method: "POST",
      body: JSON.stringify({
        action_id: "ACT:test:archive",
        expected_revision: 0,
      }),
    });
    expect(archived.status).toBe(200);
    await expect(archived.json()).resolves.toMatchObject({
      data: { slot: { status: "archived", revision: 1 } },
    });

    const visibleList = await apiRequest("/v1/save-slots");
    await expect(visibleList.json()).resolves.toMatchObject({ data: { slots: [] } });

    const allList = await apiRequest("/v1/save-slots?include_archived=true");
    const allBody = (await allList.json()) as { data: { slots: Array<{ status: string }> } };
    expect(allBody.data.slots).toHaveLength(1);
    expect(allBody.data.slots[0]?.status).toBe("archived");

    const restored = await apiRequest(`/v1/save-slots/${body.data.slot.slot_id}/restore`, {
      method: "POST",
      body: JSON.stringify({
        action_id: "ACT:test:restore",
        expected_revision: 1,
      }),
    });
    expect(restored.status).toBe(200);
    await expect(restored.json()).resolves.toMatchObject({
      data: { slot: { status: "active", revision: 2 } },
    });
  });
});
