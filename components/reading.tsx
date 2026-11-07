"use client";
/* eslint-disable @next/next/no-img-element */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useConfig, usePublicClient, useSignTypedData, useSwitchChain, useWriteContract } from "wagmi";
import { getAccount } from "wagmi/actions";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { formatEther, type Hex } from "viem";
import { readingAbi, readingAddress, readingChainId, readingRequest, type ReadingSnapshot } from "@/lib/reading-client";
import { approvalMessage, readingDomain } from "@/lib/reading-snapshot";
import { teamApprovalTypes } from "@/lib/reading-permit";
import type { Project } from "@/lib/types";
import { editionRequest } from "@/lib/editions-client";
import { useStudio } from "./studio-provider";

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const eth = (value: string) => `${formatEther(BigInt(value))} ETH`;
const errorText = (error: unknown) => (error as { shortMessage?: string }).shortMessage || (error as Error).message || "Please retry.";
function useReadingWrite() {
  const config = useConfig(); const { data } = useStudio(); const { switchChainAsync } = useSwitchChain(); const { writeContractAsync } = useWriteContract();
  const client = usePublicClient({ chainId: readingChainId }); const queries = useQueryClient();
  return useCallback(async (functionName: string, args: readonly unknown[], value?: bigint) => {
    if (!readingAddress || !client) throw new Error("The reading contract is not configured.");
    const actor = getAccount(config).address; if (!same(actor, data.user?.address)) throw new Error("Sign in with the connected wallet.");
    if (getAccount(config).chainId !== readingChainId) await switchChainAsync({ chainId: readingChainId });
    if (!same(actor, getAccount(config).address)) throw new Error("Wallet changed. Try again.");
    const call = { address: readingAddress, abi: readingAbi, functionName, args, value, account: actor, chainId: readingChainId };
    await client.simulateContract(call as never);
    const hash = await writeContractAsync(call as never); const receipt = await client.waitForTransactionReceipt({ hash, confirmations: readingChainId === 31337 ? 1 : 3 });
    if (receipt.status !== "success") throw new Error("The transaction reverted.");
    await queries.invalidateQueries({ queryKey: ["reading"] }); return hash;
  }, [client, config, data.user?.address, queries, switchChainAsync, writeContractAsync]);
}

