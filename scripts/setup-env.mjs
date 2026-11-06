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
  const target = new URL("../.env.local", import.meta.url);
  const existing = await readFile(target, "utf8");
  const names = new Set([...existing.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map(m => m[1]));
  let publicWriter = "";
  try { publicWriter = (await readFile(new URL("../indexer/.env", import.meta.url), "utf8")).match(/^ARKIV_WRITER_ADDRESS=(0x[\da-fA-F]{40})\s*$/m)?.[1] || ""; } catch {}
  const additions = template.split(/\r?\n/).filter(l => /^[A-Z][A-Z0-9_]*=/.test(l) && !names.has(l.split("=")[0])).map(l => {
    if (l === "CONTENT_KEY_ENCRYPTION_KEY=") return `CONTENT_KEY_ENCRYPTION_KEY=0x${randomBytes(32).toString("hex")}`;
    if (l === "SESSION_SECRET=") return `SESSION_SECRET=${randomBytes(32).toString("hex")}`;
    if (l === "ARKIV_WRITER_ADDRESS=" && publicWriter) return `ARKIV_WRITER_ADDRESS=${publicWriter}`;
    return l;
  });
  if (additions.length) await writeFile(target, `${existing.trimEnd()}\n\n# Added missing settings; existing values were preserved.\n${additions.join("\n")}\n`, { mode: 0o600 });
  console.log(`Preserved all existing .env.local values; added ${additions.length} missing settings. External credentials must be supplied by the operator.`);
}
