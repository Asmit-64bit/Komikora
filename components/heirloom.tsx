"use client";
import { useCallback, useState } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAccount, useConfig, usePublicClient, useReadContracts, useSwitchChain, useWriteContract } from "wagmi";
import { getAccount } from "wagmi/actions";
import { formatEther, getAddress, isAddress, zeroAddress, type Address } from "viem";
import { getHeirloom, heirloomAbi } from "@/lib/heirloom-client";
import { readingAddress, readingChainId, readingRequest, type ReadingSnapshot } from "@/lib/reading-client";
import { useStudio } from "./studio-provider";

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const date = (v: string | number) => Number(v) ? new Date(Number(v) * 1000).toLocaleString() : "—";
const errorText = (e: unknown) => (e as { shortMessage?: string }).shortMessage || (e as Error).message || "Please retry.";

function useHeirloomWrite() {
  const { data } = useStudio(); const config = useConfig(); const queries = useQueryClient();
  const client = usePublicClient({ chainId: readingChainId }); const { switchChainAsync } = useSwitchChain(); const { writeContractAsync } = useWriteContract();
  return useCallback(async (functionName: string, args: readonly unknown[] = []) => {
    if (!readingAddress || !client) throw new Error("Configure the Heirloom-enabled reading contract first.");
    const actor = getAccount(config).address;
    if (!same(actor, data.user?.address)) throw new Error("Connect and sign in with the wallet making this change.");
    if (getAccount(config).chainId !== readingChainId) await switchChainAsync({ chainId: readingChainId });
    if (!same(actor, getAccount(config).address)) throw new Error("Wallet changed. Retry the action.");
    const call = { address: readingAddress, abi: heirloomAbi, functionName, args, account: actor, chainId: readingChainId };
    await client.simulateContract(call as never);
    const hash = await writeContractAsync(call as never);
    const receipt = await client.waitForTransactionReceipt({ hash, confirmations: readingChainId === 31337 ? 1 : 3 });
    if (receipt.status !== "success") throw new Error("The transaction reverted.");
    await queries.invalidateQueries({ queryKey: ["heirloom"] });
    await queries.invalidateQueries({ queryKey: ["reading"] });
    await queries.invalidateQueries({ queryKey: ["readContracts"] });
    return hash;
  }, [client, config, data.user?.address, queries, switchChainAsync, writeContractAsync]);
}

