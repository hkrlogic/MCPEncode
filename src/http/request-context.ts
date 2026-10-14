/**
 * Per-request state that page helpers can read without threading it through
 * every call. Today: who is signed in, so error pages show the signed-in
 * header instead of "Sign in".
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Access } from "../auth/rbac.ts";

type RequestState = { access?: Access };

const storage = new AsyncLocalStorage<RequestState>();

export function runWithRequestState<T>(fn: () => T): T {
  return storage.run({}, fn);
}

export function rememberViewer(access: Access | undefined): void {
  const state = storage.getStore();
  if (state) state.access = access;
}

export function currentViewer(): Access | undefined {
  return storage.getStore()?.access;
}
