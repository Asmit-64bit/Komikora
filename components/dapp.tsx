"use client";
/* eslint-disable @next/next/no-img-element */
// On-chain marketplace screens. Every money-moving action is a transaction sent by
// the connected wallet to ConsentCraftMarket; the server never holds user funds.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAccount, useChainId, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { formatEther, type Address, type Hash, type Hex } from "viem";
import { IDKitRequestWidget, proofOfHuman, type IDKitResult, type RpContext } from "@worldcoin/idkit";
import type { Project, User } from "@/lib/types";
import {
  consentCraftMarketAbi, explorerAddress, explorerTx, getMarketplaceAddress, ListingState, ListingStateLabels, MARKET_CHAIN_ID,
  PublicationState, PublicationStateLabels, SettlementReasonLabels, truncateAddress,
} from "@/lib/contracts";
import { randomBytes32 } from "@/lib/eip712";
import { Icon } from "./icons";

const MARKET = getMarketplaceAddress();
const eth = (wei?: bigint | string) => `${formatEther(BigInt(wei ?? 0))} ETH`;
const when = (seconds?: bigint | number) => (seconds && Number(seconds) > 0 ? new Date(Number(seconds) * 1000).toLocaleString() : "—");
const nowSeconds = () => Math.floor(Date.now() / 1000);

export async function api<T = Record<string, unknown>>(path: string, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const result = await response.json().catch(() => ({ error: "The server could not be reached." }));
  if (!response.ok) throw new Error(result.error || "The request failed.");
  return result as T;
}

function TxLink({ hash }: { hash?: string }) {
  if (!hash) return null;
  const url = explorerTx(hash);
  return <span className="chain-hash">{url ? <a href={url} target="_blank" rel="noreferrer">{hash}</a> : hash}</span>;
}

function NotDeployed() {
  return <div className="info-banner"><Icon name="shield" size={20}/><span>The marketplace contract is not configured. Set NEXT_PUBLIC_CHAIN_ID and NEXT_PUBLIC_MARKETPLACE_ADDRESS, then restart the app.</span></div>;
}

/** Sends a contract call from the connected wallet on the market's chain and waits for success. */
function useMarketWrite() {
  const chainId = useChainId();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const client = usePublicClient({ chainId: MARKET_CHAIN_ID });
  return useCallback(async (call: { functionName: string; args: readonly unknown[]; value?: bigint }) => {
    if (!MARKET || !client) throw new Error("The marketplace contract is not configured.");
    if (chainId !== MARKET_CHAIN_ID) await switchChainAsync({ chainId: MARKET_CHAIN_ID });
    const hash = await writeContractAsync({ address: MARKET, abi: consentCraftMarketAbi, chainId: MARKET_CHAIN_ID, ...call } as never) as Hash;
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") throw new Error(`Transaction ${hash} reverted.`);
    return hash;
  }, [chainId, switchChainAsync, writeContractAsync, client]);
}

function friendly(error: unknown) {
  const message = (error as { shortMessage?: string; message?: string })?.shortMessage || (error as Error)?.message || String(error);
  if (/User rejected|denied/i.test(message)) return "You cancelled the request in your wallet.";
  return message.split("\n")[0].slice(0, 300);
}

/* ─────────────────────────────── World ID ─────────────────────────────── */

type WorldStart = { app_id: `app_${string}`; action: string; signal: string; environment: "production" | "staging"; rp_context: RpContext };

export function WorldIdVerify({ user, onVerified }: { user: User; onVerified: () => void | Promise<void> }) {
  const [config, setConfig] = useState<WorldStart | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  if (user.worldIdVerifiedAt) {
    return <div className="chain-success"><Icon name="check" size={16}/> Verified human with World ID since {new Date(user.worldIdVerifiedAt).toLocaleDateString()}.</div>;
  }
  const start = async () => {
    setError(""); setBusy(true);
    try { setConfig(await api<WorldStart>("/api/personhood", { step: "start" })); setOpen(true); }
    catch (e) { setError(friendly(e)); }
    finally { setBusy(false); }
  };
  return <div className="chain-connect">
    <p><strong>Verify you are a unique human.</strong> World ID proves personhood without revealing who you are. Each person can verify one ConsentCraft account; publishing and buying require it.</p>
    <button className="button yellow" disabled={busy} onClick={start}><Icon name="shield" size={17}/>{busy ? "Preparing…" : "Verify with World ID"}</button>
    {config && <IDKitRequestWidget
      open={open} onOpenChange={setOpen}
      app_id={config.app_id} action={config.action} rp_context={config.rp_context} environment={config.environment}
      allow_legacy_proofs={false} preset={proofOfHuman({ signal: config.signal })}
      handleVerify={async (result: IDKitResult) => { await api("/api/personhood", { step: "complete", result: result as unknown as Record<string, unknown> }); }}
      onSuccess={() => { setConfig(null); void onVerified(); }}
      onError={code => setError(`World ID did not complete (${String(code)}).`)}
    />}
    {error && <p className="form-error" role="alert">{error}</p>}
  </div>;
}

