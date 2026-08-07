import { AppError } from "../domain/errors";
import { assertActionId, assertSlotId } from "../domain/ids";
import {
  optionalString,
  readJsonObject,
  requireRevision,
  requireString,
} from "../domain/validation";
import { jsonResponse, storedResponse } from "../http";
import {
  createSaveSlot,
  findSaveSlot,
  listSaveSlots,
  mutateSaveSlot,
} from "../repositories/save-slots";

function defaultCause(value: string | undefined, fallback: string): string {
  return value ?? fallback;
}

export async function handleSaveSlotRoute(
  request: Request,
  env: Env,
  pathParts: string[],
  url: URL,
): Promise<Response> {
  if (pathParts.length === 2 && request.method === "POST") {
    const body = await readJsonObject(request);
    const actionId = requireString(body, "action_id", { min: 8, max: 128 });
    assertActionId(actionId);
    const title = requireString(body, "title", { min: 1, max: 80 });
    return storedResponse(await createSaveSlot(env.DB, { actionId, title }));
  }

  if (pathParts.length === 2 && request.method === "GET") {
    const includeArchived = url.searchParams.get("include_archived") === "true";
    const slots = await listSaveSlots(env.DB, includeArchived);
    return jsonResponse({ ok: true, data: { slots } });
  }

  const slotId = pathParts[2];
  if (slotId === undefined) {
    throw new AppError(404, "route_not_found", "The requested route does not exist.");
  }
  assertSlotId(slotId);

  if (pathParts.length === 3 && request.method === "GET") {
    const slot = await findSaveSlot(env.DB, slotId);
    if (slot === null) {
      throw new AppError(404, "slot_not_found", "The save slot does not exist.");
    }
    return jsonResponse({ ok: true, data: { slot } });
  }

  if (pathParts.length === 4 && pathParts[3] === "title" && request.method === "PATCH") {
    const body = await readJsonObject(request);
    const actionId = requireString(body, "action_id", { min: 8, max: 128 });
    assertActionId(actionId);
    const title = requireString(body, "title", { min: 1, max: 80 });
    const expectedRevision = requireRevision(body);
    const cause = defaultCause(optionalString(body, "cause", 240), "저장 슬롯 이름 변경");
    return storedResponse(
      await mutateSaveSlot(env.DB, {
        kind: "rename",
        actionId,
        slotId,
        title,
        expectedRevision,
        cause,
      }),
    );
  }

  const isArchive = pathParts.length === 4 && pathParts[3] === "archive";
  const isRestore = pathParts.length === 4 && pathParts[3] === "restore";
  if ((isArchive || isRestore) && request.method === "POST") {
    const body = await readJsonObject(request);
    const actionId = requireString(body, "action_id", { min: 8, max: 128 });
    assertActionId(actionId);
    const expectedRevision = requireRevision(body);
    const kind = isArchive ? "archive" : "restore";
    const fallback = isArchive ? "저장 슬롯 보관" : "저장 슬롯 복원";
    const cause = defaultCause(optionalString(body, "cause", 240), fallback);
    return storedResponse(
      await mutateSaveSlot(env.DB, { kind, actionId, slotId, expectedRevision, cause }),
    );
  }

  throw new AppError(404, "route_not_found", "The requested route does not exist.");
}

