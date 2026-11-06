"use client";
/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useId, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useConfig, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { getAccount } from "wagmi/actions";
import { formatEther, parseEther, isAddress, type Hex } from "viem";
import { editionRequest, editionsAddress, editionsChainId, editionsAbi, type EditionToken, type EditionSnapshot } from "@/lib/editions-client";
import type { Project } from "@/lib/types";
import { useStudio } from "./studio-provider";
import { CuratorSuggestions } from "./curator-suggestions";
import { useTradeAccess } from "@/lib/use-trade-access";
const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const eth = (v: string) => `${formatEther(BigInt(v))} ETH`;
const when = (v: string) => Number(v) ? new Date(Number(v) * 1000).toLocaleString() : "—";
function useNftWrite() {
  const config = useConfig(); const { switchChainAsync } = useSwitchChain(); const { writeContractAsync } = useWriteContract();
  const client = usePublicClient({ chainId: editionsChainId }); const queries = useQueryClient();
  return useCallback(async (functionName: string, args: readonly unknown[], value?: bigint) => {
    if (!editionsAddress || !client) throw new Error("Deploy and configure the NFT edition contract first.");
    const actor = getAccount(config).address; if (!actor) throw new Error("Connect your wallet.");
    if (getAccount(config).chainId !== editionsChainId) await switchChainAsync({ chainId: editionsChainId });
    if (!same(actor, getAccount(config).address)) throw new Error("Wallet changed. Try again.");
    const call = { address: editionsAddress, abi: editionsAbi, functionName, args, value, account: actor, chainId: editionsChainId };
    await client.simulateContract(call as never);
    const hash = await writeContractAsync(call as never);
    const receipt = await client.waitForTransactionReceipt({ hash, confirmations: editionsChainId === 31337 ? 1 : 3 });
    if (receipt.status !== "success") throw new Error("Transaction reverted.");
    await queries.invalidateQueries({ queryKey: ["editions"] }); return hash;
  }, [client, config, switchChainAsync, writeContractAsync, queries]);
}
function errorText(e: unknown) { return (e as { shortMessage?: string }).shortMessage || (e as Error).message || "Request failed."; }

