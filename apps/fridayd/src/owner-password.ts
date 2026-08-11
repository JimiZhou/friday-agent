import { scryptSync, timingSafeEqual } from "node:crypto";

const LOGIN_SALT = "friday-agent-owner-web-v1";

/** Constant-work comparison; the root-owned environment remains the secret store. */
export function ownerPasswordMatches(expected: string, provided: string): boolean {
  if (
    typeof expected !== "string" ||
    typeof provided !== "string" ||
    provided.length > 256 ||
    /[\u0000-\u001f\u007f]/.test(provided)
  ) return false;
  const expectedDigest = scryptSync(expected, LOGIN_SALT, 32);
  const providedDigest = scryptSync(provided, LOGIN_SALT, 32);
  return timingSafeEqual(expectedDigest, providedDigest);
}
