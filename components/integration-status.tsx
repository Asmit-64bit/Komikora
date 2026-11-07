"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { readingAddress, readingChainId } from "@/lib/reading-client";
import type { ServiceReadiness } from "@/lib/server/readiness";
export function IntegrationStatus() {
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ["integration-readiness"], queryFn: async () => { const r = await fetch("/api/readiness", { cache: "no-store" }); if (!r.ok) throw new Error("Service status could not be loaded."); return await r.json() as { services: ServiceReadiness[] }; } });
  const [checked, setChecked] = useState<{ services: ServiceReadiness[] }>();
  return <><div className="page-heading"><div><div className="eyebrow">CONNECTIONS AND DEPLOYMENT</div><h1>Network & services.</h1><p>Configured services and live checks are shown separately.</p></div></div><section className="surface" style={{ padding: 24 }}><p>Chain {readingChainId} · Reading contract {readingAddress ? readingChainId === 11155111 ? <a href={`https://sepolia.etherscan.io/address/${readingAddress}`} target="_blank" rel="noreferrer">{readingAddress}</a> : readingAddress : "not deployed or configured"}</p><button className="button purple" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { const r = await fetch("/api/readiness", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); const b = await r.json(); if (!r.ok) throw new Error(b.error); setChecked(b); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }}>{busy ? "Checking connections…" : "Check connections"}</button><p>Checks read network and model metadata; they do not deploy contracts or generate paid inference.</p>{(error || q.error) && <p role="alert">{error || q.error?.message}</p>}{(checked || q.data)?.services.map(s => <div className="chain-history" key={s.name}><h3>{s.name} · {s.status}</h3><p>{s.detail}</p>{s.fields.length > 0 && <p>Missing settings: <code>{s.fields.join(", ")}</code></p>}{s.link && <a href={s.link} target="_blank" rel="noreferrer">Open {s.name} setup or explorer ↗</a>}</div>)}</section></>;
}
