import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { GET, POST } from "@/app/api/personhood/route";
import {
  marketDomain,
  PERSONHOOD_CERTIFICATE_TYPES,
  PersonhoodAction,
  type PersonhoodCertificate,
} from "@/lib/eip712";

describe("Personhood Attestation Bridge & EIP-712 Certificate", () => {
  const testWallet: Address = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";
  const dummyQuoteSignerPk =
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
  const expectedSignerAddress = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

  it("GET returns service status and configuration", async () => {
    const req = new NextRequest("http://localhost:3000/api/personhood");
    const res = await GET(req);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.status).toBe("online");
    expect(data.service).toContain("Personhood");
    expect(typeof data.appIdConfigured).toBe("boolean");
    expect(typeof data.quoteSignerConfigured).toBe("boolean");
  });

  it("POST rejects invalid or missing wallet", async () => {
    const req = new NextRequest("http://localhost:3000/api/personhood", {
      method: "POST",
      body: JSON.stringify({ wallet: "not-an-address", action: "purchase" }),
    });

    const res = await POST(req);
    const data = await res.json();

    expect(res.status).toBe(400);
    expect(data.error).toContain("wallet");
  });

  it("POST issues signed PersonhoodCertificate for Purchase action", async () => {
    const origPk = process.env.QUOTE_SIGNER_PRIVATE_KEY;
    process.env.QUOTE_SIGNER_PRIVATE_KEY = dummyQuoteSignerPk;

    try {
      const chainId = 11155111;
      const req = new NextRequest("http://localhost:3000/api/personhood", {
        method: "POST",
        body: JSON.stringify({
          wallet: testWallet,
          action: "purchase",
          chainId,
        }),
      });

      const res = await POST(req);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.certificate.wallet.toLowerCase()).toBe(testWallet.toLowerCase());
      expect(data.certificate.action).toBe(PersonhoodAction.Purchase);
      expect(data.signature).toBeDefined();
      expect(data.signature.startsWith("0x")).toBe(true);
      expect(data.signature.length).toBe(132); // 65 bytes in hex
      expect(data.signer?.toLowerCase()).toBe(expectedSignerAddress.toLowerCase());

      // Verify the EIP-712 typed data signature
      const cert: PersonhoodCertificate = {
        wallet: data.certificate.wallet,
        action: data.certificate.action,
        expiresAt: BigInt(data.certificate.expiresAt),
        nonce: BigInt(data.certificate.nonce),
      };

      const recoveredSigner = await recoverTypedDataAddress({
        domain: marketDomain(
          chainId,
          (process.env.NEXT_PUBLIC_MARKETPLACE_ADDRESS as Address) ||
            "0x0000000000000000000000000000000000000000"
        ),
        types: PERSONHOOD_CERTIFICATE_TYPES,
        primaryType: "PersonhoodCertificate",
        message: cert,
        signature: data.signature as Hex,
      });

      expect(recoveredSigner.toLowerCase()).toBe(expectedSignerAddress.toLowerCase());
    } finally {
      process.env.QUOTE_SIGNER_PRIVATE_KEY = origPk;
    }
  });

  it("POST issues signed PersonhoodCertificate for Publish action", async () => {
    const origPk = process.env.QUOTE_SIGNER_PRIVATE_KEY;
    process.env.QUOTE_SIGNER_PRIVATE_KEY = dummyQuoteSignerPk;

    try {
      const chainId = 31337;
      const req = new NextRequest("http://localhost:3000/api/personhood", {
        method: "POST",
        body: JSON.stringify({
          wallet: testWallet,
          action: "publish",
          chainId,
        }),
      });

      const res = await POST(req);
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.certificate.action).toBe(PersonhoodAction.Publish);
      expect(data.signer?.toLowerCase()).toBe(expectedSignerAddress.toLowerCase());
    } finally {
      process.env.QUOTE_SIGNER_PRIVATE_KEY = origPk;
    }
  });
});
