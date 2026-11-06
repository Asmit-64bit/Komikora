import type { Page } from "@playwright/test";
import type { PrivateKeyAccount, Hex } from "viem";

// Browser-only test provider. Signatures come from real ephemeral private keys
// in the test runner; application code and server verification are unchanged.
export async function installWallet(page: Page, wallets: PrivateKeyAccount[]) {
  await page.exposeFunction("signTestWalletMessage", async (address: string, message: Hex) => {
    const wallet = wallets.find(wallet => wallet.address.toLowerCase() === address.toLowerCase());
    if (!wallet) throw new Error("Unknown test wallet");
    return wallet.signMessage({ message: { raw: message } });
  });
  await page.addInitScript(({ address }) => {
    let selected: string = address;
    let authorized = sessionStorage.getItem("test-wallet-authorized") === "yes";
    let rejectNext = false;
    const requests: { method: string; params: unknown[] }[] = [];
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const emit = (event: string, value: unknown) => listeners.get(event)?.forEach(callback => callback(value));
    const provider = {
      on(event: string, callback: (...args: unknown[]) => void) {
        if (!listeners.has(event)) listeners.set(event, new Set());
        listeners.get(event)!.add(callback);
      },
      removeListener(event: string, callback: (...args: unknown[]) => void) { listeners.get(event)?.delete(callback); },
      async request({ method, params = [] }: { method: string; params?: unknown[] }) {
        requests.push({ method, params });
        if (method === "eth_chainId") return "0x1";
        if (method === "net_version") return "1";
        if (method === "eth_accounts") return authorized ? [selected] : [];
        if (method === "eth_requestAccounts" || method === "wallet_requestPermissions") {
          authorized = true; sessionStorage.setItem("test-wallet-authorized", "yes");
          return method === "eth_requestAccounts" ? [selected] : [{ parentCapability: "eth_accounts", caveats: [{ type: "restrictReturnedAccounts", value: [selected] }] }];
        }
        if (method === "wallet_revokePermissions") {
          authorized = false; sessionStorage.removeItem("test-wallet-authorized"); return null;
        }
        if (method === "personal_sign") {
          if (rejectNext) { rejectNext = false; throw Object.assign(new Error("User rejected request"), { code: 4001 }); }
          return (window as unknown as { signTestWalletMessage: (address: string, message: string) => Promise<string> }).signTestWalletMessage(String(params[1]), String(params[0]));
        }
        throw Object.assign(new Error(`Unsupported wallet method ${method}`), { code: 4200 });
      },
    };
    Object.defineProperty(window, "ethereum", { value: provider, configurable: true });
    const announce = () => window.dispatchEvent(new CustomEvent("eip6963:announceProvider", { detail: {
      info: { uuid: "e6b8c12a-8b0b-4ae3-92dc-5c172fb2b654", name: "Test Wallet", icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg'/>", rdns: "test.consentcraft.wallet" }, provider,
    } }));
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
    Object.assign(window, { walletTest: {
      getRequests() { return requests; },
      rejectNextSignature() { rejectNext = true; },
      switchAccount(next: string) { selected = next; authorized = true; emit("accountsChanged", [next]); },
      disconnect() { authorized = false; sessionStorage.removeItem("test-wallet-authorized"); emit("accountsChanged", []); },
    } });
  }, { address: wallets[0].address });
}

export type WalletTestWindow = Window & { walletTest: { getRequests(): { method: string; params: unknown[] }[]; rejectNextSignature(): void; switchAccount(address: string): void; disconnect(): void } };
