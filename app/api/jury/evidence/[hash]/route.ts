import { NextRequest, NextResponse } from "next/server";
import { isHex, keccak256, toBytes } from "viem";
import { database } from "@/lib/store";

export async function GET(_req: NextRequest, context: { params: Promise<{ hash: string }> }) {
  const { hash } = await context.params;
  if (!isHex(hash) || hash.length !== 66) return new NextResponse(null, { status: 404 });
  const evidence = await database(db => db.juryEvidence?.[hash.toLowerCase()]);
  if (!evidence || keccak256(toBytes(evidence)).toLowerCase() !== hash.toLowerCase()) return new NextResponse(null, { status: 404 });
  return new NextResponse(evidence, { headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=31536000, immutable" } });
}
