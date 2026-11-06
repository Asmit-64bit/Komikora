"use client";
import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { editionsAddress, editionsChainId } from "@/lib/editions-client";
import type { ServiceReadiness } from "@/lib/server/readiness";
function ApprovalFailure() {
  const params = useSearchParams();
  return params.get("approval") === "failed" ? <p role="alert">World ID approval could not be completed. Return to your project or creator profile to start a fresh request.</p> : null;
}
export function IntegrationStatus() {
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const q = useQuery({ queryKey: ["integration-readiness"], queryFn: async () => { const r = await fetch("/api/readiness", { cache: "no-store" }); if (!r.ok) throw new Error("Service status could not be loaded."); return await r.json() as { services: ServiceReadiness[] }; } });
  const [checked, setChecked] = useState<{ services: ServiceReadiness[] }>();
  return <><div className="page-heading"><div><div className="eyebrow">CONNECTIONS AND DEPLOYMENT</div><h1>Network & services.</h1><p>Configured services and live checks are shown separately.</p></div></div><section className="surface" style={{ padding: 24 }}><p>Chain {editionsChainId} · NFT contract {editionsAddress ? editionsChainId === 11155111 ? <a href={`https://sepolia.etherscan.io/address/${editionsAddress}`} target="_blank" rel="noreferrer">{editionsAddress}</a> : editionsAddress : "not deployed or configured"}</p><button className="button purple" disabled={busy} onClick={async () => { setBusy(true); setError(""); try { const r = await fetch("/api/readiness", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }); const b = await r.json(); if (!r.ok) throw new Error(b.error); setChecked(b); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }}>{busy ? "Checking connections…" : "Check connections"}</button><p>Checks read network and model metadata; they do not deploy contracts or generate paid inference.</p><Suspense fallback={null}><ApprovalFailure/></Suspense>{(error || q.error) && <p role="alert">{error || q.error?.message}</p>}{(checked || q.data)?.services.map(s => <div className="chain-history" key={s.name}><h3>{s.name} · {s.status}</h3><p>{s.detail}</p>{s.fields.length > 0 && <p>Missing settings: <code>{s.fields.join(", ")}</code></p>}{s.link && <a href={s.link} target="_blank" rel="noreferrer">Open {s.name} setup or explorer ↗</a>}</div>)}<h3>World ID callback</h3><p>Register your public application origin followed by <code>/api/agent-pass/callback</code>. Client secrets belong in the server environment. A successful identity check still requires explicit approval of each publication.</p></section></>;
}