/* ────────────────────────────── Publishing ────────────────────────────── */

type Prepared = {
  publication: NonNullable<Project["publication"]>;
  certificate: Record<string, string | number>; certificateSignature: Hex;
};

function quoteArgs(prepared: Prepared) {
  const q = prepared.publication.quote!;
  const big = (k: string) => BigInt(q[k] as string);
  const quote = {
    author: q.author as Address, manifestHash: q.manifestHash as Hex, previewManifestHash: q.previewManifestHash as Hex,
    arweaveBundleTxId: q.arweaveBundleTxId as Hex, arweavePreviewTxId: q.arweavePreviewTxId as Hex,
    pageCount: Number(q.pageCount), policyId: big("policyId"), price: big("price"), deposit: big("deposit"), aiCap: big("aiCap"),
    ratingSnapshot: Number(q.ratingSnapshot), expiresAt: big("expiresAt"), nonce: big("nonce"),
  };
  const c = prepared.certificate;
  const certificate = { wallet: c.wallet as Address, action: Number(c.action), expiresAt: BigInt(c.expiresAt as string), nonce: BigInt(c.nonce as string) };
  return [quote, prepared.publication.quoteSignature!, certificate, prepared.certificateSignature] as const;
}

export function PublishPanel({ project, user, dirty, refresh, notify }: { project: Project; user: User; dirty: boolean; refresh: () => Promise<void>; notify: (m: string) => void }) {
  const { address, isConnected } = useAccount();
  const write = useMarketWrite();
  const [language, setLanguage] = useState(project.publication?.language ?? "en");
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const [evidence, setEvidence] = useState("");
  const owner = project.ownerId === user.id;
  const pub = project.publication;
  const id = pub?.publicationId ? BigInt(pub.publicationId) : undefined;
  const wrongWallet = isConnected && address?.toLowerCase() !== user.address.toLowerCase();

  const { data: onChain, refetch } = useReadContract({
    address: MARKET, abi: consentCraftMarketAbi, functionName: "getPublication", args: id ? [id] : undefined, chainId: MARKET_CHAIN_ID,
    query: { enabled: !!MARKET && !!id, refetchInterval: 6000 },
  });
  const { data: settlement } = useReadContract({
    address: MARKET, abi: consentCraftMarketAbi, functionName: "previewSettlement", args: id ? [id] : undefined, chainId: MARKET_CHAIN_ID,
    query: { enabled: !!MARKET && !!id && onChain?.state === PublicationState.Published && onChain?.listingState === ListingState.Listed && onChain.settlementReason === 0 },
  });

  // While the server-side review runs, keep the studio data fresh.
  useEffect(() => {
    if (pub?.status !== "created" && pub?.status !== "reviewing") return;
    const timer = setInterval(() => { void refresh().catch(() => {}); }, 5000);
    return () => clearInterval(timer);
  }, [pub?.status, refresh]);

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setError(""); setStep(label);
    try { await fn(); await refresh(); await refetch().catch(() => {}); }
    catch (e) { setError(friendly(e)); }
    finally { setStep(""); }
  };

  const publishOnChain = () => run("Sealing pages and uploading to Arweave…", async () => {
    const prepared = await api<Prepared>("/api/publish", { action: "prepare", id: project.id, revision: project.revision, language });
    setStep("Confirm the deposit in your wallet…");
    const hash = await write({ functionName: "createPublication", args: quoteArgs(prepared), value: BigInt(prepared.publication.depositWei) });
    setStep("Waiting for confirmations…");
    await api("/api/publish", { action: "confirm", id: project.id, txHash: hash });
    notify("Your comic is on chain. The 0G AI review has started.");
  });

  if (!MARKET) return <section className="surface review-surface"><NotDeployed/></section>;
  const heading = <div className="surface-heading"><div><span className="eyebrow">ENCRYPTED ON ARWEAVE · SETTLED ON ETHEREUM</span><h2>Review &amp; publish</h2></div><Icon name="shield" size={26}/></div>;
  if (!owner) return <section className="surface review-surface">{heading}<p className="muted">Only the project owner publishes. Proceeds go to the owner&apos;s wallet; agreed shares are an off-chain arrangement in this version.</p></section>;

  const busy = !!step;
  return <section className="surface review-surface">
    {heading}
    <WorldIdVerify user={user} onVerified={refresh}/>
    {wrongWallet && <p className="form-error">Your connected wallet ({truncateAddress(address)}) is not the signed-in account ({truncateAddress(user.address)}).</p>}

    {(!pub || pub.status === "quoted") && <>
      <div className="chain-price"><span>READER PRICE</span><strong>{eth(project.priceWei)}</strong></div>
      <div className="transaction-quote"><strong>What happens when you publish</strong>
        <p>1. Every panel and caption is encrypted (AES-256-GCM) and stored permanently on Arweave. Only a small cover preview is public.</p>
        <p>2. Your wallet sends <code>createPublication</code> with a refundable deposit{pub ? ` of ${eth(pub.depositWei)}` : ""}. The contract records the comic&apos;s fingerprint, price and terms; they can never change.</p>
        <p>3. A 0G Compute model reviews the exact encrypted pages inside a TEE. Its real token cost (capped{pub ? ` at ${eth(pub.aiCapWei)}` : ""}) is the only AI charge, and it is deducted from any refund.</p>
      </div>
      <label className="field-label">Language of the comic<input value={language} maxLength={35} disabled={busy || !!pub} onChange={e => setLanguage(e.target.value)} placeholder="en"/></label>
      {pub && <p className="field-hint">Already stored on Arweave: bundle <code>{pub.bundleTxId}</code>. Publishing again re-signs the quote without re-uploading.</p>}
      <div className="chain-button-row">
        <button className="button purple" disabled={busy || dirty || wrongWallet || !isConnected || !user.worldIdVerifiedAt} onClick={publishOnChain}><Icon name="book" size={17}/>{step || "Publish on chain"}</button>
        {pub && <button className="text-button" disabled={busy} onClick={() => run("Reopening…", () => api("/api/publish", { action: "cancel", id: project.id }))}>Reopen for editing</button>}
        {pub && <button className="text-button" disabled={busy} onClick={() => run("Looking for your transaction…", () => api("/api/publish", { action: "confirm", id: project.id }))}>I already sent the transaction</button>}
      </div>
      {dirty && <p className="field-hint">Save your changes first.</p>}
    </>}

    {pub?.publicationId && <>
      <div className="chain-network"><Icon name="shield" size={14}/>PUBLICATION #{pub.publicationId} · {onChain ? PublicationStateLabels[onChain.state] : "loading…"}{onChain && onChain.state === PublicationState.Published ? ` · ${ListingStateLabels[onChain.listingState]}` : ""}</div>
      <TxLink hash={pub.createTx}/>
      {(pub.status === "created" || pub.status === "reviewing") && <div className="chain-progress">The 0G AI review is running on the exact pages stored on Arweave. This page updates automatically.</div>}
      {pub.status === "review_failed" && <div className="form-error" role="alert">The AI review did not complete: {pub.reviewError}. Your deposit stays locked and safe; nothing was charged.
        <button className="text-button" disabled={busy} onClick={() => run("Restarting review…", () => api("/api/publish", { action: "retryReview", id: project.id }))}>Retry the review</button></div>}
      {pub.review && <div className="chain-proof" ><strong>AI review by 0G Compute</strong>
        <p>{pub.review.flagged ? "Flagged" : "Passed"} · advisory score {(pub.review.score / 100).toFixed(0)}/100 · model {pub.review.model} · {pub.review.teeVerified ? "TEE signature verified" : "deterministic check (no AI call)"}</p>
        <p>{pub.review.inputTokens} input + {pub.review.outputTokens} output tokens · AI cost charged: {eth(pub.review.aiCostWei)}</p>
        <TxLink hash={pub.review.tx}/></div>}

      {onChain && <div className="chain-links">
        <span>Deposit {eth(onChain.deposit)}</span><span>AI cost {eth(onChain.aiCost)}</span><span>Sales {eth(onChain.grossSales)}</span>
        <span>{SettlementReasonLabels[onChain.settlementReason]}</span>
        {onChain.settlementReason !== 0 && <span>Refunded to you {eth(onChain.authorRefund)}</span>}
      </div>}

      {onChain?.state === PublicationState.Approved && <button className="button purple" disabled={busy} onClick={() => run("Listing…", () => write({ functionName: "publish", args: [id!] }))}><Icon name="spark" size={17}/>{step || "List it in the marketplace"}</button>}

      {onChain?.state === PublicationState.Flagged && <>
        {nowSeconds() < Number(onChain.appealDeadline) ? <>
          <label className="field-label">Explain why the review is wrong (stays private; only its hash goes on chain)<textarea value={evidence} maxLength={4000} onChange={e => setEvidence(e.target.value)}/></label>
          <button className="button yellow" disabled={busy || !evidence.trim()} onClick={() => run("Filing appeal…", async () => {
            const { hash } = await api<{ hash: Hex }>("/api/appeal", { kind: "evidence", publicationId: pub.publicationId, text: evidence });
            await write({ functionName: "appeal", args: [id!, hash] });
          })}>{step || `Appeal before ${when(onChain.appealDeadline)}`}</button>
        </> : <button className="button" disabled={busy} onClick={() => run("Finalizing…", () => write({ functionName: "finalizeRejection", args: [id!] }))}>Finalize rejection</button>}
      </>}

      {onChain?.state === PublicationState.AppealPending && <div className="chain-progress">A reviewer is considering your appeal until {when(onChain.appealResolutionDeadline)}.
        {nowSeconds() >= Number(onChain.appealResolutionDeadline) && <button className="text-button" disabled={busy} onClick={() => run("Claiming…", () => write({ functionName: "claimAppealTimeout", args: [id!] }))}>The reviewer missed the deadline: reclaim your deposit</button>}</div>}

      {onChain?.state === PublicationState.Published && onChain.listingState === ListingState.Listed && onChain.settlementReason === 0 && settlement && <div className="transaction-quote">
        <strong>Refund and delist</strong>
        <p>If you stop selling now you get back {eth(settlement[1])}. The contract keeps {eth(settlement[0])} (the larger of your sales, the AI cost, or a quarter of the deposit). Buyers keep their access.</p>
        <button className="button" disabled={busy || nowSeconds() < Number(onChain.refundEligibleAt)} onClick={() => run("Refunding…", () => write({ functionName: "refundAndDelist", args: [id!, settlement[1]] }))}>
          {nowSeconds() < Number(onChain.refundEligibleAt) ? `Available from ${when(onChain.refundEligibleAt)}` : step || `Refund ${eth(settlement[1])} and delist`}</button>
      </div>}
      {onChain?.state === PublicationState.Published && <Link className="button purple" href={`/comics/${pub.publicationId}`}>Open the comic page</Link>}
    </>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}

