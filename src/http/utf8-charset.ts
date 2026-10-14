import type { ServerResponse } from "node:http";

/** text/event-stream and application/json without a charset get "; charset=utf-8". */
export function withUtf8(value: string): string {
  if (/;\s*charset=/i.test(value)) return value;
  if (/^\s*(text\/event-stream|application\/json)\s*(;|$)/i.test(value)) return `${value.trim()}; charset=utf-8`;
  return value;
}

/**
 * MCP responses are UTF-8, but the SDK sends `text/event-stream` with no charset,
 * so strict clients decode em dashes and accents as Latin-1. Add the charset on
 * whatever path the SDK uses to set the header.
 */
export function declareUtf8(res: ServerResponse): void {
  const setHeader = res.setHeader.bind(res);
  res.setHeader = ((name: string, value: number | string | readonly string[]) =>
    setHeader(name, name.toLowerCase() === "content-type" && typeof value === "string" ? withUtf8(value) : value)) as typeof res.setHeader;
  const writeHead = res.writeHead.bind(res) as (...args: unknown[]) => ServerResponse;
  res.writeHead = ((...args: unknown[]) => {
    for (const arg of args) {
      if (Array.isArray(arg)) {
        // Raw [name, value, name, value, ...] or [[name, value], ...].
        if (arg.every((entry) => Array.isArray(entry))) {
          for (const pair of arg as [string, unknown][]) {
            if (String(pair[0]).toLowerCase() === "content-type" && typeof pair[1] === "string") pair[1] = withUtf8(pair[1]);
          }
        } else {
          for (let i = 0; i + 1 < arg.length; i += 2) {
            if (String(arg[i]).toLowerCase() === "content-type" && typeof arg[i + 1] === "string") arg[i + 1] = withUtf8(arg[i + 1]);
          }
        }
      } else if (arg && typeof arg === "object") {
        const headers = arg as Record<string, unknown>;
        for (const key of Object.keys(headers)) {
          if (key.toLowerCase() === "content-type" && typeof headers[key] === "string") headers[key] = withUtf8(headers[key] as string);
        }
      }
    }
    const current = res.getHeader("content-type");
    if (typeof current === "string") setHeader("content-type", withUtf8(current));
    return writeHead(...args);
  }) as typeof res.writeHead;
}
