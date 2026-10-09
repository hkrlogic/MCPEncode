/**
 * Read one file from a multipart form. Stops at the size cap while streaming
 * so a large upload is not kept.
 */
import Busboy from "busboy";
import type { Request } from "express";
import { MAX_FILE_BYTES } from "../items/files.ts";

export type UploadRead =
  | { ok: true; filename: string; bytes: Buffer; csrf: string }
  | { ok: false; code: "not_multipart" | "missing" | "too_big"; csrf: string };

/** CSRF field plus a single file named "file". Extra parts are discarded. */
export function readItemUpload(req: Request): Promise<UploadRead> {
  const contentType = req.headers["content-type"];
  if (typeof contentType !== "string" || !contentType.toLowerCase().includes("multipart/form-data")) {
    return Promise.resolve({ ok: false, code: "not_multipart", csrf: "" });
  }

  return new Promise((resolve, reject) => {
    let csrf = "";
    let filename = "";
    let tooBig = false;
    let sawFile = false;
    let parserDone = false;
    let fileDone = true;
    const chunks: Buffer[] = [];
    let settled = false;

    const finish = (result: UploadRead) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const maybeDone = () => {
      if (!parserDone || !fileDone || settled) return;
      if (tooBig) {
        finish({ ok: false, code: "too_big", csrf });
        return;
      }
      if (!sawFile) {
        finish({ ok: false, code: "missing", csrf });
        return;
      }
      finish({ ok: true, filename, bytes: Buffer.concat(chunks), csrf });
    };

    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: req.headers,
        limits: {
          files: 1,
          // One byte past the cap so the limit event can reject without storing it.
          fileSize: MAX_FILE_BYTES + 1,
          fields: 8,
          fieldSize: 512,
          parts: 10,
        },
      });
    } catch {
      finish({ ok: false, code: "not_multipart", csrf: "" });
      return;
    }

    parser.on("field", (name: string, value: string) => {
      if (name === "csrf") csrf = value.slice(0, 200);
    });
    parser.on("file", (name: string, stream: NodeJS.ReadableStream, info: { filename?: string }) => {
      if (name !== "file" || sawFile) {
        stream.resume();
        return;
      }
      sawFile = true;
      fileDone = false;
      filename = info.filename ?? "";
      stream.on("data", (chunk: Buffer) => {
        if (!tooBig) chunks.push(chunk);
      });
      stream.on("limit", () => {
        tooBig = true;
        chunks.length = 0;
        stream.resume();
      });
      stream.on("close", () => {
        fileDone = true;
        maybeDone();
      });
    });
    parser.on("error", (error: unknown) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    parser.on("close", () => {
      parserDone = true;
      maybeDone();
    });
    req.pipe(parser);
  });
}
