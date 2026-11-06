// Adapted from the reference repository's integration suite; uses isolated data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import sharp from "sharp";

const namespace = `test-${randomUUID()}`;
const dataRoot = path.resolve(".data");
const directory = path.join(dataRoot, namespace);
const dataFile = path.join(directory, "studio.json");
const reservation = createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const base = `http://127.0.0.1:${port}`;
let server, output = "", completed = false;
async function start() {
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(), env: { ...process.env, CONSENTCRAFT_DATA_NAMESPACE: namespace }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", chunk => output += chunk);
  server.stderr.on("data", chunk => output += chunk);
  for (let i = 0; i < 150; i++) {
    try { if ((await fetch(`${base}/api/studio`)).ok) return; } catch {}
    if (server.exitCode !== null) throw new Error(output);
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`Server did not become ready: ${output}`);
}
async function stop() {
  if (server && server.exitCode === null) { const ended = once(server, "exit"); server.kill(); await ended; }
}
function client() {
  let cookie = "";
  return {
    async get(query = "", expected = 200) {
      const response = await fetch(`${base}/api/studio${query}`, { headers: { Cookie: cookie } });
      const body = await response.json();
      assert.equal(response.status, expected, JSON.stringify(body));
      assert.equal(response.headers.get("cache-control"), "no-store");
      return body;
    },
    async post(body, expected = 200, origin = base) {
      const response = await fetch(`${base}/api/studio`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie }, body: JSON.stringify(body) });
      const result = await response.json();
      if (Array.isArray(expected)) assert.ok(expected.includes(response.status), `${body.action}: ${JSON.stringify(result)}`);
      else assert.equal(response.status, expected, `${body.action}: ${JSON.stringify(result)}`);
      const session = response.headers.get("set-cookie");
      if (session) {
        cookie = session.split(";")[0];
        if (body.action !== "logout") { assert.match(session, /HttpOnly/i); assert.match(session, /SameSite=strict/i); }
      }
      assert.equal(JSON.stringify(result).includes('"password"'), false);
      assert.equal(JSON.stringify(result).includes('"salt"'), false);
      return { ...result, _status: response.status };
    },
  };
}