export function ReadingPublish({ project: p, dirty, refresh, onSave, saving = false }: { project: Project; dirty: boolean; refresh: () => Promise<void>; onSave?: () => void; saving?: boolean }) {
  const { data } = useStudio(); const config = useConfig(); const write = useReadingWrite(); const { signTypedDataAsync } = useSignTypedData(); const { switchChainAsync } = useSwitchChain();
  const [rights, setRights] = useState(false); const [busy, setBusy] = useState(""); const [error, setError] = useState("");
  const [now, setNow] = useState(0);
  useEffect(() => { const tick = () => setNow(Math.floor(Date.now() / 1000)); tick(); const timer = setInterval(tick, 30000); return () => clearInterval(timer); }, []);
  const r = p.reading; const owner = data.user?.id === p.ownerId;
  const myApproval = r?.approvals.some(a => a.userId === data.user?.id);
  const allApproved = !!r && p.members.every(m => r.approvals.some(a => a.userId === m.userId));
  const expired = !!r && r.approvalDeadline <= now;
  async function run(label: string, work: () => Promise<unknown>) { setBusy(label); setError(""); try { await work(); } catch (e) { setError(errorText(e)); } finally { await refresh().catch(() => {}); setBusy(""); } }
  if (p.edition || p.publication) return <section className="surface review-surface"><h2>Move to collaborative publishing</h2><p>This submission uses an earlier publishing contract. Its records and reading access are preserved.</p>{p.edition && p.edition.status !== "minted" ? <><p>Reopen this unminted submission, set a fixed reading price, and collect approval from every collaborator.</p><button className="button" disabled={!owner || !!busy} onClick={() => run("Reopening…", () => editionRequest({ action: "reopen", id: p.id }))}>Reopen for fixed-price reading</button></> : <p>Start a new project for a new fixed-price publication.</p>}{error && <p role="alert">{error}</p>}</section>;
  const requirements = [!readingAddress && "Publishing setup is not complete. Check Network & services.", dirty && "Save your latest changes before starting team review.", (!p.panels.length || p.panels.some(panel => !panel.image)) && "Add artwork to every panel and save it.", (!p.priceWei || BigInt(p.priceWei) <= BigInt(0)) && "Set and save a positive fixed reading price in Team & shares.", !p.terms.trim() && "Add a reading license in Team & shares."].filter(Boolean);
  return <section className="surface review-surface"><span className="eyebrow">EVERY COLLABORATOR HAS A SAY</span><h2>Review & publish</h2>
    <p>Every collaborator, including the owner, must review and approve the exact saved pages, fixed price, license and revenue split. Editing the comic requires a fresh round of approvals.</p>
    <div className="chain-proof"><strong>Reading price: {eth(r?.priceWei || p.priceWei || "0")}</strong><p>Multiple readers can buy access to the same comic. Each purchase grants that wallet ongoing reading access. Copyright stays with the creators.</p><p>Each sale charges a 2.5% platform fee. The remainder is credited to collaborators using the approved shares. Wallet transactions cost gas.</p></div>
    {!r && <>{requirements.length > 0 && <div className="publication-requirements" role="status"><strong>Before team review</strong><ul>{requirements.map(message => <li key={String(message)}>{message}</li>)}</ul>{!readingAddress && <Link className="text-button" href="/network">View publishing setup →</Link>}{dirty && onSave && <button className="text-button" disabled={saving || !!busy} onClick={onSave}>Save latest changes</button>}</div>}{owner ? <button className="button purple" disabled={!!busy || saving || requirements.length > 0} onClick={() => run("Starting team review…", () => readingRequest({ action: "start", id: p.id, revision: p.revision }))}>{busy || "Start team review"}</button> : <p>The owner starts team review after saving the final comic and its price.</p>}</>}
    {r && <><h3>Collaborator approvals · {r.approvals.length}/{p.members.length}</h3><ul className="approval-list">{p.members.map(m => <li key={m.userId}><span>{m.name}{m.userId === data.user?.id ? " (you)" : ""} · {m.role} · {m.share / 100}%</span><strong>{r.approvals.some(a => a.userId === m.userId) ? "Approved" : "Waiting for approval"}</strong></li>)}</ul>
      {expired && r.status !== "published" && <p role="status">This review expired. The owner must reopen the draft and request fresh approvals.</p>}
      {r.status === "team-review" && !myApproval && <><label className="rights-confirmation"><input type="checkbox" checked={rights} onChange={e => setRights(e.target.checked)}/><span>I reviewed every page and have permission to publish it. I approve this saved comic, its {eth(r.priceWei)} reading price, license and the contributor shares above.</span></label><button className="button purple" disabled={!rights || !!busy || expired || !readingAddress} onClick={() => run("Confirm approval in your wallet…", async () => {
        if (!same(getAccount(config).address, data.user?.address)) throw new Error("Connect the wallet you signed in with.");
        await readingRequest({ action: "approval", id: p.id });
        if (getAccount(config).chainId !== readingChainId) await switchChainAsync({ chainId: readingChainId });
        if (!same(getAccount(config).address, data.user?.address)) throw new Error("Wallet changed. Retry approval.");
        const signature = await signTypedDataAsync({ domain: readingDomain(r), types: teamApprovalTypes, primaryType: "TeamApproval", message: approvalMessage(r) });
        if (!same(getAccount(config).address, data.user?.address)) throw new Error("Wallet changed. Approval was not saved.");
        await readingRequest({ action: "approve", id: p.id, rights: true, signature });
      })}>{busy || "Approve publication"}</button></>}
      {myApproval && r.status !== "published" && <button className="text-button" disabled={!!busy || !readingAddress} onClick={() => run("Confirm approval withdrawal in your wallet…", async () => { await write("revokeApproval", [r.key]); await readingRequest({ action: "withdraw", id: p.id }); })}>Withdraw my approval</button>}
      {!allApproved && r.status !== "published" && <p className="field-hint" role="status">Waiting for every collaborator to approve. Curator submission and publication stay locked until everyone agrees.</p>}
      {r.review && <div className="chain-proof"><strong>Curator review · {r.review.score / 100}/100</strong><p>{r.review.reasons.join(" · ")}</p><p>{r.review.uncertainty}</p></div>}
      {owner && ["team-review", "uploaded"].includes(r.status) && <button className="button purple" disabled={!allApproved || !!busy || expired} onClick={() => run("Reviewing comic images…", () => readingRequest({ action: "review", id: p.id }))}>{busy || "Submit approved comic for curator review"}</button>}
      {r.status === "flagged" && <p role="status">The curator flagged this comic. The owner can reopen it for corrections; every collaborator must approve the corrected version.</p>}
      {owner && r.status === "approved" && <button className="button purple" disabled={!allApproved || !!busy || expired} onClick={() => run("Preparing publication…", async () => {
        const prepared = await readingRequest<{ permit: Record<string, string>; uri: string; team: { people: Hex[]; allocations: number[]; approvals: Hex[] }; signature: Hex }>({ action: "prepare", id: p.id });
        setBusy("Confirm publication in your wallet…");
        await write("publishComic", [{ ...prepared.permit, price: BigInt(prepared.permit.price), approvalDeadline: BigInt(prepared.permit.approvalDeadline), deadline: BigInt(prepared.permit.deadline) }, prepared.uri, prepared.team, prepared.signature]);
        await readingRequest({ action: "confirm", id: p.id });
      })}>{busy || `Publish at ${eth(r.priceWei)}`}</button>}
      {owner && r.status !== "published" && <><button className="text-button" disabled={!!busy} onClick={() => run("Recovering publication…", () => readingRequest({ action: "confirm", id: p.id }))}>Recover a confirmed publication</button><button className="text-button" disabled={!!busy} onClick={() => run("Reopening draft…", () => readingRequest({ action: "reopen", id: p.id }))}>Reopen and reset all approvals</button></>}
      {r.status === "published" && <Link className="button purple" href={`/readings/${r.comicId}`}>Open published comic</Link>}
      {r.error && <p className="form-error" role="status">{r.error}</p>}
    </>}{error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}

export function ReadingMarket({ comicId, library = false }: { comicId?: string; library?: boolean }) {
  const { data: studio } = useStudio(); const { address } = useAccount(); const { openConnectModal } = useConnectModal(); const write = useReadingWrite();
  const [page, setPage] = useState(0); const [search, setSearch] = useState(""); const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [reader, setReader] = useState<string>();
  const signed = same(address, studio.user?.address);
  const q = useQuery({ queryKey: ["reading", page, address, comicId, library], queryFn: () => readingRequest<ReadingSnapshot>(undefined, `?page=${page}${address ? `&wallet=${address}` : ""}${comicId ? `&id=${comicId}` : ""}${library ? "&library=1" : ""}`), enabled: !!readingAddress && (!library || signed), refetchInterval: 15000 });
  const comics = (q.data?.comics || []).filter(c => (!library || c.canRead) && `${c.title} ${c.description} ${c.genre}`.toLowerCase().includes(search.toLowerCase()));
  return <><div className="page-heading"><div><div className="eyebrow">STORIES TO READ. PEOPLE TO CREDIT.</div><h1>{library ? "Your reading library." : "The comic library."}</h1><p>Buy reading access at a fixed price. Every reader gets their own access; another purchase never takes yours away.</p></div></div>
    {library && <Link className="text-button" href="/legacy-editions">Earlier editions & existing escrow →</Link>}
    {!readingAddress ? <section className="surface"><h2>Reading marketplace setup</h2><p>The fixed-price reading contract is being connected.</p><Link className="button" href="/network">View service setup</Link></section> : <>
    <label className="search-field">Search comics<input value={search} onChange={e => setSearch(e.target.value)} placeholder="Find a story…"/></label>
    {library && !signed && <button className="button purple" onClick={openConnectModal}>Sign in to open your library</button>}{(q.error || error) && <p className="form-error" role="alert">{error || errorText(q.error)}</p>}{q.isFetching && !q.data && <p role="status">Opening the library…</p>}
    <div className="edition-grid">{comics.map(c => <article className="surface edition-card" key={c.id}>{c.cover && <img src={c.cover} alt={`${c.title} cover`} loading="lazy"/>}<h2><Link href={`/readings/${c.id}`}>{c.title}</Link></h2><p>{c.description}</p><p>{c.genre} · {c.readers} {c.readers === "1" ? "reader" : "readers"}</p><strong>{eth(c.priceWei)} · reading access</strong><details><summary>License & contributor shares</summary><p>{c.license}</p>{c.contributors.map(m => <p className="edition-wallet" key={m.address}>{m.address} · {m.share / 100}%</p>)}<p>2.5% platform fee. Copyright remains with the creators. Reading access belongs to the purchasing wallet.</p></details>
      {signed && c.canRead ? <button className="button purple" onClick={() => setReader(c.id)}>Read comic</button> : c.delisted ? <p>Unavailable for new purchases. Existing readers retain access.</p> : <button className="button purple" disabled={!!busy} onClick={() => {
        if (!signed) { openConnectModal?.(); return; }
        setBusy(c.id); setError(""); void write("buyReading", [BigInt(c.id)], BigInt(c.priceWei)).then(() => q.refetch()).catch(e => setError(errorText(e))).finally(() => setBusy(""));
      }}>{busy === c.id ? "Confirm purchase in your wallet…" : signed ? `Buy reading access · ${eth(c.priceWei)}` : "Sign in to buy reading access"}</button>}
    </article>)}</div>{!q.isPending && !q.error && !comics.length && <p>{library ? "No reading purchases on this page yet. Browse Marketplace to find a story." : "No published comics on this page yet."}</p>}
    {!comicId && <div className="edition-actions"><button className="button" disabled={page === 0} onClick={() => setPage(n => n - 1)}>Previous</button><span>Page {page + 1}</span><button className="button" disabled={!q.data || (page + 1) * 12 >= Number(q.data.total)} onClick={() => setPage(n => n + 1)}>Next</button></div>}
    {reader && signed && <ReadingReader key={`${reader}-${studio.user?.id}-${address}`} comicId={reader} close={() => setReader(undefined)}/>}
    </>}
  </>;
}
function ReadingReader({ comicId, close }: { comicId: string; close: () => void }) {
  const [pages, setPages] = useState<{ image: string; dialogue: string; alt: string }[]>([]); const [error, setError] = useState("");
  useEffect(() => {
    let active = true; const controller = new AbortController();
    void fetch(`/api/reading/read/${comicId}`, { cache: "no-store", signal: controller.signal }).then(async response => { const body = await response.json(); if (!response.ok) throw new Error(body.error); if (active) setPages(body.pages); }).catch(e => { if (active) setError(errorText(e)); });
    return () => { active = false; controller.abort(); setPages([]); };
  }, [comicId]);
  return <div className="edition-reader" role="dialog" aria-modal="true" aria-label="Comic reader"><div className="surface"><button className="button" onClick={close}>Close reader</button><p>Reading access is checked against your signed-in wallet. Your purchase remains available when other readers buy this comic.</p>{error && <p role="alert">{error}</p>}{!pages.length && !error && <p role="status">Opening your comic…</p>}{pages.map((p, i) => <figure key={i}><img src={`data:${"image/jpeg"};base64,${p.image}`} alt={p.alt || `Page ${i + 1}`}/><figcaption>{p.dialogue}</figcaption></figure>)}</div></div>;
}
export function ReadingEarnings() {
  const { data } = useStudio(); const { address } = useAccount(); const write = useReadingWrite(); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const q = useQuery({ queryKey: ["reading", "credits", address], queryFn: () => readingRequest<ReadingSnapshot>(undefined, `?wallet=${address}&credits=1`), enabled: !!address && !!readingAddress, refetchInterval: 15000 });
  return <><div className="page-heading"><h1>Earnings.</h1></div><section className="surface"><h2>Your reading-sale earnings</h2><p>Each purchase credits every collaborator’s approved share after the 2.5% platform fee.</p><strong>{eth(q.data?.credit || "0")} available</strong><button className="button purple" disabled={busy || !same(address, data.user?.address) || !q.data || q.data.credit === "0"} onClick={() => { setBusy(true); setError(""); void write("withdraw", [address]).catch(e => setError(errorText(e))).finally(() => setBusy(false)); }}>{busy ? "Confirm withdrawal…" : "Withdraw to wallet"}</button>{(error || q.error) && <p role="alert">{error || errorText(q.error)}</p>}<Link className="button" href="/marketplace">Browse comics</Link><Link className="text-button" href="/legacy-editions">Earlier contract credit & escrow →</Link></section></>;
}
