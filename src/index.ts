import { AppError } from "./domain/errors";
import { errorResponse } from "./http";
import { healthResponse } from "./routes/health";
import { handleGameRoute, handlePublicPartyRoute } from "./routes/game";
import { handleSaveSlotRoute } from "./routes/save-slots";
import { requireApiKey } from "./security";

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return healthResponse();

  if (url.pathname === "/public/party") {
    return handlePublicPartyRoute(request, env);
  }

  await requireApiKey(request, env.ACTION_API_KEY);
  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts[0] === "v1" && pathParts[1] === "save-slots") {
    return handleSaveSlotRoute(request, env, pathParts, url);
  }
  if (pathParts[0] === "v2" && pathParts[1] === "slots") {
    return handleGameRoute(request, env, pathParts, url);
  }

  throw new AppError(404, "route_not_found", "The requested route does not exist.");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const publicRoute = new URL(request.url).pathname === "/public/party";
    try {
      const response = await route(request, env);
      return publicRoute ? withPublicCors(response) : response;
    } catch (error) {
      if (error instanceof AppError) {
        const response = errorResponse(error);
        return publicRoute ? withPublicCors(response) : response;
      }

      console.error(
        JSON.stringify({
          message: "unhandled request error",
          request_id: requestId,
          method: request.method,
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      const response = errorResponse(
        new AppError(500, "internal_error", "The save result is unknown. Reload before retrying.", {
          retryable: true,
        }),
      );
      return publicRoute ? withPublicCors(response) : response;
    }
  },
} satisfies ExportedHandler<Env>;

function withPublicCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, OPTIONS");
  headers.set("access-control-allow-headers", "Authorization, Content-Type");
  headers.set("access-control-max-age", "86400");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
