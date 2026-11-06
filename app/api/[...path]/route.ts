import { json } from "@/lib/server/http";

// Unknown and removed API paths must not render the studio's HTML catch-all.
function missingRoute() { return json({ error: "API route not found." }, 404); }
export const GET = missingRoute;
export const POST = missingRoute;
export const PUT = missingRoute;
export const PATCH = missingRoute;
export const DELETE = missingRoute;
