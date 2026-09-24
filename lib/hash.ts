import { createHash } from "node:crypto";

export function sha256(buffer: Buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}
