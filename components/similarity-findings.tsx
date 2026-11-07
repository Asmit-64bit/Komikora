import Link from "next/link";
import type { OriginalityResult } from "@/lib/types";
import { ORIGINALITY_THRESHOLD } from "@/lib/originality";
export function SimilarityFindings({ result }: { result: Omit<OriginalityResult, "crux"> & { crux?: string } }) {
  const blocked = result.maxSimilarity > ORIGINALITY_THRESHOLD;
  return <section className="chain-proof similarity-findings" aria-label="Similarity scan results">
    <strong>Similarity scan · {result.maxSimilarity}% highest match</strong>
    <p>{blocked ? "Publication blocked: the highest similarity exceeds 85%. Reopen the draft for corrections and collect fresh collaborator approvals." : `Compared with ${result.comparedComicCount} confirmed ${result.comparedComicCount === "1" ? "comic" : "comics"} in this reading marketplace. Similarity above 85% blocks publication.`}</p>
    {result.crux && <details><summary>Synopsis used for comparison</summary><p>{result.crux}</p></details>}
    {result.comparisons.length > 0 && <details><summary>Compare published comics</summary><ul>{result.comparisons.map(match => <li key={match.comicId}><Link href={`/readings/${match.comicId}`}>{match.title}</Link><strong> · {match.similarity}%</strong><p>{match.relevance}</p></li>)}</ul></details>}
    <p className="field-hint">AI-estimated narrative and visual similarity is not proof of copying, copyright or authorship. This scan covers this reading contract, not other websites or earlier edition contracts.</p>
    <p className="field-hint">{result.model} · Checked {new Date(result.at).toLocaleString()} · Request {result.requestId}</p>
  </section>;
}
