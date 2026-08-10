import { AppError } from "./domain/errors";

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256Bytes(value: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return new Uint8Array(digest);
}

export async function sha256Hex(value: string): Promise<string> {
  return bytesToHex(await sha256Bytes(value));
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const [leftHash, rightHash] = await Promise.all([sha256Bytes(left), sha256Bytes(right)]);
  return crypto.subtle.timingSafeEqual(leftHash, rightHash);
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  const object = value as Record<string, unknown>;
  const entries = Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`);
  return `{${entries.join(",")}}`;
}

export async function hashRequest(value: unknown): Promise<string> {
  return sha256Hex(stableStringify(value));
}

export async function requireApiKey(request: Request, expectedKey: string): Promise<void> {
  if (expectedKey.length === 0) {
    throw new AppError(500, "server_misconfigured", "The Action API key is not configured.");
  }

  const authorization = request.headers.get("authorization") ?? "";
  const prefix = "Bearer ";
  const provided = authorization.startsWith(prefix) ? authorization.slice(prefix.length) : "";
  if (!(await constantTimeEqual(provided, expectedKey))) {
    throw new AppError(401, "unauthorized", "A valid Bearer API key is required.");
  }
}
