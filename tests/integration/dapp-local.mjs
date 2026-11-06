// End-to-end dApp test against a real local chain and real Arweave storage.
//
//   npm run build && npm run test:dapp
//
// Real: Hardhat chain + the deployed ConsentCraftMarket, the production app build,
// SIWE sign-in, EIP-712 quotes and certificates, every transaction, AES-GCM
// encryption, and uploads to the ar.io testnet sandbox (free, needs internet).
// Not live here: World ID (needs your registered app; the test marks its two
// accounts verified in the data file) and 0G (needs a funded 0G wallet; the test
// checks that the review fails safely, then submits a report with the reporter key).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import sharp from "sharp";
import { createPublicClient, createWalletClient, http, keccak256, parseEther, toHex } from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";

const root = process.cwd();
const abi = JSON.parse(await readFile(path.join(root, "contracts/abi/ConsentCraftMarket.json"), "utf8"));
const MARKET_ABI = Array.isArray(abi) ? abi : abi.abi;
const mnemonic = "test test test test test test test test test test test junk";
const hh = i => mnemonicToAccount(mnemonic, { addressIndex: i });
const keyOf = i => toHex(hh(i).getHdKey().privateKey);
const rpc = "http://127.0.0.1:8545";
const chain = createPublicClient({ chain: hardhat, transport: http(rpc, { retryCount: 0, timeout: 5000 }) });
const wallet = account => createWalletClient({ account, chain: hardhat, transport: http(rpc) });
const children = [];
const log = msg => console.log(`  ${msg}`);

function run(cmd, args, opts = {}) {
  const child = spawn(cmd, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], ...opts });
  let out = ""; child.stdout.on("data", d => out += d); child.stderr.on("data", d => out += d);
  child.output = () => out;
  children.push(child);
  return child;
}
async function freePort() {
  const s = createServer(); s.listen(0, "127.0.0.1"); await once(s, "listening");
  const { port } = s.address(); await new Promise(r => s.close(r)); return port;
}
async function waitFor(check, label, tries = 200) {
  const t0 = Date.now();
  for (let i = 0; i < tries; i++) { try { if (await check()) return; } catch {} await new Promise(r => setTimeout(r, 300)); }
  throw new Error(`Timed out waiting for ${label} after ${Math.round((Date.now() - t0) / 1000)}s`);
}