/* ───────────────────────────── Marketplace ────────────────────────────── */

type Listing = {
  publicationId: string; author: Address; state: number; listingState: number; settlement: number; price: string; grossSales: string;
  pageCount: number; policyId: string; title: string; description: string; genre: string; language: string; cover?: string; verified: boolean;
};

function useListings() {
  const [listings, setListings] = useState<Listing[] | null>(null);
  const [error, setError] = useState("");
  const load = useCallback(() => api<{ listings: Listing[] }>("/api/market").then(r => { setListings(r.listings); setError(""); }).catch(e => setError(friendly(e))), []);
  useEffect(() => { void load(); }, [load]);
  return { listings, error, reload: load };
}

export function MarketPage() {
  const { listings, error } = useListings();
  const [genre, setGenre] = useState("all");
  const [search, setSearch] = useState("");
  const forSale = useMemo(() => (listings ?? []).filter(l => l.state === PublicationState.Published && l.listingState === ListingState.Listed), [listings]);
  const genres = ["all", ...new Set(forSale.map(l => l.genre).filter(Boolean))];
  const shown = forSale.filter(l => (genre === "all" || l.genre === genre) && `${l.title} ${l.description}`.toLowerCase().includes(search.toLowerCase()));
  return <>
    <div className="page-heading"><div><div className="eyebrow">ON CHAIN · ENCRYPTED ON ARWEAVE</div><h1>The marketplace.<span className="heading-spark">✳</span></h1><p>Every comic here is a live listing in the ConsentCraftMarket contract.</p></div></div>
    {!MARKET ? <NotDeployed/> : error ? <div className="error-banner" role="alert"><span>{error}</span></div> : listings === null ? <div className="loading-state"><span className="loading-star">✳</span><h2>Reading the contract…</h2></div> : <>
      <div className="library-controls"><div className="filter-tabs">{genres.map(g => <button key={g} className={genre === g ? "selected" : ""} onClick={() => setGenre(g)}>{g === "all" ? "All stories" : g}</button>)}</div>
        <label className="search-field"><Icon name="search" size={18}/><input aria-label="Search comics" placeholder="Find your next read…" value={search} onChange={e => setSearch(e.target.value)}/></label></div>
      <div className="results-label">{shown.length} {shown.length === 1 ? "comic" : "comics"} on sale</div>
      {shown.length ? <div className="project-grid">{shown.map(l => <Link key={l.publicationId} className="project-card" href={`/comics/${l.publicationId}`}>
        <div className="card-art">{l.cover ? <img src={l.cover} alt=""/> : <div className="empty-cover"><Icon name="image" size={32}/></div>}{l.genre && <span className="art-corner">{l.genre}</span>}</div>
        <div className="card-content"><div className="card-status"><span className="badge published"><span/>{eth(l.price)}</span><span className="tiny-muted">#{l.publicationId} · {l.pageCount} pages</span></div>
          <h3>{l.title}</h3>{l.description && <p className="card-description">{l.description}</p>}
          <div className="card-footer"><span className="tiny-muted">by {truncateAddress(l.author)}{l.verified ? "" : " · preview unverified"}</span><span className="card-open"><Icon name="arrow" size={18}/></span></div></div>
      </Link>)}</div> : <div className="empty-state"><span className="empty-icon"><Icon name="book" size={32}/></span><h2>Nothing on sale yet</h2><p>Published comics appear here as soon as their author lists them on chain.</p></div>}
    </>}
  </>;
}

