"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { AppData } from "@/lib/types";

const empty: AppData = { user: null, projects: [], comics: [], invitations: [] };
export type StudioResult = { id?: string; token?: string };
class StudioError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function studioRequest<T>(body?: Record<string, unknown>, query = ""): Promise<T> {
  const response = await fetch(`/api/studio${query}`, {
    method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store",
    ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error("The studio could not be reached. Please try again."); }
  if (!response.ok) throw new StudioError(result.error || "The request failed.", response.status);
  return result as T;
}

const StudioContext = createContext<{
  data: AppData; loading: boolean; error: string;
  refresh: () => Promise<void>;
  execute: (body: Record<string, unknown>) => Promise<StudioResult>;
} | null>(null);

export function StudioProvider({ children }: { children: React.ReactNode }) {
  const [data, setData] = useState<AppData>(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++requestId.current;
    try {
      const result = await studioRequest<AppData>();
      if (current === requestId.current) {
        setData(result); setError("");
      }
    } catch (error) {
      if (current === requestId.current) { setError((error as Error).message); setData(empty); }
      throw error;
    } finally { if (current === requestId.current) setLoading(false); }
  }, []);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);
  const execute = useCallback(async (body: Record<string, unknown>) => {
    // Invalidate an older GET before an account-changing mutation.
    requestId.current++;
    let result: StudioResult;
    try { result = await studioRequest<StudioResult>(body); }
    catch (error) {
      // Clear expired sessions, but keep unsaved edits after validation/conflicts.
      if (error instanceof StudioError && error.status === 401 && body.action !== "login") await refresh().catch(() => {});
      else setLoading(false);
      throw error;
    }
    if (body.action === "logout" || body.action === "login" || body.action === "signup") setData(empty);
    await refresh();
    return result;
  }, [refresh]);
  return <StudioContext.Provider value={{ data, loading, error, refresh, execute }}>{children}</StudioContext.Provider>;
}

export function useStudio() {
  const value = useContext(StudioContext);
  if (!value) throw new Error("StudioProvider is missing");
  return value;
}
