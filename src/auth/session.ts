import { SignJWT, jwtVerify } from "jose";
import type { Role } from "./rbac.ts";

export type Session = {
  sub: string;
  clientId: string;
  role: Role;
  csrf: string;
};

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSession(
  session: Session,
  secret: string,
  ttlSeconds = 60 * 60,
): Promise<string> {
  return new SignJWT({
    sub: session.sub,
    clientId: session.clientId,
    role: session.role,
    csrf: session.csrf,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds}s`)
    .sign(secretKey(secret));
}

export async function readSession(token: string, secret: string): Promise<Session | undefined> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret), { algorithms: ["HS256"] });
    if (
      typeof payload.sub !== "string" ||
      typeof payload.clientId !== "string" ||
      (payload.role !== "readonly" && payload.role !== "edit") ||
      typeof payload.csrf !== "string"
    ) {
      return undefined;
    }
    return { sub: payload.sub, clientId: payload.clientId, role: payload.role, csrf: payload.csrf };
  } catch {
    return undefined;
  }
}

export function newCsrfToken(): string {
  return crypto.randomUUID();
}
