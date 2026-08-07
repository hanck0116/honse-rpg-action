import { jsonResponse } from "../http";

export function healthResponse(): Response {
  return jsonResponse({
    ok: true,
    data: {
      service: "honse-rpg-action",
      status: "healthy",
      api_version: "v1",
    },
  });
}

