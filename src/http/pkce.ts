import { SignJWT, jwtVerify } from "jose";

export type OauthHandshake = {
  verifier: string;
  state: string;
};

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signHandshake(data: OauthHandshake, secret: string): Promise<string> {
  return new SignJWT({ verifier: data.verifier, state: data.state })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .sign(key(secret));
}

export async function readHandshake(
  token: string,
  secret: string,
): Promise<OauthHandshake | undefined> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ["HS256"] });
    if (typeof payload.verifier !== "string" || typeof payload.state !== "string") {
      return undefined;
    }
    return { verifier: payload.verifier, state: payload.state };
  } catch {
    return undefined;
  }
}

export function pkceChallenge(verifier: string): Promise<string> {
  return crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(verifier))
    .then((buf) => Buffer.from(buf).toString("base64url"));
}

export function newPkceVerifier(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}