export function ListingPage({ publicationId, user, signIn }: { publicationId: string; user: User | null; signIn: () => void }) {
  const { address, isConnected } = useAccount();
  const write = useMarketWrite();
  const { listings, error: loadError, reload } = useListings();
  const listing = listings?.find(l => l.publicationId === publicationId);
  const id = /^\d+$/.test(publicationId) ? BigInt(publicationId) : undefined;
  const [pages, setPages] = useState<{ image: string; dialogue: string; alt: string }[] | null>(null);
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const [lastTx, setLastTx] = useState<string>();
  const { data: access, refetch: refetchAccess } = useReadContract({
    address: MARKET, abi: consentCraftMarketAbi, functionName: "hasReadingAccess", args: id && address ? [id, address] : undefined, chainId: MARKET_CHAIN_ID,
    query: { enabled: !!MARKET && !!id && !!address },
  });
  const { data: policy } = useReadContract({
    address: MARKET, abi: consentCraftMarketAbi, functionName: "getPolicy", args: listing ? [BigInt(listing.policyId)] : undefined, chainId: MARKET_CHAIN_ID,
    query: { enabled: !!MARKET && !!listing },
  });
  const isAuthor = !!listing && !!address && listing.author.toLowerCase() === address.toLowerCase();
  const canRead = !!access || isAuthor;
  const sessionMatches = !!user && !!address && user.address.toLowerCase() === address.toLowerCase();

  const read = async () => {
    setError(""); setStep("Decrypting your copy…");
    try { setPages((await api<{ pages: typeof pages }>(`/api/read/${publicationId}`)).pages); }
    catch (e) { setError(friendly(e)); }
    finally { setStep(""); }
  };
  const buy = async () => {
    if (!listing || !policy) return;
    setError("");
    try {
      let certificate = { wallet: "0x0000000000000000000000000000000000000000" as Address, action: 0, expiresAt: BigInt(0), nonce: BigInt(0) };
      let signature: Hex = "0x";
      if (policy.purchaseRequiresPersonhood) {
        setStep("Getting your personhood certificate…");
        const result = await api<{ certificate: Record<string, string | number>; signature: Hex }>("/api/personhood", { step: "certificate", action: "purchase" });
        certificate = { wallet: result.certificate.wallet as Address, action: Number(result.certificate.action), expiresAt: BigInt(result.certificate.expiresAt), nonce: BigInt(result.certificate.nonce) };
        signature = result.signature;
      }
      setStep("Confirm the purchase in your wallet…");
      const hash = await write({ functionName: "purchase", args: [BigInt(listing.publicationId), randomBytes32(), certificate, signature], value: BigInt(listing.price) });
      setLastTx(hash);
      await refetchAccess(); await reload();
    } catch (e) { setError(friendly(e)); }
    finally { setStep(""); }
  };

  if (!MARKET) return <NotDeployed/>;
  if (loadError) return <div className="error-banner" role="alert"><span>{loadError}</span></div>;
  if (!listings) return <div className="loading-state"><span className="loading-star">✳</span><h2>Reading the contract…</h2></div>;
  if (!listing) return <div className="empty-state"><h2>This comic is not on chain</h2><Link className="button purple" href="/comics">Back to the marketplace</Link></div>;
  const forSale = listing.state === PublicationState.Published && listing.listingState === ListingState.Listed;
  return <>
    <Link className="back-link" href="/comics"><Icon name="back" size={17}/>Back to the marketplace</Link>
    <div className="reader-heading"><div><div className="eyebrow">{(listing.genre || "comic").toUpperCase()} · {listing.pageCount} PAGES · PUBLICATION #{listing.publicationId}</div>
      <h1>{listing.title}</h1><p>{listing.description}</p>
      <div className="reader-byline"><span>By {explorerAddress(listing.author) ? <a href={explorerAddress(listing.author)} target="_blank" rel="noreferrer">{truncateAddress(listing.author)}</a> : truncateAddress(listing.author)}</span><span className="reader-dot">·</span><span>{PublicationStateLabels[listing.state]} · {ListingStateLabels[listing.listingState]}</span></div></div></div>
    {pages ? <div className="reader-paper"><div className="comic-panels">{pages.map((p, i) => <div className="comic-panel" key={i}><div className="comic-panel-image"><img src={p.image} alt={p.alt || `Page ${i + 1}`}/><span className="panel-number">0{i + 1}</span></div>{p.dialogue && <p>{p.dialogue}</p>}</div>)}</div></div>
      : <div className="collectible-sale"><div>{listing.cover && <img src={listing.cover} alt="Cover preview" style={{ width: "100%" }}/>}</div>
        <div><div className="chain-price"><span>PRICE</span><strong>{eth(listing.price)}</strong></div>
          {!isConnected || !user ? <button className="button purple" onClick={signIn}>Connect wallet and sign in</button>
            : !sessionMatches ? <p className="form-error">Your connected wallet is not the signed-in account. Sign in again with this wallet.</p>
            : canRead ? <button className="button purple" disabled={!!step} onClick={read}><Icon name="book" size={17}/>{step || (isAuthor ? "Read your comic" : "Read your copy")}</button>
            : forSale ? <>
              {policy?.purchaseRequiresPersonhood && <WorldIdVerify user={user} onVerified={() => window.location.reload()}/>}
              <button className="button purple" disabled={!!step || (policy?.purchaseRequiresPersonhood && !user.worldIdVerifiedAt)} onClick={buy}><Icon name="spark" size={17}/>{step || `Buy for ${eth(listing.price)}`}</button>
              <p className="field-hint">Paid on chain to the author (minus the platform fee). Your access is recorded in the contract and never expires.</p>
            </> : <p className="muted">This comic is not on sale.</p>}
          <TxLink hash={lastTx}/>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div></div>}
  </>;
}