export function EditionPublish({ project: p, dirty, refresh, onSave, saving = false }: { project: Project; dirty: boolean; refresh: () => Promise<void>; onSave?: () => void; saving?: boolean }) {
  const { data } = useStudio(); const write = useNftWrite();
  const [supply, setSupply] = useState(1); const [rights, setRights] = useState(false); const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [appeal, setAppeal] = useState("");
  const [reserve, setReserve] = useState("0.01"); const [hours, setHours] = useState(24);
  const requirementsId = useId();
  const requirements: string[] = [];
  if (!editionsAddress) requirements.push("NFT publishing is waiting for its contract deployment. Your saved comic is safe; checking the rights box does not complete this setup.");
  if (dirty) requirements.push("Save your latest comic changes before submitting for review.");
  if (!p.edition) {
    if (!rights) requirements.push("Confirm that you have permission from every rights holder.");
    if (!p.panels.length || p.panels.some(panel => !panel.image)) requirements.push("Add artwork to every panel, then save your comic.");
    if (!p.terms.trim()) requirements.push("Add and save a reading license in Team & shares.");
    if (!Number.isInteger(supply) || supply < 1 || supply > 25) requirements.push("Choose a whole-number edition supply from 1 to 25.");
    if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(reserve) || parseEther(reserve) <= BigInt(0)) requirements.push("Enter a positive auction reserve with up to 18 decimal places.");
    if (!Number.isFinite(hours) || hours < 1 || hours > 720) requirements.push("Choose an auction duration from 1 to 720 hours.");
  }
  async function run(label: string, work: () => Promise<unknown>) { setBusy(label); setError(""); try { await work(); } catch (e) { setError(errorText(e)); } finally { await refresh().catch(() => {}); setBusy(""); } }
  if (data.user?.id !== p.ownerId) return <section className="surface"><h2>NFT publishing</h2><p>The project owner submits and mints editions after obtaining permission from all rights holders. Primary proceeds and royalties go to that creator wallet; collaborator shares remain a separate agreement.</p></section>;
  return <section className="surface review-surface"><span className="eyebrow">FIXED SUPPLY · TRANSFERABLE READING LICENSE</span><h2>Publish NFT editions</h2>
    <p>Full pages stay encrypted. A resized preview of panel 1 becomes the public cover. The current edition owner receives reading access after confirmation. Copyright stays with the creators.</p>
    {!p.edition && <><label>Edition supply<input aria-label="Edition supply" type="number" min="1" max="25" value={supply} onChange={e => setSupply(Number(e.target.value))}/></label><label>First-auction reserve (ETH)<input value={reserve} onChange={e => setReserve(e.target.value)} inputMode="decimal"/></label><label>First-auction duration (hours)<input type="number" min="1" max="720" value={hours} onChange={e => setHours(Number(e.target.value))}/></label><p>1–25 editions per version. Supply, license, content and first-auction terms freeze at submission. Five submissions per wallet account per day.</p><label className="rights-confirmation"><input type="checkbox" checked={rights} onChange={e => setRights(e.target.checked)}/><span>I own this work or have permission from every rights holder to publish it under the saved license.</span></label></>}
    <p>Publishing has no platform deposit or forfeiture. The operator funds storage and inference during the pilot. Wallet transactions cost gas. Primary sales charge 2.5%; secondary ETH sales charge 2.5% plus a 5% creator royalty. Swaps have no platform fee.</p>
    {p.edition?.review && <div className="chain-proof"><strong>Review score {(p.edition.review.score / 100).toFixed(0)}/100</strong><p>{p.edition.review.reasons.join(" · ")}</p>{p.edition.review.assessment && <p>Completeness: {p.edition.review.assessment.completeness} · Legibility: {p.edition.review.assessment.legibility} · Page order: {p.edition.review.assessment.pageOrder}</p>}<p>{p.edition.review.model} · {p.edition.review.promptVersion} · {p.edition.review.verification === "gateway-reported" ? "Private computation · provider checks reported by 0G gateway" : p.edition.review.teeVerified ? "Provider signature checked" : p.edition.review.provider === "deterministic" ? "Deterministic check" : "No verified attestation returned"}</p><p className="edition-wallet">Request {p.edition.review.requestId || "not applicable"}</p><p>{p.edition.review.uncertainty}</p></div>}
    {p.edition?.error && <p role="status">{p.edition.error}</p>}
    {(!p.edition || p.edition.status === "uploaded") && <><div id={requirementsId} className="publication-requirements" role="status">{requirements.length > 0 && <><strong>Before you submit</strong><ul>{requirements.map(message => <li key={message}>{message}</li>)}</ul>{!editionsAddress && <Link className="text-button" href="/network">View publishing setup →</Link>}{dirty && onSave && <button className="text-button" disabled={saving || !!busy} onClick={onSave}>{saving ? "Saving…" : "Save latest changes"}</button>}</>}</div><button className="button purple" aria-describedby={requirementsId} disabled={!!busy || saving || requirements.length > 0} onClick={() => run("Reviewing comic images…", () => editionRequest({ action: "review", id: p.id, revision: p.revision, supply, rights, reserveWei: parseEther(reserve).toString(), auctionDuration: Math.round(hours * 3600) }))}>{busy || "Submit for curator review"}</button></>}
    {p.edition?.status === "approved" && <><p>Review is complete. Confirm minting this comic and its saved first-auction terms in your wallet.</p>
    <button className="button purple" disabled={!!busy || dirty || !editionsAddress} onClick={() => run("Preparing approved mint…", async () => {
      const prepared = await editionRequest<{ permit: { author: Hex; key: Hex; manifestHash: Hex; metadataHash: Hex; uriHash: Hex; licenseHash: Hex; auctionHash: Hex; supply: number; deadline: string }; uri: string; signature: Hex }>({ action: "prepare", id: p.id });
      setBusy("Confirm minting in your wallet…"); await write("createComic", [{ ...prepared.permit, deadline: BigInt(prepared.permit.deadline) }, prepared.uri, prepared.signature]);
      await editionRequest({ action: "confirm", id: p.id });
    })}>{busy || "Mint approved editions"}</button></>}
    {p.edition && p.edition.status !== "minted" && <button className="text-button" disabled={!!busy} onClick={() => run("Checking confirmed mint…", () => editionRequest({ action: "confirm", id: p.id }))}>Recover a confirmed mint</button>}
    {p.edition && p.edition.status !== "minted" && <button className="text-button" disabled={!!busy} onClick={() => run("Reopening draft…", () => editionRequest({ action: "reopen", id: p.id }))}>Reopen to correct the comic</button>}
    {p.edition?.status === "flagged" && !p.edition.appeal && <><label>Ask a human reviewer<textarea maxLength={4000} value={appeal} onChange={e => setAppeal(e.target.value)}/></label><button className="button" disabled={!!busy || !appeal.trim()} onClick={() => run("Sending appeal…", () => editionRequest({ action: "appeal", id: p.id, text: appeal }))}>Submit appeal</button></>}
    {p.edition?.appeal && <p>Appeal {p.edition.appeal.decision || "pending"}. Response target: {new Date(p.edition.appeal.deadline).toLocaleString()}. {p.edition.appeal.reason}</p>}
    {p.edition?.status === "minted" && <Link className="button purple" href="/marketplace">Manage editions and start auctions</Link>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}

