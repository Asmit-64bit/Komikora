// Adapted from the reference repository's integration suite; uses isolated data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import sharp from "sharp";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { parseSiweMessage } from "viem/siwe";

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
function client(initial = {}) {
  const cookies = new Map(Object.entries(initial));
  const cookie = () => [...cookies].map(([key, value]) => `${key}=${value}`).join("; ");
  return {
    cookie: name => cookies.get(name),
    async get(query = "", expected = 200) {
      const response = await fetch(`${base}/api/studio${query}`, { headers: { Cookie: cookie() } });
      const body = await response.json();
      assert.equal(response.status, expected, JSON.stringify(body));
      assert.equal(response.headers.get("cache-control"), "no-store");
      return body;
    },
    async post(body, expected = 200, origin = base) {
      const response = await fetch(`${base}/api/studio`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie() }, body: JSON.stringify(body) });
      const result = await response.json();
      if (Array.isArray(expected)) assert.ok(expected.includes(response.status), `${body.action}: ${JSON.stringify(result)}`);
      else assert.equal(response.status, expected, `${body.action}: ${JSON.stringify(result)}`);
      for (const header of response.headers.getSetCookie()) {
        const [name, value] = header.split(";")[0].split("=");
        if (value) {
          cookies.set(name, value);
          assert.match(header, /HttpOnly/i); assert.match(header, /SameSite=strict/i);
        } else cookies.delete(name);
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
  const ownerWallet = privateKeyToAccount(generatePrivateKey());
  const collaboratorWallet = privateKeyToAccount(generatePrivateKey());
  const otherWallet = privateKeyToAccount(generatePrivateKey());
  const login = async (who, wallet) => {
    const { message } = await who.post({ action: "challenge", address: wallet.address.toLowerCase(), chainId: 1 });
    const parsed = parseSiweMessage(message);
    assert.equal(parsed.domain, new URL(base).host);
    assert.equal(parsed.uri, base);
    assert.equal(parsed.address, wallet.address);
    assert.ok(parsed.expirationTime.getTime() > Date.now());
    assert.ok(!who.cookie("cc_session"));
    return who.post({ action: "siwe", message, signature: await wallet.signMessage({ message }) });
  };
  for (const action of ["signup", "login"]) await owner.post({ action, name: "Legacy", email: "legacy@example.test", password: "old-password" }, 400);
  await owner.post({ action: "challenge", address: "not-an-address", chainId: 1 }, 400);
  await owner.post({ action: "challenge", address: ownerWallet.address, chainId: 0 }, 400);
  await owner.post({ action: "challenge", address: ownerWallet.address, chainId: 1 }, 403, "https://unrelated.example");
  const challenger = client();
  for (const change of [
    message => message.replace(new URL(base).host, "unrelated.example"),
    message => message.replace(`URI: ${base}`, "URI: https://unrelated.example"),
    message => message.replace("Chain ID: 1", "Chain ID: 2"),
    message => message.replace(ownerWallet.address, otherWallet.address),
    message => message.replace(/Nonce: .+/, "Nonce: invalidnonce"),
    message => message.replace(/Expiration Time: .+/, "Expiration Time: 2099-01-01T00:00:00.000Z"),
  ]) {
    const { message } = await challenger.post({ action: "challenge", address: ownerWallet.address, chainId: 1 });
    const altered = change(message);
    await challenger.post({ action: "siwe", message: altered, signature: await ownerWallet.signMessage({ message: altered }) }, 401);
    // A failed verification consumes the browser's challenge too.
    await challenger.post({ action: "siwe", message, signature: await ownerWallet.signMessage({ message }) }, 401);
  }
  const { message: wrongSignerMessage } = await challenger.post({ action: "challenge", address: ownerWallet.address, chainId: 1 });
  await challenger.post({ action: "siwe", message: wrongSignerMessage, signature: await otherWallet.signMessage({ message: wrongSignerMessage }) }, 401);
  const { message: browserMessage } = await owner.post({ action: "challenge", address: ownerWallet.address, chainId: 1 });
  const signed = { action: "siwe", message: browserMessage, signature: await ownerWallet.signMessage({ message: browserMessage }) };
  await anonymous.post(signed, 401);
  const competing = await Promise.all([owner.post(signed, [200, 401]), owner.post(signed, [200, 401])]);
  assert.deepEqual(competing.map(result => result._status).sort(), [200, 401]);
  await owner.post(signed, 401);
  assert.equal((await owner.get()).user.address, ownerWallet.address);
  await login(collaborator, collaboratorWallet);
  await login(other, otherWallet);
  console.log("PASS wallet-only login, real signatures, origin/message binding, single-use nonces, and cross-browser replay rejection");
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

  const invite = await owner.post({ action: "invite", id, address: collaboratorWallet.address.toLowerCase() });
  await owner.post({ action: "invite", id, address: collaboratorWallet.address }, 409);
  assert.equal((await collaborator.get()).invitations[0].projectTitle, "Shared story");
  await other.post({ action: "accept", token: invite.token }, 403);
  await collaborator.post({ action: "accept", token: invite.token });
  await collaborator.post({ action: "accept", token: invite.token }, 404);
  assert.equal((await getProject()).members.length, 2);
  assert.equal((await collaborator.get()).invitations.length, 0);
  await collaborator.post({ action: "invite", id, address: otherWallet.address }, 403);
  const canceled = await owner.post({ action: "invite", id, address: otherWallet.address });
  await collaborator.post({ action: "cancelInvite", id, invitation: canceled.token }, 403);
  await owner.post({ action: "cancelInvite", id, invitation: canceled.token });
  await other.post({ action: "accept", token: canceled.token }, 404);
  assert.equal((await owner.get(`?invitations=${id}`)).invitations.length, 0);
  console.log("PASS wallet-bound, single-use invitations, owner permissions, inboxes, and cancellation");

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
  assert.ok(disk.users.every(user => user.address && !("password" in user) && !("email" in user)));
  await stop(); await start();
  assert.equal((await getProject()).panels[0].dialogue, "Collaborator edit");
  await owner.post({ action: "logout" });
  assert.equal((await owner.get()).user, null);
  await login(owner, ownerWallet);
  assert.equal((await owner.get()).user.id, ownerId);
  assert.equal((await getProject()).members.length, 2);
  const { message: expiringMessage } = await challenger.post({ action: "challenge", address: ownerWallet.address, chainId: 1 });
  await stop();
  const expiring = JSON.parse(await readFile(dataFile, "utf8"));
  expiring.sessions.forEach(session => { session.expires = 0; });
  expiring.walletChallenges.forEach(challenge => { challenge.expires = 0; });
  const legacyAccount = { id: "legacy-account", name: "Legacy", email: "legacy@example.test", password: "old-hash", salt: "old-salt", color: "purple" };
  expiring.users.push(legacyAccount);
  expiring.sessions.push({ token: "legacy-session", userId: legacyAccount.id, expires: Date.now() + 60000 });
  expiring.sessions.push({ token: "unverified-wallet-session", userId: ownerId, expires: Date.now() + 60000 });
  const legacyProject = { ...expiring.projects[0], id: "legacy-project", ownerId: legacyAccount.id, members: [{ userId: legacyAccount.id, name: "Legacy", role: "Creator", share: 10000 }] };
  expiring.projects.push(legacyProject);
  await writeFile(dataFile, JSON.stringify(expiring));
  await start();
  assert.equal((await owner.get()).user, null);
  await owner.post({ action: "create", title: "Expired" }, 401);
  await challenger.post({ action: "siwe", message: expiringMessage, signature: await ownerWallet.signMessage({ message: expiringMessage }) }, 401);
  assert.equal((await client({ cc_session: "legacy-session" }).get()).user, null);
  assert.equal((await client({ cc_session: "unverified-wallet-session" }).get()).user, null);
  await client({ cc_session: "legacy-session" }).post({ action: "create", title: "Legacy access" }, 401);
  const newWalletSession = client();
  await login(newWalletSession, ownerWallet);
  assert.ok((await newWalletSession.get()).projects.every(project => project.id !== legacyProject.id));
  const preserved = JSON.parse(await readFile(dataFile, "utf8"));
  assert.deepEqual(preserved.users.find(user => user.id === legacyAccount.id), legacyAccount);
  assert.deepEqual(preserved.projects.find(project => project.id === legacyProject.id), legacyProject);
  console.log("PASS restart persistence, returning wallet identity, logout, expiry, legacy session rejection, and preservation of old drafts");
  completed = true;
} catch (error) { console.error(output); throw error; }
finally {
  await stop();
  // The only recursive cleanup target is the generated test namespace.
  assert.equal(path.dirname(path.resolve(directory)), dataRoot);
  assert.match(path.basename(directory), /^test-[a-f0-9-]+$/);
  if (completed) await rm(directory, { recursive: true, force: true });
}
