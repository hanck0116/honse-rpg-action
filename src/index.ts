import { AppError } from "./domain/errors";
import { errorResponse } from "./http";
import { healthResponse } from "./routes/health";
import { handleSaveSlotRoute } from "./routes/save-slots";
import { requireApiKey } from "./security";

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") return healthResponse();

  await requireApiKey(request, env.ACTION_API_KEY);
  const pathParts = url.pathname.split("/").filter(Boolean);
  if (pathParts[0] === "v1" && pathParts[1] === "save-slots") {
    return handleSaveSlotRoute(request, env, pathParts, url);
  }

  throw new AppError(404, "route_not_found", "The requested route does not exist.");
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    try {
      return await route(request, env);
    } catch (error) {
      if (error instanceof AppError) return errorResponse(error);

      console.error(
        JSON.stringify({
          message: "unhandled request error",
          request_id: requestId,
          method: request.method,
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return errorResponse(
        new AppError(500, "internal_error", "The save result is unknown. Reload before retrying.", {
          retryable: true,
        }),
      );
    }
  },
} satisfies ExportedHandler<Env>;

