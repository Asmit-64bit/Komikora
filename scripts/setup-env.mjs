import { randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const template = await readFile(new URL("../.env.example", import.meta.url), "utf8");
try {
  await writeFile(
    new URL("../.env.local", import.meta.url),
    template
      .replace(/^SESSION_SECRET=$/m, `SESSION_SECRET=${randomBytes(32).toString("hex")}`)
      .replace(/^CONTENT_KEY_ENCRYPTION_KEY=$/m, `CONTENT_KEY_ENCRYPTION_KEY=0x${randomBytes(32).toString("hex")}`),
    { flag: "wx", mode: 0o600 },
  );
  console.log("Created .env.local with a random session secret, a content-encryption key and local service defaults.");
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  console.log(".env.local already exists; preserved all existing values.");
}
