"use client";
import { useAccount } from "wagmi";
import { useQuery } from "@tanstack/react-query";
import { editionRequest, editionsAddress } from "./editions-client";
export function useTradeAccess() {
  const { address, isConnected } = useAccount();
  const query = useQuery({
    queryKey: ["editions", "access", address],
    queryFn: () => editionRequest<{ unlocked: boolean }>(undefined, `?view=access&wallet=${address}`),
    enabled: !!editionsAddress && isConnected && !!address,
    refetchInterval: 15000, staleTime: 0,
  });
  return { unlocked: isConnected && !!editionsAddress && query.isSuccess && query.data.unlocked, checking: !!editionsAddress && isConnected && query.isPending, error: query.error };
}