export function HeirloomPage() {
  const { data: studio } = useStudio(); const { address } = useAccount(); const write = useHeirloomWrite();
  const [inspect, setInspect] = useState(""); const [lookup, setLookup] = useState(""); const [page, setPage] = useState(0);
  const [heirs, setHeirs] = useState([{ address: "", percent: "100" }]);
  const [guardian, setGuardian] = useState(""); const [inactivity, setInactivity] = useState(180); const [challenge, setChallenge] = useState(14);
  const [busy, setBusy] = useState(""); const [error, setError] = useState(""); const [success, setSuccess] = useState("");
  const owner = lookup || studio.user?.address || address;
  const signed = same(address, studio.user?.address);
  const q = useQuery({ queryKey: ["heirloom", owner, studio.user?.id], queryFn: () => getHeirloom(owner!), enabled: !!owner && !!readingAddress && isAddress(owner), retry: false, refetchInterval: 15000 });
  const library = useQuery({ queryKey: ["reading", "heirloom-owner", owner, page], queryFn: () => readingRequest<ReadingSnapshot>(undefined, "?wallet=" + owner + "&library=1&page=" + page), enabled: q.data?.supported === true && !!owner, retry: false, refetchInterval: 30000 });
  async function act(label: string, name: string, args: readonly unknown[] = []) {
    setBusy(label); setError(""); setSuccess("");
    try { setSuccess("Confirmed: " + await write(name, args)); }
    catch (e) { setError(errorText(e)); }
    finally { setBusy(""); }
  }
  async function configure() {
    setError("");
    try {
      if (!Number.isInteger(inactivity) || inactivity < 30 || inactivity > 3650 || !Number.isInteger(challenge) || challenge < 7 || challenge > 90) throw new Error("Choose 30–3,650 inactive days and a 7–90 day challenge window.");
      const people: Address[] = []; const bps: number[] = [];
      for (const heir of heirs) {
        if (!isAddress(heir.address) || same(heir.address, address) || same(heir.address, zeroAddress) || !/^\d{1,3}(\.\d{1,2})?$/.test(heir.percent)) throw new Error("Enter a different wallet for each heir and a positive share with up to two decimal places.");
        people.push(getAddress(heir.address)); bps.push(Math.round(Number(heir.percent) * 100));
      }
      if (new Set(people.map(p => p.toLowerCase())).size !== people.length || bps.some(p => p <= 0) || bps.reduce((a, b) => a + b, 0) !== 10000) throw new Error("Use distinct heirs with positive shares totaling 100%.");
      if (guardian && (!isAddress(guardian) || same(guardian, address))) throw new Error("The guardian must be another wallet, or leave it empty.");
      if (!window.confirm("After " + inactivity + " days without a confirmed check-in or marketplace action, heirs can start a claim. You then have " + challenge + " days to cancel. Finalization permanently activates inheritance for this wallet on this contract. Save this plan?")) return;
      await act("Saving inheritance plan…", "configureInheritance", [people, bps, guardian ? getAddress(guardian) : zeroAddress, BigInt(inactivity * 86400), BigInt(challenge * 86400)]);
    } catch (e) { setError(errorText(e)); }
  }
  const snapshot = q.data?.supported ? q.data : undefined; const plan = snapshot?.plan;
  const isOwner = signed && same(address, owner);
  const myShare = plan?.heirs.find(h => same(h.address, address))?.bps || 0;
  const isGuardian = signed && same(plan?.guardian, address);
  const now = Number(snapshot?.timestamp || "0");
  const expires = Number(plan?.lastActivity || "0") + Number(plan?.inactivityPeriod || "0");
  const claimEnds = Number(plan?.claimStartedAt || "0") + Number(plan?.challengePeriod || "0");
  const claimed = useReadContracts({
    contracts: (library.data?.comics || []).map(c => ({ address: readingAddress!, abi: heirloomAbi, functionName: "readingInheritanceClaimed" as const, args: [owner && isAddress(owner) ? getAddress(owner) : zeroAddress, BigInt(c.id), address || zeroAddress] as const })),
    query: { enabled: !!readingAddress && !!plan?.finalized && signed && myShare > 0, refetchInterval: 15000 },
  });
  return <>
    <div className="page-heading"><div><div className="eyebrow">A FUTURE FOR YOUR STORIES</div><h1>Comic inheritance.</h1><p>Choose who can receive your reading library and creator proceeds after a period of inactivity.</p></div></div>
    <div className="info-banner">A confirmed check-in or marketplace transaction resets the timer. Signing in or opening this page does not. Inactivity cannot establish whether someone has died.</div>
    <form className="surface heirloom-lookup" onSubmit={e => { e.preventDefault(); if (!isAddress(inspect)) { setError("Enter a valid owner wallet address."); return; } setLookup(getAddress(inspect)); setPage(0); }}><label>Inspect an owner wallet<input value={inspect} onChange={e => setInspect(e.target.value)} placeholder={studio.user?.address || "0x…"}/></label><button className="button" type="submit">View plan</button>{lookup && <button className="text-button" type="button" onClick={() => { setLookup(""); setPage(0); }}>Back to my wallet</button>}</form>
    {!readingAddress && <section className="surface"><h2>Inheritance needs a marketplace deployment</h2><p>Configure the Heirloom-enabled reading contract to set a plan.</p><Link className="text-button" href="/network">Network & services →</Link></section>}
    {!owner && <p>Connect a wallet to inspect your plan, or enter an owner wallet above.</p>}
    {q.isFetching && !q.data && <p role="status">Checking confirmed inheritance state…</p>}
    {q.error && <p role="alert">{errorText(q.error)}</p>}
    {q.data?.supported === false && <section className="surface"><h2>This deployment does not support inheritance</h2><p>Inheritance requires a new Heirloom-enabled deployment. This page cannot move purchases or proceeds from an older contract.</p></section>}
    {snapshot && plan && <div className="heirloom-layout">
      <section className="surface"><span className="eyebrow">CONFIRMED PLAN</span><h2>{plan.finalized ? "Inheritance is active" : !plan.configured ? "No inheritance plan" : Number(plan.claimStartedAt) ? "A claim is open" : now >= expires ? "Inactivity period elapsed" : "Owner check-ins are active"}</h2><p className="heirloom-address">Owner {snapshot.owner}</p>
        {plan.configured && <><dl className="heirloom-facts"><dt>Last activity</dt><dd>{date(plan.lastActivity)}</dd><dt>Claim can start</dt><dd>{date(expires)}</dd><dt>Challenge window</dt><dd>{Number(plan.challengePeriod) / 86400} days</dd>{Number(plan.claimStartedAt) > 0 && <><dt>Claim can finalize</dt><dd>{date(claimEnds)}</dd></>}<dt>Guardian</dt><dd className="heirloom-address">{plan.guardian === zeroAddress ? "None" : plan.guardian} · {plan.vetoesUsed}/2 vetoes used</dd><dt>Unwithdrawn owner proceeds</dt><dd>{formatEther(BigInt(snapshot.credit))} ETH</dd></dl><ul className="heirloom-beneficiaries">{plan.heirs.map(h => <li key={h.address}><span>{h.address}</span><strong>{h.bps / 100}%</strong></li>)}</ul></>}
        <p>Every positive-share heir can claim reading access. Proceeds follow the percentages above. Copyright, creator credit and the original collaborator allocations stay recorded as published.</p>
        {isOwner && plan.configured && !plan.finalized && <div className="heirloom-actions"><button className="button purple" disabled={!!busy} onClick={() => act("Checking in…", "checkIn")}>Check in / cancel claim</button><button className="button" disabled={!!busy} onClick={() => { if (window.confirm("Disable this plan and cancel any open claim?")) void act("Disabling plan…", "disableInheritance"); }}>Disable plan</button></div>}
        {signed && myShare > 0 && !plan.finalized && <div className="heirloom-actions"><button className="button" disabled={!!busy || !plan.configured || Number(plan.claimStartedAt) > 0 || now < expires} onClick={() => act("Starting claim…", "startInheritanceClaim", [snapshot.owner])}>Start inactivity claim</button><button className="button purple" disabled={!!busy || !Number(plan.claimStartedAt) || now < claimEnds} onClick={() => { if (window.confirm("Finalize inheritance permanently? The owner cannot cancel after confirmation.")) void act("Finalizing inheritance…", "finalizeInheritance", [snapshot.owner]); }}>Finalize inheritance</button></div>}
        {isGuardian && !plan.finalized && <button className="button" disabled={!!busy || plan.vetoesUsed >= 2} onClick={() => act("Cancelling claim…", "vetoInheritanceClaim", [snapshot.owner])}>Guardian veto / restart timer</button>}
        {signed && myShare > 0 && plan.finalized && <><h3>Your inherited proceeds</h3><p>{formatEther(BigInt(snapshot.claimable))} ETH available · your share {myShare / 100}%</p><button className="button purple" disabled={!!busy || snapshot.claimable === "0"} onClick={() => act("Withdrawing inherited proceeds…", "withdrawInheritedProceeds", [snapshot.owner, address])}>Withdraw to my wallet</button><p className="field-hint">Future sales continue to add to your share. Small fractions can remain as rounding dust.</p></>}
        {!signed && <p>Connect and sign in with your wallet to change a plan or make a claim.</p>}
      </section>
      {isOwner && !plan.finalized && <section className="surface"><span className="eyebrow">YOUR CHOICE, ON CHAIN</span><h2>{plan.configured ? "Replace your plan" : "Set your heirs"}</h2><p>A replacement cancels an open claim and resets the timer. Use wallets your heirs control.</p>
        {heirs.map((heir, i) => <div className="heirloom-heir-row" key={i}><label>Heir {i + 1} wallet<input aria-label={"Heir " + (i + 1) + " wallet"} value={heir.address} onChange={e => setHeirs(prev => prev.map((h, n) => n === i ? { ...h, address: e.target.value } : h))}/></label><label>Share (%)<input aria-label={"Heir " + (i + 1) + " share"} inputMode="decimal" value={heir.percent} onChange={e => setHeirs(prev => prev.map((h, n) => n === i ? { ...h, percent: e.target.value } : h))}/></label>{heirs.length > 1 && <button className="text-button" onClick={() => setHeirs(prev => prev.filter((_, n) => n !== i))}>Remove</button>}</div>)}
        <button className="text-button" disabled={heirs.length >= 8} onClick={() => setHeirs(prev => [...prev, { address: "", percent: "" }])}>+ Add heir</button>
        <label>Guardian wallet (optional)<input value={guardian} onChange={e => setGuardian(e.target.value)}/></label><p className="field-hint">A guardian can reset the timer twice per plan and cannot move funds.</p>
        <label>Inactive days<input type="number" min={30} max={3650} value={inactivity} onChange={e => setInactivity(Number(e.target.value))}/></label><label>Challenge days<input type="number" min={7} max={90} value={challenge} onChange={e => setChallenge(Number(e.target.value))}/></label>
        <button className="button purple" disabled={!!busy} onClick={configure}>Save inheritance plan</button>
      </section>}
      <section className="surface heirloom-comics"><span className="eyebrow">LIBRARY & CREATOR SHARES</span><h2>Comics associated with this wallet</h2><p>After inheritance activates, each heir claims access to the comics they want to read. Creator proceeds are claimed separately above.</p>
        {library.isPending && <p role="status">Loading comic access…</p>}{library.error && <p role="alert">{errorText(library.error)}</p>}
        {library.data?.comics.map((c, index) => { const alreadyClaimed = claimed.data?.[index]?.result === true; const share = c.contributors.find(m => same(m.address, owner))?.share; return <article className="heirloom-comic" key={c.id}><div><Link href={"/readings/" + c.id}><strong>{c.title}</strong></Link><p>Comic #{c.id}{share !== undefined ? " · creator allocation " + share / 100 + "%" : " · reading purchase"}</p></div>{signed && myShare > 0 && plan.finalized && <button className="button small" disabled={!!busy || alreadyClaimed} onClick={() => act("Claiming comic access…", "inheritReading", [snapshot.owner, [BigInt(c.id)]])}>{alreadyClaimed ? "Access claimed" : "Claim reading access"}</button>}</article>; })}
        {library.data?.comics.length === 0 && <p>No associated comics on this page.</p>}
        {library.data && <div className="heirloom-actions"><button className="button small" disabled={!page} onClick={() => setPage(p => p - 1)}>Newer</button><span>Page {page + 1}</span><button className="button small" disabled={(page + 1) * 12 >= Number(library.data.total)} onClick={() => setPage(p => p + 1)}>Older</button></div>}
      </section>
    </div>}
    {busy && <p role="status">{busy} Confirm in your wallet and wait for chain confirmation.</p>}{error && <p className="form-error" role="alert">{error}</p>}{success && <p className="heirloom-address" role="status">{success}</p>}
  </>;
}