/* ──────────────────────────── Buyer / author earnings ──────────────────────────── */

export function AccountPage({ user, signIn }: { user: User | null; signIn: () => void }) {
  const { address } = useAccount();
  const write = useMarketWrite();
  const client = usePublicClient({ chainId: MARKET_CHAIN_ID });
  const [purchases, setPurchases] = useState<{ id: string; price: bigint; tx: string }[] | null>(null);
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  const { data: credit, refetch } = useReadContract({
    address: MARKET, abi: consentCraftMarketAbi, functionName: "creditOf", args: address ? [address] : undefined, chainId: MARKET_CHAIN_ID, query: { enabled: !!MARKET && !!address },
  });
  useEffect(() => {
    if (!MARKET || !client || !address) return;
    client.getContractEvents({ address: MARKET, abi: consentCraftMarketAbi, eventName: "Purchased", args: { buyer: address }, fromBlock: BigInt(process.env.NEXT_PUBLIC_MARKET_START_BLOCK || "0") })
      .then(logs => setPurchases(logs.map(l => ({ id: String(l.args.publicationId), price: l.args.price ?? BigInt(0), tx: l.transactionHash }))))
      .catch(e => setError(friendly(e)));
  }, [client, address]);
  if (!MARKET) return <NotDeployed/>;
  if (!user || !address) return <div className="empty-state"><h2>Connect your wallet</h2><p>Your earnings and purchases live on chain under your wallet.</p><button className="button purple" onClick={signIn}>Sign in</button></div>;
  return <>
    <div className="page-heading"><div><div className="eyebrow">YOUR WALLET ON CHAIN</div><h1>Earnings &amp; library.</h1><p>Sale proceeds, deposit refunds and credits are held by the contract until you withdraw them.</p></div></div>
    <section className="surface earnings-card">
      <WorldIdVerify user={user} onVerified={() => window.location.reload()}/>
      <div className="earnings-balance"><span>Withdrawable now</span><strong>{eth(credit)}</strong></div>
      <button className="button purple" disabled={!credit || !!step} onClick={async () => { setError(""); setStep("Withdrawing…"); try { await write({ functionName: "withdraw", args: [] }); await refetch(); } catch (e) { setError(friendly(e)); } finally { setStep(""); } }}>{step || "Withdraw to my wallet"}</button>
      {error && <p className="form-error" role="alert">{error}</p>}
      <h3>Comics you bought</h3>
      {purchases === null ? <p className="muted">Loading…</p> : purchases.length === 0 ? <p className="muted">No purchases yet. <Link href="/comics">Browse the marketplace</Link>.</p>
        : purchases.map(p => <div key={p.tx} className="chain-history"><Link href={`/comics/${p.id}`}>Publication #{p.id}</Link> · {eth(p.price)} <TxLink hash={p.tx}/></div>)}
    </section>
  </>;
}

/* ──────────────────────────────── Admin ──────────────────────────────── */

function useRole(role: "DEFAULT_ADMIN_ROLE" | "REVIEWER_ROLE" | "PAUSER_ROLE", account?: Address) {
  const { data: roleId } = useReadContract({ address: MARKET, abi: consentCraftMarketAbi, functionName: role, chainId: MARKET_CHAIN_ID, query: { enabled: !!MARKET } });
  const { data } = useReadContract({ address: MARKET, abi: consentCraftMarketAbi, functionName: "hasRole", args: roleId && account ? [roleId, account] : undefined, chainId: MARKET_CHAIN_ID, query: { enabled: !!roleId && !!account } });
  return !!data;
}

function AppealCard({ listing, onDone }: { listing: Listing; onDone: () => void }) {
  const write = useMarketWrite();
  const [notes, setNotes] = useState<{ evidence?: { text: string } } | null>(null);
  const [reason, setReason] = useState("");
  const [step, setStep] = useState("");
  const [error, setError] = useState("");
  useEffect(() => { api<{ evidence?: { text: string } }>(`/api/appeal?publicationId=${listing.publicationId}`).then(setNotes).catch(e => setError(friendly(e))); }, [listing.publicationId]);
  const decide = (approved: boolean) => async () => {
    setError(""); setStep(approved ? "Approving…" : "Rejecting…");
    try {
      const { hash } = await api<{ hash: Hex }>("/api/appeal", { kind: "reason", publicationId: listing.publicationId, text: reason });
      await write({ functionName: "resolveAppeal", args: [BigInt(listing.publicationId), approved, hash] });
      onDone();
    } catch (e) { setError(friendly(e)); }
    finally { setStep(""); }
  };
  return <div className="chain-proof"><strong>#{listing.publicationId} · {listing.title}</strong> by {truncateAddress(listing.author)}
    <p>Author&apos;s evidence: {notes?.evidence?.text ?? "(not stored on this server)"}</p>
    <label className="field-label">Your reason (private; its hash goes on chain)<textarea value={reason} maxLength={4000} onChange={e => setReason(e.target.value)}/></label>
    <div className="chain-button-row"><button className="button purple" disabled={!!step || !reason.trim()} onClick={decide(true)}>Approve</button><button className="button" disabled={!!step || !reason.trim()} onClick={decide(false)}>Reject</button><span>{step}</span></div>
    {error && <p className="form-error">{error}</p>}</div>;
}

export function AdminPage() {
  const { address } = useAccount();
  const write = useMarketWrite();
  const isAdmin = useRole("DEFAULT_ADMIN_ROLE", address);
  const isReviewer = useRole("REVIEWER_ROLE", address);
  const isPauser = useRole("PAUSER_ROLE", address);
  const { listings, reload } = useListings();
  const [error, setError] = useState("");
  const { data: paused, refetch: refetchPaused } = useReadContract({ address: MARKET, abi: consentCraftMarketAbi, functionName: "paused", chainId: MARKET_CHAIN_ID, query: { enabled: !!MARKET } });
  const { data: covered } = useReadContract({ address: MARKET, abi: consentCraftMarketAbi, functionName: "liabilitiesCovered", chainId: MARKET_CHAIN_ID, query: { enabled: !!MARKET } });
  const { data: liabilities } = useReadContract({ address: MARKET, abi: consentCraftMarketAbi, functionName: "totalLiabilities", chainId: MARKET_CHAIN_ID, query: { enabled: !!MARKET } });
  if (!MARKET) return <NotDeployed/>;
  const appeals = (listings ?? []).filter(l => l.state === PublicationState.AppealPending);
  const counts = (listings ?? []).reduce<Record<number, number>>((acc, l) => ({ ...acc, [l.state]: (acc[l.state] ?? 0) + 1 }), {});
  return <>
    <div className="page-heading"><div><div className="eyebrow">ROLES ARE CHECKED ON CHAIN</div><h1>Admin console.</h1><p>Your wallet {truncateAddress(address)} holds: {[isAdmin && "admin", isReviewer && "reviewer", isPauser && "pauser"].filter(Boolean).join(", ") || "no market roles"}.</p></div></div>
    <section className="surface network-card">
      <h3>Contract health</h3>
      <div className="chain-links"><span>{paused ? "PAUSED" : "Running"}</span><span>Liabilities {eth(liabilities)}</span><span>{covered ? "Fully covered by balance" : "NOT covered"}</span>
        {Object.entries(counts).map(([state, n]) => <span key={state}>{PublicationStateLabels[Number(state)]}: {n}</span>)}</div>
      {isPauser && <button className="button" onClick={async () => { setError(""); try { await write({ functionName: paused ? "unpause" : "pause", args: [] }); await refetchPaused(); } catch (e) { setError(friendly(e)); } }}>{paused ? "Unpause deposits and purchases" : "Pause deposits and purchases"}</button>}
      {error && <p className="form-error">{error}</p>}
      <h3>Appeals waiting for a reviewer</h3>
      {!isReviewer ? <p className="muted">Only wallets with REVIEWER_ROLE can resolve appeals.</p> : appeals.length === 0 ? <p className="muted">No pending appeals.</p> : appeals.map(l => <AppealCard key={l.publicationId} listing={l} onDone={() => void reload()}/>)}
      <h3>All publications</h3>
      {(listings ?? []).map(l => <div key={l.publicationId} className="chain-history"><Link href={`/comics/${l.publicationId}`}>#{l.publicationId} {l.title}</Link> · {PublicationStateLabels[l.state]} · {ListingStateLabels[l.listingState]} · sales {eth(l.grossSales)} · {SettlementReasonLabels[l.settlement]}</div>)}
    </section>
  </>;
}

/* ─────────────────────────────── Network ─────────────────────────────── */

export function NetworkPage() {
  const [status, setStatus] = useState<Record<string, unknown> | null>(null);
  useEffect(() => { api("/api/status").then(setStatus).catch(() => setStatus({})); }, []);
  const rows: [string, string][] = status ? Object.entries(status).map(([k, v]) => [k, typeof v === "boolean" ? (v ? "configured" : "NOT configured") : String(v)]) : [];
  return <>
    <div className="page-heading"><div><div className="eyebrow">WHAT THIS DEPLOYMENT IS CONNECTED TO</div><h1>Network &amp; services.</h1></div></div>
    <section className="surface network-card">
      <p>Chain {MARKET_CHAIN_ID || "not set"} · ConsentCraftMarket {MARKET ? (explorerAddress(MARKET) ? <a href={explorerAddress(MARKET)} target="_blank" rel="noreferrer">{MARKET}</a> : MARKET) : "not configured"}</p>
      {rows.map(([k, v]) => <div key={k} className="chain-history">{k}: <strong>{v}</strong></div>)}
    </section>
  </>;
}