try {
  await start();
  const owner = client(), collaborator = client(), other = client(), anonymous = client();
  assert.deepEqual(await anonymous.get(), { user: null, projects: [], comics: [], invitations: [] });
  await anonymous.post({ action: "create", title: "Blocked" }, 401);
  await owner.post({ action: "signup", name: "Owner", email: "owner@example.test", password: "short" }, 400);
  // Password whitespace is significant and survives the full login flow.
  const password = " correct horse studio ";
  await owner.post({ action: "signup", name: "Owner", email: "OWNER@example.test", password });
  await other.post({ action: "signup", name: "Duplicate", email: "owner@example.test", password }, 409);
  await collaborator.post({ action: "signup", name: "Collaborator", email: "collaborator@example.test", password });
  await other.post({ action: "signup", name: "Other", email: "other@example.test", password });
  const ownerId = (await owner.get()).user.id;
  const collaboratorId = (await collaborator.get()).user.id;
  const { id } = await owner.post({ action: "create", title: "Shared story", description: "A real saved draft", genre: "Adventure" });
  const getProject = async (who = owner) => (await who.get()).projects.find(p => p.id === id);
  const mutate = async (who, action, extra = {}, expected = 200) => {
    const project = await getProject(who);
    return who.post({ action, id, revision: project.revision, ...extra }, expected);
  };
  assert.equal((await getProject()).genre, "Adventure");
  assert.equal((await getProject()).panels.length, 4);
  assert.equal((await collaborator.get()).projects.length, 0);
  await collaborator.get(`?invitations=${id}`, 404);
  await other.post({ action: "save", id }, 404);
  await owner.post({ action: "create", title: "Cross-origin" }, 403, "https://other.example");
  const malformed = await fetch(`${base}/api/studio`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: "[" });
  assert.equal(malformed.status, 400);
  const array = await fetch(`${base}/api/studio`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: "[]" });
  assert.equal(array.status, 400);
  const oversized = await fetch(`${base}/api/studio`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify({ excess: "x".repeat(16_000_000) }) });
  assert.equal(oversized.status, 413);
  console.log("PASS accounts, cookies, private workspaces, request validation, and origin checks");

  const invite = await owner.post({ action: "invite", id, email: "COLLABORATOR@example.test" });
  await owner.post({ action: "invite", id, email: "collaborator@example.test" }, 409);
  assert.equal((await collaborator.get()).invitations[0].projectTitle, "Shared story");
  await other.post({ action: "accept", token: invite.token }, 403);
  await collaborator.post({ action: "accept", token: invite.token });
  await collaborator.post({ action: "accept", token: invite.token }, 404);
  assert.equal((await getProject()).members.length, 2);
  assert.equal((await collaborator.get()).invitations.length, 0);
  await collaborator.post({ action: "invite", id, email: "other@example.test" }, 403);
  const canceled = await owner.post({ action: "invite", id, email: "other@example.test" });
  await collaborator.post({ action: "cancelInvite", id, invitation: canceled.token }, 403);
  await owner.post({ action: "cancelInvite", id, invitation: canceled.token });
  await other.post({ action: "accept", token: canceled.token }, 404);
  assert.equal((await owner.get(`?invitations=${id}`)).invitations.length, 0);
  console.log("PASS email-bound, single-use invitations, owner permissions, inboxes, and cancellation");

  const png = await sharp({ create: { width: 16, height: 12, channels: 3, background: "#c6b3ed" } }).png().toBuffer();
  const image = `data:image/png;base64,${png.toString("base64")}`;
  const project = await getProject();
  const payload = { title: project.title, description: project.description, terms: project.terms, priceWei: "0", members: project.members.map(m => ({ ...m, share: 5000 })), panels: Array.from({ length: 4 }, (_, i) => ({ image, dialogue: i ? `Panel ${i + 1}` : "", alt: `Scene ${i + 1}` })) };
  for (const invalid of ["/art/space.svg", "https://example.test/art.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/png;base64,iVBORw0KGgo=", `data:image/jpeg;base64,${png.toString("base64")}`]) {
    await mutate(owner, "save", { ...payload, panels: payload.panels.map((panel, i) => i ? panel : { ...panel, image: invalid }) }, 400);
  }
  await mutate(owner, "save", { ...payload, members: payload.members.map(m => ({ ...m, share: -1 })) }, 400);
  await mutate(owner, "save", { ...payload, members: payload.members.map(m => ({ ...m, share: 2500 })) }, 400);
  await mutate(owner, "save", { ...payload, members: [payload.members[0], payload.members[0]] }, 400);
  assert.equal((await getProject()).revision, project.revision);
  assert.deepEqual((await getProject()).panels, project.panels);
  await mutate(owner, "save", payload);
  const saved = await getProject();
  assert.ok(saved.panels[0].image.startsWith("data:image/jpeg;base64,"));
  const decoded = await sharp(Buffer.from(saved.panels[0].image.split(",")[1], "base64")).metadata();
  assert.equal(decoded.width, 16); assert.equal(decoded.height, 12);
  await owner.post({ action: "save", id, revision: project.revision, ...payload }, 409);
  const common = await getProject();
  const concurrent = await Promise.all([owner, collaborator].map(who => who.post({ action: "save", id, revision: common.revision, ...payload }, [200, 409])));
  assert.deepEqual(concurrent.map(result => result._status).sort(), [200, 409]);
  // A collaborator can save panels, but cannot replace owner settings or the roster.
  await mutate(collaborator, "save", { ...payload, title: "Hijacked", members: [], panels: payload.panels.map(p => ({ ...p, dialogue: "Collaborator edit" })) });
  const shared = await getProject();
  assert.equal(shared.title, "Shared story");
  assert.deepEqual(shared.members.map(m => m.userId), [ownerId, collaboratorId]);
  assert.equal(shared.panels[0].dialogue, "Collaborator edit");
  for (const action of ["review", "approve", "revoke", "publish"]) await mutate(owner, action, {}, 403);
  assert.equal((await anonymous.get()).comics.length, 0);
  console.log("PASS image decoding, atomic validation, role boundaries, concurrent edit conflicts, and disabled chain actions");

  const disk = JSON.parse(await readFile(dataFile, "utf8"));
  assert.ok(disk.users.every(user => user.password !== password && user.password.length === 128));
  await stop(); await start();
  assert.equal((await getProject()).panels[0].dialogue, "Collaborator edit");
  await owner.post({ action: "logout" });
  assert.equal((await owner.get()).user, null);
  await owner.post({ action: "login", email: "owner@example.test", password: password.trim() }, 401);
  await owner.post({ action: "login", email: "owner@example.test", password });
  assert.equal((await getProject()).members.length, 2);
  await stop();
  const expiring = JSON.parse(await readFile(dataFile, "utf8"));
  expiring.sessions.forEach(session => { session.expires = 0; });
  await writeFile(dataFile, JSON.stringify(expiring));
  await start();
  assert.equal((await owner.get()).user, null);
  await owner.post({ action: "create", title: "Expired" }, 401);
  console.log("PASS password hashing, restart persistence, sign-out/sign-in, and expired sessions");
  completed = true;
} catch (error) { console.error(output); throw error; }
finally {
  await stop();
  // The only recursive cleanup target is the generated test namespace.
  assert.equal(path.dirname(path.resolve(directory)), dataRoot);
  assert.match(path.basename(directory), /^test-[a-f0-9-]+$/);
  if (completed) await rm(directory, { recursive: true, force: true });
}
