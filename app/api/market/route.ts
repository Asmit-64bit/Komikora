import { failure, json } from "@/lib/server/http";
import { listings } from "@/lib/server/market";

export async function GET() {
  try { return json({ listings: await listings() }); }
  catch (error) { return failure(error); }
}
