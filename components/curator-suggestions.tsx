"use client";
import { useState } from "react";
import Link from "next/link";
import { useStudio } from "./studio-provider";
import { editionsAddress } from "@/lib/editions-client";
export function CuratorSuggestions() {
  const { data } = useStudio(); const [interests, setInterests] = useState(""); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [result, setResult] = useState<{ picks: { tokenId: string; title: string; reason: string }[]; requestId?: string; model?: string; message?: string }>();
  return <section className="surface" style={{ padding: 24, marginBottom: 24 }}><h2>Your curator’s shelf</h2><p>Tell the 0G curator what you enjoy. Suggestions use public comic descriptions and active first-sale auctions.</p>
    <form onSubmit={async e => { e.preventDefault(); setBusy(true); setError(""); try { const res = await fetch("/api/recommendations", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ interests }) }); const body = await res.json(); if (!res.ok) throw new Error(body.error); setResult(body); } catch(e) { setError((e as Error).message); } finally { setBusy(false); } }}>
    <label>What stories do you enjoy?<textarea aria-label="Reading interests" value={interests} onChange={e => setInterests(e.target.value)} maxLength={1000} placeholder="Short fantasy stories with atmospheric artwork" required/></label><button className="button purple" disabled={busy || !data.user || !editionsAddress}>{busy ? "Asking the curator…" : "Get curator suggestions"}</button>{!data.user && <p>Connect your wallet and sign in to request suggestions.</p>}</form>
    {error && <p role="alert">{error}</p>}{result?.message && <p>{result.message}</p>}{result?.picks.map(p => <p key={p.tokenId}><Link href={`/editions/${p.tokenId}`}>{p.title} · Edition #{p.tokenId}</Link><br/>{p.reason}</p>)}{result?.requestId && <p className="edition-wallet">0G request {result.requestId} · {result.model}</p>}
  </section>;
}
