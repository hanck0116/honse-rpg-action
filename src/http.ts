import { AppError } from "./domain/errors";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export interface StoredResponse {
  status: number;
  body: unknown;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function errorResponse(error: AppError): Response {
  const details = error.details === undefined ? {} : { details: error.details };
  return jsonResponse(
    {
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        retryable: error.retryable,
        ...details,
      },
    },
    error.status,
  );
}

export function storedResponse(response: StoredResponse): Response {
  return jsonResponse(response.body, response.status);
}

