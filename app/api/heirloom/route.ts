import { connection, NextRequest } from "next/server";
import { getAddress, isAddress } from "viem";
import { database, ensure, sessionUser } from "@/lib/store";
import { SESSION_COOKIE } from "@/lib/wallet-auth";
import { failure, json } from "@/lib/server/http";
import { heirloomSnapshot } from "@/lib/server/heirloom";

export async function GET(req: NextRequest) {
  await connection();
  try {
    const user = await database(db => sessionUser(db, req.cookies.get(SESSION_COOKIE)?.value));
    const owner = req.nextUrl.searchParams.get("owner") || user?.address;
    ensure(owner && isAddress(owner), "Connect a wallet or enter the owner wallet address.");
    return json(await heirloomSnapshot(getAddress(owner), user?.address));
  } catch (error) { return failure(error); }
}
