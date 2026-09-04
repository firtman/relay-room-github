const CONTACT_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

type ReleaseState = {
  stage: number;
  status: string;
  armedUntil: number;
  contactCode: string | null;
};

type ReleaseAttempt = {
  now: number;
  releaseCode: string;
  contactCode: string;
  expectedReleaseCode: string;
};

export type ReleaseDecision =
  | { ok: true }
  | { ok: false; reason: "lock_not_ready" | "contact_expired" | "contact_code_required" | "invalid_release_code" };

export function createContactCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (byte) => CONTACT_CODE_ALPHABET[byte % CONTACT_CODE_ALPHABET.length]).join("");
}

export function evaluateDoorRelease(state: ReleaseState, attempt: ReleaseAttempt): ReleaseDecision {
  if (state.stage !== 3 || state.status !== "playing") return { ok: false, reason: "lock_not_ready" };
  if (state.armedUntil <= attempt.now) return { ok: false, reason: "contact_expired" };

  const submittedContactCode = attempt.contactCode.trim().toUpperCase();
  if (!state.contactCode || submittedContactCode !== state.contactCode) return { ok: false, reason: "contact_code_required" };

  const submittedReleaseCode = attempt.releaseCode.replace(/\D/g, "");
  if (submittedReleaseCode !== attempt.expectedReleaseCode) return { ok: false, reason: "invalid_release_code" };
  return { ok: true };
}
