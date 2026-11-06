"use client";

import { useEffect, useState } from "react";
import type { Address, Hex } from "viem";
import {
  IDKitRequestWidget,
  orbLegacy,
  type IDKitResult,
  type RpContext,
} from "@worldcoin/idkit";

import { PersonhoodAction, type PersonhoodCertificate } from "@/lib/eip712";
import { Icon } from "./icons";

export interface WorldIDVerifierProps {
  action: "publish" | "purchase" | number;
  wallet?: Address;
  chainId?: number;
  onVerified: (certificate: PersonhoodCertificate, signature: Hex) => void;
  buttonLabel?: string;
  className?: string;
}

export function WorldIDVerifier({
  action,
  wallet,
  chainId,
  onVerified,
  buttonLabel,
  className = "",
}: WorldIDVerifierProps) {
  const [open, setOpen] = useState(false);
  const [isVerifying, setIsVerifying] = useState(false);
  const [isVerified, setIsVerified] = useState(false);
  const [error, setError] = useState("");
  const [certInfo, setCertInfo] = useState<{ expiresAt: string } | null>(null);

  const actionNum =
    action === "publish" || action === 0
      ? PersonhoodAction.Publish
      : PersonhoodAction.Purchase;
  const actionName = actionNum === PersonhoodAction.Publish ? "publish" : "purchase";

  const appId = process.env.NEXT_PUBLIC_WORLD_APP_ID?.trim() as `app_${string}` | undefined;

  const [rpContext, setRpContext] = useState<RpContext | null>(null);

  useEffect(() => {
    if (!appId) return;
    fetch(`/api/personhood?action=${actionName}`)
      .then((r) => r.json())
      .then((d) => {
        if (d.rpContext) {
          setRpContext(d.rpContext);
        } else {
          const now = Math.floor(Date.now() / 1000);
          setRpContext({
            rp_id: `rp_${appId.replace("app_", "")}`,
            nonce:
              "0x003fe5a645befc7e554dde54d8f339093b773e94cb471565c5ce360bc59a22bd",
            created_at: now,
            expires_at: now + 900,
            signature:
              "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
          });
        }
      })
      .catch(() => {
        const now = Math.floor(Date.now() / 1000);
        setRpContext({
          rp_id: `rp_${appId.replace("app_", "")}`,
          nonce:
            "0x003fe5a645befc7e554dde54d8f339093b773e94cb471565c5ce360bc59a22bd",
          created_at: now,
          expires_at: now + 900,
          signature:
            "0x0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        });
      });
  }, [appId, actionName]);

  const requestCertificate = async (proof?: unknown) => {
    if (!wallet) {
      setError("Connect your wallet before verifying personhood.");
      return;
    }
    setError("");
    setIsVerifying(true);

    try {
      const res = await fetch("/api/personhood", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          wallet,
          action: actionNum,
          chainId,
          proof,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.ok) {
        throw new Error(data.error || "Failed to issue Personhood Certificate.");
      }

      const certificate: PersonhoodCertificate = {
        wallet: data.certificate.wallet,
        action: data.certificate.action,
        expiresAt: BigInt(data.certificate.expiresAt),
        nonce: BigInt(data.certificate.nonce),
      };

      const expiresDate = new Date(Number(certificate.expiresAt) * 1000).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });

      setCertInfo({ expiresAt: expiresDate });
      setIsVerified(true);
      onVerified(certificate, data.signature || "0x");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsVerifying(false);
    }
  };

  const handleIdKitSuccess = async (result: IDKitResult) => {
    await requestCertificate(result);
  };

  const handleInstantVerify = async () => {
    await requestCertificate();
  };

  return (
    <div className={`world-id-block ${className}`} style={{ margin: "14px 0" }}>
      {/* Real IDKit widget when app_id is configured */}
      {appId && rpContext && (
        <IDKitRequestWidget
          open={open}
          onOpenChange={setOpen}
          app_id={appId}
          action={actionName}
          allow_legacy_proofs={true}
          rp_context={rpContext}
          preset={orbLegacy({ signal: wallet || "0x0000000000000000000000000000000000000000" })}
          onSuccess={handleIdKitSuccess}
        />
      )}

      {isVerified ? (
        <div className="chain-success" style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <Icon name="check" size={18} />
          <div>
            <strong>World ID Personhood Verified!</strong>
            <span style={{ display: "block", fontSize: "11px", color: "#3d572e" }}>
              Attestation bridge active for {wallet?.slice(0, 6)}…{wallet?.slice(-4)} (Expires ~
              {certInfo?.expiresAt}).
            </span>
          </div>
        </div>
      ) : (
        <div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px", alignItems: "center" }}>
            {appId ? (
              <button
                type="button"
                className="button yellow"
                disabled={!wallet || isVerifying}
                onClick={() => setOpen(true)}
              >
                <Icon name="shield" size={17} />
                {isVerifying ? "Verifying..." : buttonLabel || "Verify with World ID"}
              </button>
            ) : (
              <button
                type="button"
                className="button purple"
                disabled={!wallet || isVerifying}
                onClick={handleInstantVerify}
              >
                <Icon name="shield" size={17} />
                {isVerifying
                  ? "Issuing Certificate..."
                  : buttonLabel || "Verify Human (World ID Bridge)"}
              </button>
            )}
          </div>

          <p className="field-hint" style={{ marginTop: "6px" }}>
            {appId
              ? "Proves unique personhood without revealing your personal identity."
              : "Demo/Testnet Mode: Issues a signed EIP-712 PersonhoodCertificate for your wallet."}
          </p>

          {error && (
            <p className="form-error" role="alert" style={{ marginTop: "6px" }}>
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
