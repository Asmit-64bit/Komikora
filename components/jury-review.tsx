"use client";
import { useState } from "react";

export function JuryReview({ projectId, dirty }: { projectId: string; dirty: boolean }) {
  const [comicId, setComicId] = useState("");
  const [version, setVersion] = useState("1");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [comicHash, setComicHash] = useState("");
  async function getHash() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/jury?projectId=${encodeURIComponent(projectId)}`, { cache: "no-store" });
      const result = await response.json() as { error?: string; comicHash?: string; arweaveId?: string };
      if (!response.ok || !result.comicHash) throw new Error(result.error || "Could not calculate the comic hash.");
      setComicHash(`${result.comicHash} · Arweave ID: ${result.arweaveId}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not calculate the comic hash."); }
    finally { setBusy(false); }
  }
  async function submit() {
    if (!window.confirm("Run the configured AI jury and submit its rating on chain? This uses 0G inference and relayer gas.")) return;
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/jury", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, comicId, rubricVersion: version }) });
      const result = await response.json() as { error?: string; transactionHash?: string; evidenceURI?: string };
      if (!response.ok) throw new Error(result.error || "The jury request failed.");
      setMessage(`Rating submitted: ${result.transactionHash}. Check chain confirmation before retrying. Evidence: ${result.evidenceURI}`);
    } catch (error) { setMessage(error instanceof Error ? error.message : "The jury request failed."); }
    finally { setBusy(false); }
  }
  return <section className="surface"><h2>AI jury rating</h2><p>Run independent model reviews and post their reading-quality scores to the rating registry. This does not check originality.</p><p>The comic must already be registered with a hash matching this verified Arweave bundle. Only the project owner can submit.</p><button className="button" disabled={busy || dirty} onClick={getHash}>Get comic registration details</button>{comicHash && <p>Registration details: <code>{comicHash}</code></p>}<label>Registry comic ID<input inputMode="numeric" value={comicId} onChange={e => setComicId(e.target.value)} /></label><label>Rubric version<input inputMode="numeric" value={version} onChange={e => setVersion(e.target.value)} /></label><button className="button purple" disabled={busy || dirty || !/^\d+$/.test(comicId) || !/^\d+$/.test(version)} onClick={submit}>{busy ? "Running jury…" : "Run jury and submit"}</button>{dirty && <p>Save changes before running the jury.</p>}{message && <p role="status">{message}</p>}</section>;
}
