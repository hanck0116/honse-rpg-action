import { AppError } from "./errors";

// GPT Actions allow text payloads below 100,000 characters. Leave headroom for
// UTF-8 expansion while still supporting a complete 10-mission board.
const MAX_BODY_BYTES = 96_000;

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && Number(declaredLength) > MAX_BODY_BYTES) {
    throw new AppError(413, "request_too_large", "The request body is too large.");
  }

  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new AppError(413, "request_too_large", "The request body is too large.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new AppError(400, "invalid_json", "The request body must be valid JSON.");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AppError(400, "invalid_request", "The request body must be a JSON object.");
  }

  return parsed as Record<string, unknown>;
}

export function requireString(
  object: Record<string, unknown>,
  key: string,
  options: { min?: number; max?: number } = {},
): string {
  const value = object[key];
  if (typeof value !== "string") {
    throw new AppError(400, "invalid_request", `${key} must be a string.`);
  }

  const normalized = value.trim();
  const min = options.min ?? 1;
  const max = options.max ?? 256;
  if (normalized.length < min || normalized.length > max || /[\u0000-\u001F\u007F]/u.test(normalized)) {
    throw new AppError(
      400,
      "invalid_request",
      `${key} must contain ${min}-${max} printable characters.`,
    );
  }

  return normalized;
}

export function optionalString(
  object: Record<string, unknown>,
  key: string,
  max: number,
): string | undefined {
  const value = object[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new AppError(400, "invalid_request", `${key} must be a string when provided.`);
  }

  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > max || /[\u0000-\u001F\u007F]/u.test(normalized)) {
    throw new AppError(400, "invalid_request", `${key} must contain 1-${max} printable characters.`);
  }
  return normalized;
}

export function requireRevision(object: Record<string, unknown>): number {
  const value = object.expected_revision;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
    throw new AppError(400, "invalid_request", "expected_revision must be a non-negative integer.");
  }
  return value;
}
