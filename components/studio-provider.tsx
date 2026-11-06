"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { AppData } from "@/lib/types";
import { useAccount, useAccountEffect, useDisconnect } from "wagmi";

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
  clearSession: () => Promise<void>;
  execute: (body: Record<string, unknown>) => Promise<StudioResult>;
} | null>(null);

export function StudioProvider({ children }: { children: React.ReactNode }) {
  const account = useAccount();
  const { disconnectAsync } = useDisconnect();
  const [data, setData] = useState<AppData>(empty);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestId = useRef(0);
  const clearing = useRef<Promise<void> | null>(null);
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
  const clearSession = useCallback(() => {
    if (clearing.current) return clearing.current;
    requestId.current++;
    setData(empty);
    const work = studioRequest({ action: "logout" }).then(() => { setError(""); })
      .catch(error => { setError("Could not end your session. Please reconnect and try again."); throw error; })
      .finally(() => { clearing.current = null; setLoading(false); });
    clearing.current = work;
    return work;
  }, []);
  useAccountEffect({ onDisconnect: () => { void clearSession().catch(() => {}); } });
  const walletMismatch = !!(data.user && account.isConnected && data.user.address.toLowerCase() !== account.address?.toLowerCase());
  useEffect(() => {
    if (walletMismatch) void clearSession().catch(() => {});
  }, [walletMismatch, clearSession]);
  const execute = useCallback(async (body: Record<string, unknown>) => {
    if (body.action === "logout") {
      await clearSession();
      await disconnectAsync();
      return {};
    }
    if (clearing.current) await clearing.current;
    // Invalidate an older GET before an account-changing mutation.
    requestId.current++;
    let result: StudioResult;
    try { result = await studioRequest<StudioResult>(body); }
    catch (error) {
      // Clear expired sessions, but keep unsaved edits after validation/conflicts.
      if (error instanceof StudioError && error.status === 401) await refresh().catch(() => {});
      else setLoading(false);
      throw error;
    }
    if (body.action === "siwe") setData(empty);
    await refresh();
    return result;
  }, [refresh, clearSession, disconnectAsync]);
  return <StudioContext.Provider value={{ data: walletMismatch ? empty : data, loading, error, refresh, execute, clearSession }}>{children}</StudioContext.Provider>;
}

export function useStudio() {
  const value = useContext(StudioContext);
  if (!value) throw new Error("StudioProvider is missing");
  return value;
}
