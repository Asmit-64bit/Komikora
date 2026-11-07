import type { OriginalityResult } from "@/lib/types";

export function SimilarityFindings({ result }: { result: OriginalityResult }) {
  return <div className="chain-proof"><strong>Story and similarity review</strong><p>{result.crux}</p><p>Highest similarity: {result.maxSimilarity}% · {result.comparedComicCount} published comics compared</p>{result.comparisons.length ? <ul>{result.comparisons.map(item => <li key={item.comicId}><strong>{item.title} (comic #{item.comicId}): {item.similarity}%</strong><p>{item.relevance}</p></li>)}</ul> : <p>No previously published comics to compare.</p>}<p>AI estimates can be inaccurate and do not establish copyright or authorship. More than 85% similarity blocks publishing.</p></div>;
}

