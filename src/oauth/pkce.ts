import crypto from "node:crypto";

export function verifyS256(codeVerifier: string, codeChallenge: string): boolean {
  const computed = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  return computed === codeChallenge;
}

// RFC 9126: localhost redirect URIs match regardless of port
export function redirectUriMatches(registered: string, requested: string): boolean {
  try {
    const r1 = new URL(registered);
    const r2 = new URL(requested);
    const isLocalhost =
      r1.hostname === "localhost" || r1.hostname === "127.0.0.1";
    if (isLocalhost) {
      return (
        r1.protocol === r2.protocol &&
        r1.hostname === r2.hostname &&
        r1.pathname === r2.pathname
      );
    }
    return registered === requested;
  } catch {
    return false;
  }
}
