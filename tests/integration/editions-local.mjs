// Isolated integration test: real contract, SIWE and reader HTTP endpoints.
// Storage and approved content are synthetic fixtures; no live AI/personhood claim.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer as netServer } from "node:net";
import { createServer } from "node:http";
import { createCipheriv, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { createPublicClient, createWalletClient, http, keccak256, toHex, zeroHash } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { hardhat } from "viem/chains";
import { editionPermitTypes } from "../../lib/edition-permit.ts";
const children = []; const root = process.cwd();
const namespace = `editions-test-${randomUUID()}`;
const file = path.join(root, ".data", namespace, "studio.json");
const artifact = JSON.parse(await readFile("contracts/artifacts/contracts/ConsentCraftEditions.sol/ConsentCraftEditions.json", "utf8"));
async function port() { const s = netServer(); s.listen(0, "127.0.0.1"); await once(s, "listening"); const p = s.address().port; await new Promise(r => s.close(r)); return p; }
function start(args, opts = {}) { const c = spawn(process.execPath, args, { cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...opts }); let output = ""; c.stdout.on("data", d => output = (output + d).slice(-1000000)); c.stderr.on("data", d => output = (output + d).slice(-1000000)); c.output = () => output; children.push(c); return c; }
async function ready(fn) { for (let i = 0; i < 120; i++) { try { if (await fn()) return; } catch {} await new Promise(r => setTimeout(r, 300)); } throw new Error("Test service failed to start."); }
const items = new Map();
const storage = createServer((req, res) => { const bytes = items.get(req.url.split("/").at(-1)); res.writeHead(bytes ? 200 : 404); res.end(bytes || "missing"); });
storage.listen(0, "127.0.0.1"); await once(storage, "listening");
try {
  const nodePort = await port(); const rpc = `http://127.0.0.1:${nodePort}`;
  start(["../node_modules/hardhat/dist/src/cli.js", "node", "--hostname", "127.0.0.1", "--port", String(nodePort)], { cwd: path.join(root, "contracts") });
  const client = createPublicClient({ chain: hardhat, transport: http(rpc) }); await ready(async () => await client.getChainId() === 31337);
  const [creator, reviewer, alice, bob, treasury] = Array.from({ length: 5 }, () => privateKeyToAccount(generatePrivateKey()));
  for (const a of [creator, reviewer, alice, bob, treasury]) await client.request({ method: "hardhat_setBalance", params: [a.address, "0x3635c9adc5dea00000"] });
  const wallet = a => createWalletClient({ chain: hardhat, transport: http(rpc), account: a });
  const tx = await wallet(creator).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args: [reviewer.address, treasury.address] });
  const address = (await client.waitForTransactionReceipt({ hash: tx })).contractAddress;
  const kek = randomBytes(32); const serverPort = await port(); const base = `http://127.0.0.1:${serverPort}`;
  start(["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(serverPort)], { env: { ...process.env, CONSENTCRAFT_DATA_NAMESPACE: namespace, APP_ORIGIN: base, NEXT_PUBLIC_EDITIONS_ADDRESS: address, NEXT_PUBLIC_CHAIN_ID: "31337", CHAIN_RPC_URL: rpc, CHAIN_CONFIRMATIONS: "0", CONTENT_KEY_ENCRYPTION_KEY: toHex(kek), ARWEAVE_GATEWAY: `http://127.0.0.1:${storage.address().port}`, ARKIV_ACCESS_KEY: "", ARKIV_WRITER_ADDRESS: "" } });
  await ready(async () => (await fetch(`${base}/api/studio`)).ok);
  function session() { const jar = new Map(); return { call: async (url, body, status = 200) => { const res = await fetch(base + url, { method: body ? "POST" : "GET", headers: { Origin: base, Cookie: [...jar].map(([k,v]) => `${k}=${v}`).join("; "), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }); for (const c of res.headers.getSetCookie()) { const [k, v] = c.split(";")[0].split("="); if(v) jar.set(k,v); else jar.delete(k); } const data = await res.json(); assert.equal(res.status, status, `${url}: ${JSON.stringify(data)}`); return data; } }; }
  const sessions = [session(), session(), session()];
  for (const [i, a] of [creator, alice, bob].entries()) { const { message } = await sessions[i].call("/api/studio", { action: "challenge", address: a.address, chainId: 31337 }); await sessions[i].call("/api/studio", { action: "siwe", message, signature: await a.signMessage({ message }) }); }
  const [authorSession, aliceSession, bobSession] = sessions;
  const { id } = await authorSession.call("/api/studio", { action: "create", title: "Ownership fixture", genre: "Fantasy" });
  function seal(key, plain, aad) { const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(aad)); return { iv, body: Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]) }; }
  const contentKey = randomBytes(32); const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: "red" } }).jpeg().toBuffer();
  const pages = Array.from({ length: 4 }, (_, index) => { const plain = Buffer.from(JSON.stringify({ mime: "image/jpeg", image: jpeg.toString("base64"), dialogue: `Private line ${index}`, alt: "Fixture" })); const s = seal(contentKey, plain, `consentcraft.bundle.v1:page:${index}`); return { index, iv: s.iv.toString("base64"), ciphertext: s.body.toString("base64"), plaintextHash: keccak256(plain) }; });
  const bundle = Buffer.from(JSON.stringify({ schema: "consentcraft.bundle.v1", cipher: "AES-256-GCM", pageCount: 4, pages }));
  const bundleId = randomBytes(32).toString("base64url"); const metadataId = randomBytes(32).toString("base64url"); const uri = `ar://${metadataId}`; const key = keccak256(toHex(id));
  const metadata = Buffer.from(JSON.stringify({ name: "Ownership fixture", description: "Fixture", genre: "Fantasy", license: "Read while owned" })); items.set(bundleId, bundle); items.set(metadataId, metadata);
  const wrapped = seal(kek, contentKey, `consentcraft:key:${id}`);
  const db = JSON.parse(await readFile(file, "utf8")); const p = db.projects.find(p => p.id === id);
  p.edition = { key, manifestHash: keccak256(bundle), bundleTxId: bundleId, coverTxId: "c".repeat(43), supply: 2, license: "Read while owned", rightsAt: new Date().toISOString(), status: "approved", chainId: 31337, contract: address, uri, metadataHash: keccak256(metadata) };
  db.editionSecrets = { [id]: { wrappedKey: `${wrapped.iv.toString("base64")}.${wrapped.body.toString("base64")}` } }; await writeFile(file, JSON.stringify(db));
  const permit = { author: creator.address, key, manifestHash: keccak256(bundle), metadataHash: keccak256(metadata), uriHash: keccak256(toHex(uri)), licenseHash: keccak256(toHex("Read while owned")), auctionHash: zeroHash, supply: 2, deadline: BigInt((await client.getBlock()).timestamp) + 10000n };
  const signature = await reviewer.signTypedData({ domain: { name: "ConsentCraftEditions", version: "1", chainId: 31337, verifyingContract: address }, types: editionPermitTypes, primaryType: "Permit", message: permit });
  async function send(a, functionName, args, value) { const hash = await wallet(a).writeContract({ address, abi: artifact.abi, functionName, args, value }); const r = await client.waitForTransactionReceipt({ hash }); assert.equal(r.status, "success"); }
  await send(creator, "createComic", [permit, uri, signature]); await authorSession.call("/api/editions", { action: "confirm", id });
  assert.equal((await authorSession.call(`/api/editions?view=access&wallet=${creator.address}`)).unlocked, false, "Unsold creator inventory does not unlock Trade");
  assert.equal((await aliceSession.call(`/api/editions?view=access&wallet=${alice.address}`)).unlocked, false);
  await authorSession.call("/api/editions/read/1", undefined, 403);
  await send(creator, "openAuction", [1n, 10000n, 3600n]); await send(alice, "bid", [1n], 10000n); await client.request({ method: "evm_increaseTime", params: [3601] }); await client.request({ method: "evm_mine", params: [] }); await send(bob, "settleAuction", [1n]);
  assert.equal((await aliceSession.call(`/api/editions?view=access&wallet=${alice.address}`)).unlocked, true);
  assert.equal((await aliceSession.call("/api/editions/read/1")).pages[0].dialogue, "Private line 0");
  await bobSession.call("/api/editions/read/1", undefined, 403);
  await send(alice, "transferFrom", [alice.address, bob.address, 1n]);
  assert.equal((await aliceSession.call(`/api/editions?view=access&wallet=${alice.address}`)).unlocked, false, "Giving away the last comic relocks Trade");
  assert.equal((await bobSession.call(`/api/editions?view=access&wallet=${bob.address}`)).unlocked, true);
  await aliceSession.call("/api/editions/read/1", undefined, 403); assert.equal((await bobSession.call("/api/editions/read/1")).pages.length, 4);
  await send(reviewer, "setDelisted", [1n, true]); assert.equal((await bobSession.call("/api/editions/read/1")).pages.length, 4);
  const snapshot = await bobSession.call("/api/editions?view=secondary"); assert.ok(snapshot.tokens.some(t => t.id === "1" && t.owner.toLowerCase() === bob.address.toLowerCase()));
  assert.ok(!JSON.stringify(snapshot).includes("Private line"));
  const index = start(["indexer/src/editions.ts", "--dry-run"], { env: { ...process.env, INDEXER_EDITIONS_ADDRESS: address, NEXT_PUBLIC_EDITIONS_ADDRESS: address, INDEXER_SOURCE_RPC_URL: rpc, INDEXER_CONFIRMATIONS: "0", ARWEAVE_GATEWAY: `http://127.0.0.1:${storage.address().port}` } });
  const [code] = await once(index, "exit"); assert.equal(code, 0, index.output()); assert.ok(index.output().includes('"kind":"token"')); assert.ok(!index.output().includes("Private line"));
  console.log("PASS: real SIWE + NFT auctions + reader ownership transfer/revocation + delisting + public index dry-run");
  console.log(`Synthetic fixture namespace retained for inspection: ${namespace}`);
} finally {
  for (const child of children.reverse()) if (child.exitCode === null) child.kill();
  await new Promise(r => storage.close(r));
}