type FormAction = { label: string; fields: { name: string; label: string; value?: string; type?: string; readOnly?: boolean }[]; submit: (data: FormData) => Promise<unknown> };
export function EditionsMarket({ trade = false, tokenId }: { trade?: boolean; tokenId?: string }) {
  const { data: studio } = useStudio(); const { address } = useAccount(); const write = useNftWrite(); const client = usePublicClient({ chainId: editionsChainId });
  const access = useTradeAccess();
  const [view, setView] = useState(trade ? "secondary" : "primary"); const [page, setPage] = useState(0); const [search, setSearch] = useState(""); const [genre, setGenre] = useState("");
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false); const [form, setForm] = useState<FormAction | null>(null); const [reader, setReader] = useState<string>();
  const query = useQuery({ queryKey: ["editions", view, page, address, genre, tokenId], queryFn: () => editionRequest<EditionSnapshot>(undefined, `?view=${tokenId ? "token" : view}&page=${page}&genre=${encodeURIComponent(genre)}${tokenId ? `&id=${encodeURIComponent(tokenId)}` : ""}${address ? `&wallet=${address}` : ""}`), enabled: !!editionsAddress && (!trade || access.unlocked), refetchInterval: 15000 });
  const data = query.data; const now = Number(data?.timestamp || 0); const signed = same(address, studio.user?.address);
  async function run(work: () => Promise<unknown>) { setBusy(true); setError(""); try { await work(); setForm(null); await query.refetch(); } catch (e) { setError(errorText(e)); } finally { setBusy(false); } }
  const field = (name: string, label: string, value?: string, type = "text") => ({ name, label, value, type });
  const duration = (d: FormData) => { const hours = Number(d.get("hours")); if (!Number.isFinite(hours) || hours < 1 || hours > 720) throw new Error("Duration must be 1–720 hours."); return BigInt(Math.round(hours * 3600)); };
  const price = (d: FormData) => { const raw = String(d.get("price")); if (!/^(0|[1-9]\d*)(\.\d{1,18})?$/.test(raw)) throw new Error("Enter a positive ETH amount, with at most 18 decimals."); const n = parseEther(raw); if (n <= BigInt(0)) throw new Error("Price must be positive."); return n; };
  const owned = (t: EditionToken) => same(t.owner, address);
  const held = (t: EditionToken) => owned(t) || same(t.depositor, address);
  const tokens = (data?.tokens || []).filter(t => tokenId || ((trade ? t.sale[0] !== "0" : t.sale[0] === "0") && (view !== "collection" || held(t)) && (!genre || t.genre === genre) && `${t.title} ${t.description} ${t.author}`.toLowerCase().includes(search.toLowerCase())));
  function tokenCard(t: EditionToken) {
    const a = t.auction; const active = a[6]; const auctionSeller = same(a[0], address); const liveAsk = t.ask[1] !== "0" && same(t.ask[0], t.owner) && Number(t.ask[2]) > now;
    return <article className="surface edition-card" key={t.id}>{t.cover && <img src={t.cover} alt={`${t.title} cover`} loading="lazy"/>}<h2><Link href={`/editions/${t.id}`}>{t.title}</Link></h2><p>Edition #{t.id} · {t.supply} total · {t.genre}</p><p className="edition-wallet">Creator {t.author}<br/>Owner {t.owner}</p><p>{t.delisted ? "Delisted from new sales. Existing owner access continues." : ""}</p>
      <dl><dt>First sale</dt><dd>{eth(t.sale[0])} · {when(t.sale[3])}</dd><dt>Latest ETH sale</dt><dd>{eth(t.sale[1])} · {when(t.sale[4])}</dd><dt>Last auction / swap reference</dt><dd>{eth(t.sale[2])}</dd><dt>Asking price</dt><dd>{liveAsk ? eth(t.ask[1]) : "No active asking price"}</dd></dl>
      {active && <p><strong>{now >= Number(a[4]) ? "Auction ended" : "Auction open"}</strong><br/>Reserve {eth(a[2])} · Highest bid {eth(a[3])}<br/>Ends {when(a[4])}</p>}
      <details><summary>License, provenance and AI findings</summary><p>{t.license}</p><p>Token ownership conveys reading access; copyright remains with the creators.</p><p className="edition-wallet">Manifest {t.manifestHash}<br/>Metadata {t.metadataHash}<br/>{t.uri}</p>{t.review && <><p>Advisory score {t.review.score / 100}/100 · {t.review.model}</p><p>{t.review.reasons.join(" · ")}</p>{t.review.assessment && <p>Completeness: {t.review.assessment.completeness} · Legibility: {t.review.assessment.legibility} · Page order: {t.review.assessment.pageOrder}</p>}<p>{t.review.promptVersion} · {t.review.at} · {t.review.verification === "gateway-reported" ? "Private computation · provider checks reported by 0G gateway" : t.review.teeVerified ? "Provider signature checked" : t.review.provider === "deterministic" ? "Deterministic check" : "No verified attestation returned"}</p><p>{t.review.uncertainty}</p></>}{t.reviewOverride && <p>Human review: {t.reviewOverride.reason}</p>}</details>
      <div className="edition-actions">
      {signed && held(t) && t.sale[0] !== "0" && <button className="button purple" disabled={busy} onClick={() => setReader(t.id)}>Read edition</button>}
      {signed && active && now < Number(a[4]) && !auctionSeller && !t.delisted && (t.sale[0] === "0" || access.unlocked) && <button className="button purple" disabled={busy} onClick={() => setForm({ label: `Bid on edition #${t.id}`, fields: [field("price", "Bid amount (ETH)", formatEther(BigInt(t.minimum)))], submit: d => write("bid", [BigInt(t.id)], price(d)) })}>Place bid · min {eth(t.minimum)}</button>}
      {active && now >= Number(a[4]) && signed && <button className="button" disabled={busy} onClick={() => run(() => write("settleAuction", [BigInt(t.id)]))}>Settle auction</button>}
      {signed && auctionSeller && active && a[3] === "0" && <button className="button" disabled={busy} onClick={() => run(() => write("cancelAuction", [BigInt(t.id)]))}>Cancel auction</button>}
      {signed && access.unlocked && liveAsk && !owned(t) && !t.delisted && <button className="button yellow" disabled={busy} onClick={() => setForm({ label: `Buy edition #${t.id}`, fields: [], submit: () => write("buy", [BigInt(t.id), BigInt(t.ask[1])], BigInt(t.ask[1])) })}>Buy · total {eth(t.ask[1])} + gas</button>}
      {signed && owned(t) && !t.delisted && <button className="button" disabled={busy} onClick={() => setForm({ label: "Start edition auction", fields: [{ ...field("price", "Reserve price (ETH)", t.sale[0] === "0" && t.firstAuction ? formatEther(BigInt(t.firstAuction.reserveWei)) : "0.01"), readOnly: t.sale[0] === "0" && !!t.firstAuction }, { ...field("hours", "Duration (hours)", t.sale[0] === "0" && t.firstAuction ? String(t.firstAuction.duration / 3600) : "24", "number"), readOnly: t.sale[0] === "0" && !!t.firstAuction }], submit: d => write("openAuction", [BigInt(t.id), price(d), duration(d)]) })}>Start auction</button>}
      {signed && owned(t) && t.sale[0] !== "0" && !t.delisted && <><button className="button" disabled={busy} onClick={() => setForm({ label: "List fixed-price resale", fields: [field("price", "Asking price (ETH)", formatEther(BigInt(t.sale[1]))), field("hours", "Duration (hours)", "24", "number")], submit: d => write("setAsk", [BigInt(t.id), price(d), duration(d)]) })}>Set asking price</button><button className="button" disabled={busy} onClick={() => setForm({ label: "Offer edition for swaps", fields: [field("hours", "Duration (hours)", "24", "number")], submit: d => write("openDeal", [BigInt(t.id), duration(d)]) })}>List for swap</button><button className="button" disabled={busy} onClick={() => setForm({ label: "Transfer edition and reading access", fields: [field("to", "Recipient wallet")], submit: d => { const to = String(d.get("to")); if (!isAddress(to)) throw new Error("Enter an Ethereum address."); return write("safeTransferFrom", [address, to, BigInt(t.id)]); } })}>Transfer</button></>}
      {signed && owned(t) && liveAsk && <button className="button" disabled={busy} onClick={() => run(() => write("cancelAsk", [BigInt(t.id)]))}>Cancel asking price</button>}
      {signed && same(t.author, address) && <button className="text-button" disabled={busy} onClick={() => run(() => write("setDelisted", [BigInt(t.comicId), !t.delisted]))}>{t.delisted ? "Relist comic" : "Delist comic"}</button>}
      {signed && <button className="text-button" onClick={() => setForm({ label: "Report infringement or abuse", fields: [field("text", "Describe the issue")], submit: d => editionRequest({ action: "report", comicId: t.comicId, text: String(d.get("text")) }) })}>Report comic</button>}
      </div></article>;
  }
  if (trade && !access.unlocked) return <><div className="page-heading"><div><div className="eyebrow">BUILD YOUR COLLECTION</div><h1>Trade is locked.</h1></div></div><section className="surface"><h2>Your collection starts in Marketplace.</h2><p>{access.checking ? "Checking your confirmed comic ownership…" : "Collect your first comic to unlock trading."}</p>{access.error && <p role="alert">Ownership could not be checked. Try again shortly.</p>}<p>Trade requires at least one comic that has completed its first sale. Comics held for you in auction or swap escrow still count.</p><Link className="button purple" href="/marketplace">Explore Marketplace →</Link><p>Refunds and withdrawals remain available in <Link href="/earnings">Earnings</Link>.</p></section></>;
  return <><div className="page-heading"><div><div className="eyebrow">COMIC EDITIONS · OWNERSHIP ON CHAIN</div><h1>{tokenId ? `Edition #${tokenId}` : trade ? "Trade comics." : "The marketplace."}</h1><p>{trade ? "Resell collected editions or swap comics with their owners." : "Bid for your first comic. Every edition starts here."}</p></div></div>
    {!trade && !tokenId && <CuratorSuggestions/>}
    {!editionsAddress ? <div className="info-banner">NFT editions have not launched yet. Auctions and trading will appear when the marketplace opens.</div> : <>
    {tokenId && <p><Link href="/marketplace">Back to Marketplace</Link> · <Link href="/trade">Open Trade</Link></p>}
    <p>ETH sales: 2.5% marketplace fee; resales also pay 5% creator royalty. External marketplaces may not enforce royalties. Swaps use the last auction price and preserve sale history. Text search applies within each page. Genre discovery uses Arkiv when configured.</p>
    {!tokenId && <div className="filter-tabs" role="tablist" aria-label="Edition marketplace">{(trade ? [["secondary", "Resales"], ["collection", "My editions"], ["deals", "Swap deals"], ["offers", "Swap offers"]] : [["primary", "First-sale auctions"], ["collection", "My new editions"]]).map(([key, title]) => <button key={key} role="tab" aria-selected={view === key} className={view === key ? "selected" : ""} onClick={() => { setView(key); setPage(0); }}>{title}</button>)}</div>}
    {!signed && <p>Connect your wallet and sign in to bid, trade, or read.</p>}
    <div className="edition-tools"><label>Search title or creator<input value={search} onChange={e => setSearch(e.target.value)}/></label><label>Genre<select value={genre} onChange={e => { setGenre(e.target.value); setPage(0); }}><option value="">All genres</option>{[...new Set((data?.tokens || []).map(t => t.genre).filter(Boolean))].map(g => <option key={g}>{g}</option>)}</select></label></div>
    {data && signed && <div className="info-banner">Withdrawable bids, sales and swap credits: {eth(data.credit)} <button className="button small" disabled={busy || data.credit === "0"} onClick={() => run(() => write("withdraw", [address]))}>Withdraw to wallet</button></div>}
    {query.isPending && <p role="status">Reading confirmed contract state…</p>}{query.error && <p role="alert">{errorText(query.error)}</p>}
    <div className="edition-grid">{tokens.map(tokenCard)}
    {data?.deals.filter(d => d.active).map(d => <article className="surface edition-card" key={d.id}><h2>Swap deal #{d.id}</h2><p>{d.token.title} · edition #{d.token.id}</p><p>Last auction value: {eth(d.value)} · expires {when(d.end)}</p>{signed && !same(d.maker, address) && now < Number(d.end) && <button className="button purple" disabled={busy} onClick={() => setForm({ label: `Offer a comic for deal #${d.id}`, fields: [field("token", "Your edition token ID", "", "number")], submit: async f => { const token = BigInt(String(f.get("token"))); const sale = await client!.readContract({ address: editionsAddress!, abi: editionsAbi, functionName: "sales", args: [token] }); const topUp = BigInt(d.value) - sale[2]; if (sale[2] === BigInt(0) || topUp < BigInt(0)) throw new Error("Offer a comic with a completed auction and an equal or lower auction value."); if (!window.confirm(`Offer edition #${token} plus ${formatEther(topUp)} ETH? Gas is additional.`)) return; return write("offer", [BigInt(d.id), token], topUp); } })}>Make offer</button>}{signed && (same(d.maker, address) || now >= Number(d.end)) && <button className="button" disabled={busy} onClick={() => run(() => write("closeDeal", [BigInt(d.id)]))}>Close deal / reclaim comic</button>}</article>)}
    {data?.offers.filter(o => o.active && (same(o.maker, address) || same(o.dealMaker, address) || now >= Number(o.end) || !o.dealActive)).map(o => <article className="surface edition-card" key={o.id}><h2>Swap offer #{o.id}</h2><p>{o.token.title} #{o.token.id} + {eth(o.topUp)} for {o.target.title} #{o.target.id}</p>{signed && same(o.dealMaker, address) && o.dealActive && now < Number(o.end) && <button className="button purple" disabled={busy} onClick={() => run(() => write("accept", [BigInt(o.id)]))}>Accept swap</button>}{signed && (same(o.maker, address) || !o.dealActive || now >= Number(o.end)) && <button className="button" disabled={busy} onClick={() => run(() => write("closeOffer", [BigInt(o.id)]))}>Cancel / reclaim offer</button>}</article>)}
    </div>{data && !tokenId && <div className="edition-tools"><button className="button" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Newer</button><span>Page {page + 1} · block {data.block} · {data.confirmations} confirmation delay</span><button className="button" disabled={(page + 1) * 12 >= Number(data.total)} onClick={() => setPage(p => p + 1)}>Older</button></div>}
    {data && tokens.length === 0 && view !== "deals" && view !== "offers" && <p>No matching editions on this page.</p>}
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}{busy && <p role="status">Confirm in your wallet, then wait for chain confirmation…</p>}
    {form && <div className="edition-dialog" role="dialog" aria-modal="true" aria-label={form.label}><form className="surface" onSubmit={e => { e.preventDefault(); const f = new FormData(e.currentTarget); void run(() => form.submit(f)); }}><h2>{form.label}</h2>{form.fields.map(f => <label key={f.name}>{f.label}<input name={f.name} type={f.type} defaultValue={f.value} readOnly={f.readOnly} required maxLength={4000}/></label>)}<p>Review the assets and total in your wallet. Transactions cost gas.</p>{error && <p role="alert">{error}</p>}<button className="button purple" disabled={busy}>Confirm</button><button className="button" type="button" disabled={busy} onClick={() => setForm(null)}>Cancel</button></form></div>}
    {reader && signed && <EditionReader key={`${reader}-${address}-${studio.user?.id}`} token={reader} close={() => setReader(undefined)}/>}
  </>;
}

function EditionReader({ token, close }: { token: string; close: () => void }) {
  const [pages, setPages] = useState<{ image: string; dialogue: string; alt: string }[]>([]); const [error, setError] = useState("");
  useEffect(() => {
    let live = true; let expiry: ReturnType<typeof setTimeout>;
    async function read() { try { const res = await fetch(`/api/editions/read/${token}`, { cache: "no-store" }); const body = await res.json(); if (!res.ok) throw new Error(body.error); if (live) { setPages(body.pages); setError(""); clearTimeout(expiry); expiry = setTimeout(() => { setPages([]); setError("Access check expired. Close and reopen the reader."); }, 20000); } } catch (e) { if (live) { setPages([]); setError(errorText(e)); } } }
    void read(); const timer = setInterval(read, 15000); return () => { live = false; clearInterval(timer); clearTimeout(expiry); };
  }, [token]);
  return <div className="edition-reader" role="dialog" aria-modal="true" aria-label="Edition reader"><div className="surface"><button className="button" onClick={close}>Close reader</button><p>Access follows confirmed ownership. Checked every 15 seconds; displayed pages expire after 20 seconds without a successful check. Previously downloaded content cannot be recalled.</p>{error && <p role="alert">{error}</p>}{pages.map((p, i) => <figure key={i}><img src={p.image} alt={p.alt || `Page ${i + 1}`}/><figcaption>{p.dialogue}</figcaption></figure>)}</div></div>;
}

export function EditionEarnings() {
  const { data } = useStudio(); const { address } = useAccount(); const write = useNftWrite(); const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ["editions", "credits", address], queryFn: () => editionRequest<EditionSnapshot>(undefined, `?view=collection&wallet=${address}`), enabled: !!address && !!editionsAddress, refetchInterval: 15000 });
  return <><div className="page-heading"><h1>Earnings.</h1></div><section className="surface"><h2>NFT marketplace credits</h2><p>Withdrawable outbid refunds, sale proceeds, royalties and swap top-ups: {eth(q.data?.credit || "0")}</p><button className="button purple" disabled={busy || !same(address, data.user?.address) || !q.data || q.data.credit === "0"} onClick={async () => { setBusy(true); setError(""); try { await write("withdraw", [address]); } catch(e) { setError(errorText(e)); } finally { setBusy(false); } }}>Withdraw to wallet</button>{q.error && <p>{errorText(q.error)}</p>}{error && <p role="alert">{error}</p>}<Link className="button" href="/trade">Manage editions and offers</Link><Link className="button" href="/marketplace">Open Marketplace</Link></section></>;
}
