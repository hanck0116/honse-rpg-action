import { AppError } from "./errors";

const ACTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const SLOT_ID_PATTERN = /^slot_[0-9a-f-]{36}$/;

export function newSlotId(): string {
  return `slot_${crypto.randomUUID()}`;
}

export function newLogId(): string {
  return `log_${crypto.randomUUID()}`;
}

export function assertActionId(value: string): void {
  if (!ACTION_ID_PATTERN.test(value)) {
    throw new AppError(
      400,
      "invalid_action_id",
      "action_id must be 8-128 characters using letters, numbers, dot, underscore, colon, or hyphen.",
    );
  }
}

export function assertSlotId(value: string): void {
  if (!SLOT_ID_PATTERN.test(value)) {
    throw new AppError(400, "invalid_slot_id", "The save slot identifier is invalid.");
  }
}