let failed = false;
try {
  // 1. Local chain and contract.
  const node = run(process.execPath, ["../node_modules/hardhat/dist/src/cli.js", "node", "--hostname", "127.0.0.1"], { cwd: path.join(root, "contracts") });
  await waitFor(async () => (await chain.getChainId()) === 31337, "hardhat node");
  const deploy = run(process.execPath, ["--env-file=local-node.env", "../node_modules/hardhat/dist/src/cli.js", "run", "--network", "localhost", "scripts/deploy.ts"],
    { cwd: path.join(root, "contracts"), env: { ...process.env, DEPLOYMENTS_OUT: "deployments/localhost.json" } });
  const [code] = await once(deploy, "exit");
  assert.equal(code, 0, deploy.output());
  const deployment = JSON.parse(await readFile(path.join(root, "contracts/deployments/localhost.json"), "utf8"));
  const market = deployment.address;
  log(`contract ${market} (hardhat node pid ${node.pid})`);

  // 2. The production app, wired to the chain. Hardhat accounts 3 and 4 hold the quote-signer and reporter roles.
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const namespace = `dapp-${randomUUID()}`;
  const dataFile = path.join(root, ".data", namespace, "studio.json");
  run(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    env: {
      ...process.env, CONSENTCRAFT_DATA_NAMESPACE: namespace, APP_ORIGIN: base, RATE_LIMIT_MULTIPLIER: "100",
      NEXT_PUBLIC_CHAIN_ID: "31337", NEXT_PUBLIC_MARKETPLACE_ADDRESS: market, CHAIN_RPC_URL: rpc, MARKET_START_BLOCK: deployment.startBlock,
      QUOTE_SIGNER_PRIVATE_KEY: keyOf(3), RELAYER_PRIVATE_KEY: keyOf(7),
      CONTENT_KEY_ENCRYPTION_KEY: toHex(randomBytes(32)), ARWEAVE_UPLOAD_PRIVATE_KEY: generatePrivateKey(),
      PUBLISH_DEPOSIT_WEI: parseEther("0.005").toString(), PUBLISH_AI_CAP_WEI: parseEther("0.0005").toString(),
      ZG_PRIVATE_KEY: "", ZG_PROVIDER_ADDRESS: "", ZG_ETH_PER_0G: "", REPORTER_PRIVATE_KEY: "",
    },
  });
  await waitFor(async () => (await fetch(`${base}/api/status`)).ok, "app server");

  function client() {
    const cookies = new Map();
    const header = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    const take = res => { for (const h of res.headers.getSetCookie()) { const [n, v] = h.split(";")[0].split("="); if (v) cookies.set(n, v); else cookies.delete(n); } };
    const call = async (route, body, expected = 200) => {
      const res = await fetch(`${base}${route}`, body ? { method: "POST", headers: { "Content-Type": "application/json", Origin: base, Cookie: header() }, body: JSON.stringify(body) } : { headers: { Cookie: header() } });
      take(res);
      const json = await res.json();
      assert.equal(res.status, expected, `${route} ${body?.action ?? body?.step ?? ""}: ${JSON.stringify(json)}`);
      return json;
    };
    return { call, cookies: header };
  }
  async function signIn(c, account) {
    const { message } = await c.call("/api/studio", { action: "challenge", address: account.address, chainId: 31337 });
    await c.call("/api/studio", { action: "siwe", message, signature: await account.signMessage({ message }) });
  }
  async function markWorldIdVerified(address) {
    const db = JSON.parse(await readFile(dataFile, "utf8"));
    db.users.find(u => u.address.toLowerCase() === address.toLowerCase()).worldIdVerifiedAt = new Date().toISOString();
    await writeFile(dataFile, JSON.stringify(db));
  }
  const send = async (account, functionName, args, value) => {
    const hash = await wallet(account).writeContract({ address: market, abi: MARKET_ABI, functionName, args, value });
    const receipt = await chain.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success", `${functionName} ${hash}`);
    return hash;
  };
  const read = (functionName, args = []) => chain.readContract({ address: market, abi: MARKET_ABI, functionName, args });

  const author = hh(11), buyer = hh(12), stranger = hh(13);
  const a = client(), b = client(), s = client();
  await signIn(a, author); await signIn(b, buyer); await signIn(s, stranger);
  log("three wallets signed in with SIWE");

  // 3. Certificates are refused until World ID verification.
  await b.call("/api/personhood", { step: "certificate", action: "purchase" }, 403);
  await b.call("/api/personhood", { step: "start" }, 503); // World ID app not configured here
  log("certificate refused without World ID; World ID reports not configured");

  // 4. Author drafts a 4-panel comic.
  const { id } = await a.call("/api/studio", { action: "create", title: "The Lantern Keeper", description: "A lighthouse at the end of the world.", genre: "Fantasy" });
  const img = async seed => `data:image/png;base64,${(await sharp(Buffer.from(Array.from({ length: 96 * 64 * 3 }, (_, i) => (i * seed + (i >> 5)) % 256)), { raw: { width: 96, height: 64, channels: 3 } }).png().toBuffer()).toString("base64")}`;
  const panels = await Promise.all([3, 7, 11, 13].map(async (n, i) => ({ image: await img(n), dialogue: `Secret line ${i + 1}`, alt: `Panel ${i + 1}` })));
  let studio = await a.call("/api/studio");
  let project = studio.projects.find(p => p.id === id);
  await a.call("/api/studio", { action: "save", id, revision: project.revision, title: project.title, description: project.description, panels, members: project.members, terms: project.terms, priceWei: parseEther("0.001").toString() });
  project = (await a.call("/api/studio")).projects.find(p => p.id === id);

  await a.call("/api/publish", { action: "prepare", id, revision: project.revision, language: "en" }, 403);
  await markWorldIdVerified(author.address);
  await markWorldIdVerified(buyer.address);

  // 5. Encrypt, upload to Arweave (real), sign a quote.
  const started = Date.now();
  let prepared;
  for (let attempt = 1; !prepared; attempt++) {
    // A slow gateway returns 503 after the uploads are saved; retrying only re-verifies.
    const res = await fetch(`${base}/api/publish`, { method: "POST", headers: { "Content-Type": "application/json", Origin: base, Cookie: a.cookies() }, body: JSON.stringify({ action: "prepare", id, revision: project.revision, language: "en" }) });
    const body = await res.json();
    if (res.status === 200) prepared = body;
    else if (res.status === 503 && attempt < 5) log(`gateway not serving yet (attempt ${attempt}): retrying`);
    else assert.fail(`prepare: ${res.status} ${JSON.stringify(body)}`);
  }
  const pub = prepared.publication;
  log(`Arweave (ar.io sandbox) in ${((Date.now() - started) / 1000).toFixed(1)}s: bundle ${pub.bundleTxId}, preview ${pub.previewTxId}, cover ${pub.previewImageTxId}`);
  const gateway = await fetch(`https://ar-io.dev/raw/${pub.bundleTxId}`);
  const bundleBytes = new Uint8Array(await gateway.arrayBuffer());
  assert.equal(keccak256(bundleBytes), pub.manifestHash, "gateway bytes match the on-chain fingerprint");
  assert.ok(!Buffer.from(bundleBytes).toString().includes("Secret line"), "captions are encrypted on Arweave");

  // 6. Author's wallet creates the publication.
  const q = pub.quote, c = prepared.certificate;
  const quote = { author: q.author, manifestHash: q.manifestHash, previewManifestHash: q.previewManifestHash, arweaveBundleTxId: q.arweaveBundleTxId, arweavePreviewTxId: q.arweavePreviewTxId,
    pageCount: Number(q.pageCount), policyId: BigInt(q.policyId), price: BigInt(q.price), deposit: BigInt(q.deposit), aiCap: BigInt(q.aiCap), ratingSnapshot: Number(q.ratingSnapshot), expiresAt: BigInt(q.expiresAt), nonce: BigInt(q.nonce) };
  const cert = { wallet: c.wallet, action: Number(c.action), expiresAt: BigInt(c.expiresAt), nonce: BigInt(c.nonce) };
  const createTx = await send(author, "createPublication", [quote, pub.quoteSignature, cert, prepared.certificateSignature], quote.deposit);
  const confirmed = await a.call("/api/publish", { action: "confirm", id, txHash: createTx });
  const publicationId = BigInt(confirmed.publication.publicationId);
  log(`createPublication ${createTx} -> publication #${publicationId}`);

  // 7. 0G is not configured: the review must fail safely and sign nothing.
  await waitFor(async () => (await a.call("/api/studio")).projects.find(p => p.id === id).publication.status === "review_failed", "review_failed");
  project = (await a.call("/api/studio")).projects.find(p => p.id === id);
  assert.match(project.publication.reviewError, /0G AI review is not configured/);
  assert.equal((await read("getPublication", [publicationId])).state, 0, "still Deposited, nothing signed");
  log(`review failed safely: "${project.publication.reviewError}"`);

  // The reporter key (Hardhat #4 holds REPORTER_ROLE) signs a report; anyone relays it.
  const { signReviewReport } = await import(path.join(root, "contracts/lib/eip712.ts")).catch(() => ({}));
  const report = { publicationId, manifestHash: pub.manifestHash, arweaveBundleTxId: q.arweaveBundleTxId, reportHash: keccak256(toHex("test-report")), modelVersion: keccak256(toHex("test")),
    promptVersion: keccak256(toHex("test")), policyId: BigInt(q.policyId), score: 8000, flagged: false, aiCost: parseEther("0.0002"), jobId: toHex(randomBytes(32)) };
  const reporter = privateKeyToAccount(keyOf(4));
  const signature = signReviewReport ? await signReviewReport(reporter, 31337, market, report) : await reporter.signTypedData({
    domain: { name: "ConsentCraftMarket", version: "1", chainId: 31337, verifyingContract: market },
    types: { ReviewReport: [["publicationId", "uint256"], ["manifestHash", "bytes32"], ["arweaveBundleTxId", "bytes32"], ["reportHash", "bytes32"], ["modelVersion", "bytes32"], ["promptVersion", "bytes32"], ["policyId", "uint256"], ["score", "uint16"], ["flagged", "bool"], ["aiCost", "uint256"], ["jobId", "bytes32"]].map(([name, type]) => ({ name, type })) },
    primaryType: "ReviewReport", message: report,
  });
  await send(hh(7), "submitReviewReport", [publicationId, report, signature]);
  await a.call("/api/publish", { action: "retryReview", id });
  await waitFor(async () => (await a.call("/api/studio")).projects.find(p => p.id === id).publication.status === "reviewed", "status synced from chain");
  log("report relayed; server synced status from chain without re-reviewing");

  // 8. Author lists it; the marketplace reads chain + verified Arweave preview.
  await send(author, "publish", [publicationId]);
  const { listings } = await s.call("/api/market");
  const listing = listings.find(l => l.publicationId === publicationId.toString());
  assert.equal(listing.title, "The Lantern Keeper");
  assert.equal(listing.verified, true, "preview manifest matched its on-chain hash");
  assert.equal(listing.state, 4); assert.equal(listing.listingState, 1);
  log(`marketplace: "${listing.title}" ${listing.price} wei, cover ${listing.cover}`);

  // 9. Access control on the reader.
  await s.call(`/api/read/${publicationId}`, undefined, 403);
  const own = await a.call(`/api/read/${publicationId}`);
  assert.equal(own.pages[2].dialogue, "Secret line 3");

  // 10. Buyer gets a purchase certificate and buys.
  const bc = await b.call("/api/personhood", { step: "certificate", action: "purchase" });
  const buyCert = { wallet: bc.certificate.wallet, action: Number(bc.certificate.action), expiresAt: BigInt(bc.certificate.expiresAt), nonce: BigInt(bc.certificate.nonce) };
  await assert.rejects(send(stranger, "purchase", [publicationId, toHex(randomBytes(32)), buyCert, bc.signature], quote.price), "certificate is bound to the buyer's wallet");
  const buyTx = await send(buyer, "purchase", [publicationId, toHex(randomBytes(32)), buyCert, bc.signature], quote.price);
  const pages = (await b.call(`/api/read/${publicationId}`)).pages;
  assert.deepEqual(pages.map(p => p.dialogue), ["Secret line 1", "Secret line 2", "Secret line 3", "Secret line 4"]);
  assert.match(pages[0].image, /^data:image\/jpeg;base64,/);
  log(`purchase ${buyTx}; buyer decrypted 4 pages`);

  // 11. Refund after the delay: the AI cost is deducted.
  await chain.request({ method: "evm_increaseTime", params: [301] }); await chain.request({ method: "evm_mine", params: [] });
  const [retained, refund, owner] = await read("previewSettlement", [publicationId]);
  const deposit = quote.deposit;
  assert.equal(retained + refund, deposit);
  assert.ok(retained >= parseEther("0.0002"), "retained part covers at least the AI cost");
  const before = await read("creditOf", [author.address]);
  await send(author, "refundAndDelist", [publicationId, refund]);
  const after = await read("creditOf", [author.address]);
  assert.equal(after - before, refund);
  log(`refund: deposit ${deposit}, refunded ${refund}, retained ${retained} (AI cost 200000000000000, owner ${owner})`);
  await send(author, "withdraw", []);
  assert.equal(await read("creditOf", [author.address]), BigInt(0));
  assert.deepEqual((await b.call(`/api/read/${publicationId}`)).pages.length, 4, "buyer keeps access after delisting");
  log("author withdrew all credits; buyer keeps access after delisting");
  console.log("PASS dApp end-to-end on a local chain with real Arweave storage");
  await rm(path.join(root, ".data", namespace), { recursive: true, force: true });
} catch (error) {
  failed = true;
  console.error("FAIL", error);
  for (const child of children) if (child.output) console.error(`--- output of ${child.spawnargs.slice(1, 3).join(" ")} ---\n${child.output().slice(-3000)}`);
} finally {
  for (const child of children) if (child.exitCode === null) child.kill();
  await rm(path.join(root, "contracts/deployments/localhost.json"), { force: true });
  process.exit(failed ? 1 : 0);
}
