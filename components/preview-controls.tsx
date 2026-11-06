"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  useAccount,
  useChainId,
  useReadContract,
  useWriteContract,
  useWaitForTransactionReceipt,
  useSwitchChain,
} from "wagmi";
import {
  formatEther,
  parseEther,
  zeroAddress,
  keccak256,
  toHex,
  type Hex,
} from "viem";
import { sepolia, hardhat } from "wagmi/chains";

import type { Project, User } from "@/lib/types";
import type { PersonhoodCertificate } from "@/lib/eip712";
import {
  consentCraftMarketAbi,
  getMarketplaceAddress,
  truncateAddress,
  PublicationStateLabels,
  ListingStateLabels,
  SettlementReasonLabels,
} from "@/lib/contracts";
import { Icon } from "./icons";
import { WorldIDVerifier } from "./world-id-modal";

type PreviewAction = (
  body: Record<string, unknown>,
  message?: string
) => Promise<{ id?: string; token?: string }>;

function getPublicationId(project: Project): bigint | undefined {
  if (project.publicationId && /^\d+$/.test(project.publicationId)) {
    return BigInt(project.publicationId);
  }
  if (project.review?.tokenId && /^\d+$/.test(project.review.tokenId)) {
    return BigInt(project.review.tokenId);
  }
  if (/^\d+$/.test(project.id)) {
    return BigInt(project.id);
  }
  return undefined;
}

export function OnchainReview({
  project,
  dirty,
}: {
  project: Project;
  user: User;
  dirty: boolean;
  execute: PreviewAction;
  refresh: () => Promise<void>;
}) {
  const { address } = useAccount();
  const chainId = useChainId();
  const marketAddress = getMarketplaceAddress();
  const pubId = getPublicationId(project);

  const [evidenceText, setEvidenceText] = useState("");
  const [actionError, setActionError] = useState("");
  const [publishCert, setPublishCert] = useState<{
    certificate: PersonhoodCertificate;
    signature: Hex;
  } | null>(null);

  const { data: publication, refetch: refetchPublication } = useReadContract({
    address: marketAddress,
    abi: consentCraftMarketAbi,
    functionName: "getPublication",
    args: pubId ? [pubId] : undefined,
    query: { enabled: !!marketAddress && !!pubId },
  });

  const { data: policy } = useReadContract({
    address: marketAddress,
    abi: consentCraftMarketAbi,
    functionName: "getPolicy",
    args: publication ? [publication.policyId] : [BigInt(1)],
    query: { enabled: !!marketAddress },
  });

  const {
    data: txHash,
    isPending: isSubmitting,
    writeContract,
    error: writeError,
  } = useWriteContract();

  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({
      hash: txHash,
    });

  useEffect(() => {
    if (isConfirmed) {
      void refetchPublication();
    }
  }, [isConfirmed, refetchPublication]);

  // Actions
  const handlePublish = () => {
    if (!marketAddress || !pubId) return;
    setActionError("");
    try {
      writeContract({
        address: marketAddress,
        abi: consentCraftMarketAbi,
        functionName: "publish",
        args: [pubId],
      });
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const handleAppeal = () => {
    if (!marketAddress || !pubId || !evidenceText.trim()) return;
    setActionError("");
    try {
      const evidenceHash = keccak256(toHex(evidenceText.trim()));
      writeContract({
        address: marketAddress,
        abi: consentCraftMarketAbi,
        functionName: "appeal",
        args: [pubId, evidenceHash],
      });
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const handleRefundAndDelist = () => {
    if (!marketAddress || !pubId) return;
    setActionError("");
    try {
      writeContract({
        address: marketAddress,
        abi: consentCraftMarketAbi,
        functionName: "refundAndDelist",
        args: [pubId, BigInt(0)],
      });
    } catch (err) {
      setActionError((err as Error).message);
    }
  };

  const priceFormatted = project.priceWei
    ? formatEther(BigInt(project.priceWei))
    : "0.001";
  const depositWei = parseEther("0.005");
  const aiCapWei = parseEther("0.001");
  const minDeductionWei = parseEther("0.00125"); // 25%

  const feePercentage = policy ? (policy.feeBps / 100).toFixed(1) : "5.0";

  return (
    <section className="surface review-surface">
      <span className="eyebrow">EVERY VOICE HAS A PLACE</span>
      <h2>
        {project.state === "draft"
          ? "A little care before the next chapter."
          : "Give this story a little love."}
      </h2>
      <p className="muted">
        Review the artwork, credits, deposit quote, and on-chain publishing
        status.
      </p>

      {/* Contract & Network Indicator */}
      <div className="chain-connect">
        <Icon name="shield" size={22} />
        <div>
          <p>
            <strong>Marketplace Contract: </strong>
            {marketAddress ? (
              <code>{truncateAddress(marketAddress)}</code>
            ) : (
              <span className="form-error">
                Not set. Set <code>NEXT_PUBLIC_MARKETPLACE_ADDRESS</code> in{" "}
                <code>.env.local</code>.
              </span>
            )}
            {" · "}
            <strong>Chain: </strong>
            {chainId === 11155111
              ? "Sepolia Testnet"
              : chainId === 31337
              ? "Local Hardhat"
              : `Chain ${chainId}`}
          </p>
        </div>
      </div>

      {/* Publication Status if on-chain */}
      {pubId && publication && (
        <div className="chain-progress">
          <h4>On-Chain Publication #{pubId.toString()}</h4>
          <p>
            <strong>State:</strong>{" "}
            {PublicationStateLabels[publication.state as keyof typeof PublicationStateLabels] ??
              "Unknown"}{" "}
            {" · "}
            <strong>Listing:</strong>{" "}
            {ListingStateLabels[publication.listingState as keyof typeof ListingStateLabels] ??
              "Unknown"}
          </p>
          <p>
            <strong>Gross Sales ($R$):</strong>{" "}
            {formatEther(publication.grossSales)} ETH {" · "}
            <strong>Recognized AI Fee ($A$):</strong>{" "}
            {formatEther(publication.aiCost)} ETH
          </p>
          {publication.settlementReason !== 0 && (
            <p>
              <strong>Settlement:</strong>{" "}
              {SettlementReasonLabels[
                publication.settlementReason as keyof typeof SettlementReasonLabels
              ] ?? "Settled"}
            </p>
          )}

          {/* Action: Approved -> Publish */}
          {publication.state === 1 && publication.listingState === 0 && (
            <div className="chain-button-row" style={{ marginTop: "12px" }}>
              <button
                className="button yellow"
                disabled={isSubmitting || isConfirming}
                onClick={handlePublish}
              >
                {isSubmitting
                  ? "Signing publish..."
                  : isConfirming
                  ? "Confirming on chain..."
                  : "Publish to Marketplace"}
                <Icon name="arrow" size={17} />
              </button>
            </div>
          )}

          {/* Action: Flagged -> Appeal */}
          {publication.state === 2 && (
            <div style={{ marginTop: "12px" }}>
              <p className="form-error">
                This publication was flagged during AI screening. You have a
                72-hour appeal window.
              </p>
              <label>
                Reason & Evidence for Appeal
                <textarea
                  rows={2}
                  placeholder="Explain why this content satisfies the publishing guidelines..."
                  value={evidenceText}
                  onChange={(e) => setEvidenceText(e.target.value)}
                />
              </label>
              <div className="chain-button-row">
                <button
                  className="button purple"
                  disabled={
                    !evidenceText.trim() || isSubmitting || isConfirming
                  }
                  onClick={handleAppeal}
                >
                  Submit 72-Hour Appeal
                </button>
              </div>
            </div>
          )}

          {/* Action: Published (Listed) -> Refund & Delist */}
          {publication.state === 4 && publication.listingState === 1 && (
            <div style={{ marginTop: "12px" }}>
              <p className="muted">
                Published on chain. Buyers can purchase entitlements.
              </p>
              <div className="chain-button-row">
                <button
                  className="text-button"
                  disabled={isSubmitting || isConfirming}
                  onClick={handleRefundAndDelist}
                >
                  Refund & Delist Comic
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Checklist */}
      <div className="review-checklist">
        <p>
          <Icon name="image" size={17} />{" "}
          {project.panels.filter((panel) => panel.image).length} of 4 panels
          have artwork
        </p>
        <p>
          <Icon name="users" size={17} /> {project.members.length} creators in
          the credits (
          {project.members.reduce((acc, m) => acc + m.share, 0) / 100}% share)
        </p>
        <p>
          <Icon name="book" size={17} />{" "}
          {project.terms ? "Use terms specified" : "Use terms missing"}
        </p>
        <p>
          <Icon name="spark" size={17} /> Price:{" "}
          <strong>{priceFormatted} ETH</strong>
        </p>
        <p>
          <Icon name="shield" size={17} /> Creator Personhood:{" "}
          {publishCert ? (
            <strong style={{ color: "#2d6a4f" }}>
              World ID Verified Human Author
            </strong>
          ) : (
            <span>Unverified</span>
          )}
        </p>
      </div>

      {/* Creator World ID Personhood Verification */}
      <div
        className="surface"
        style={{
          marginTop: "16px",
          padding: "16px",
          background: "rgba(255, 255, 255, 0.6)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            marginBottom: "4px",
          }}
        >
          <Icon name="shield" size={18} />
          <h3 style={{ margin: 0, fontSize: "15px" }}>
            World ID Creator Personhood
          </h3>
        </div>
        <p className="field-hint" style={{ margin: "4px 0 10px" }}>
          Verify your human identity with World ID. Generates an authorized
          EIP-712 Personhood Certificate bound to your wallet to prevent Sybil
          bot submissions.
        </p>
        <WorldIDVerifier
          action="publish"
          wallet={address}
          chainId={chainId}
          buttonLabel="Verify Human Author (World ID)"
          onVerified={(certificate, signature) => {
            setPublishCert({ certificate, signature });
          }}
        />
      </div>

      {dirty && (
        <p className="field-hint">
          Save your draft changes to update this preview.
        </p>
      )}

      {/* Deposit Economics Disclosure */}
      <div className="transaction-quote">
        <strong>Publishing Deposit & Settlement Terms</strong>
        <p>
          • Publishing Deposit ($S$): ~{formatEther(depositWei)} ETH (exceeds AI
          cap of {formatEther(aiCapWei)} ETH).
          <br />
          • Minimum 25% deduction ($Q = \lceil S/4 \rceil$): ~
          {formatEther(minDeductionWei)} ETH (Protocol fee: {feePercentage}%).
          <br />
          • Threshold Settlement: When cumulative sales $R \ge S$, remainder
          settles to the platform while sales stay active.
          <br />• 30-Day Refund: Available after 30 days if $R &lt; S$ upon
          author delisting.
        </p>
      </div>

      <div className="terms-box">
        <h3>A note from the creators</h3>
        <p>{project.terms || "Add your use terms in Team & shares."}</p>
      </div>

      {/* Feedback & Notifications */}
      {(actionError || writeError) && (
        <p className="form-error" role="alert">
          {actionError || (writeError as Error)?.message}
        </p>
      )}

      {isConfirmed && txHash && (
        <div className="chain-success" role="status">
          Transaction confirmed! Hash: <code>{truncateAddress(txHash)}</code>
        </div>
      )}
    </section>
  );
}

export function CollectibleActions({
  project,
  refresh,
}: {
  project: Project;
  user: User | null;
  refresh: () => Promise<void>;
}) {
  const { address } = useAccount();
  const chainId = useChainId();
  const marketAddress = getMarketplaceAddress();
  const pubId = getPublicationId(project);

  const [purchaseError, setPurchaseError] = useState("");
  const [purchaseCert, setPurchaseCert] = useState<{
    certificate: PersonhoodCertificate;
    signature: Hex;
  } | null>(null);

  // Check if buyer already owns reading access on-chain
  const { data: hasAccess, refetch: refetchAccess } = useReadContract({
    address: marketAddress,
    abi: consentCraftMarketAbi,
    functionName: "hasReadingAccess",
    args: pubId && address ? [pubId, address] : undefined,
    query: { enabled: !!marketAddress && !!pubId && !!address },
  });

  // Query on-chain publication price
  const { data: publication } = useReadContract({
    address: marketAddress,
    abi: consentCraftMarketAbi,
    functionName: "getPublication",
    args: pubId ? [pubId] : undefined,
    query: { enabled: !!marketAddress && !!pubId },
  });

  // Query policy to inspect personhood requirements
  const { data: policy } = useReadContract({
    address: marketAddress,
    abi: consentCraftMarketAbi,
    functionName: "getPolicy",
    args: publication ? [publication.policyId] : [BigInt(1)],
    query: { enabled: !!marketAddress },
  });

  const requiresPersonhood = policy?.purchaseRequiresPersonhood ?? false;

  const priceWei = publication
    ? publication.price
    : project.priceWei
    ? BigInt(project.priceWei)
    : parseEther("0.001");

  const priceEth = formatEther(priceWei);

  // Wagmi contract write
  const {
    data: txHash,
    isPending: isWriting,
    writeContract,
    error: writeError,
  } = useWriteContract();

  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({
      hash: txHash,
    });

  useEffect(() => {
    if (isConfirmed) {
      void refetchAccess();
      void refresh();
    }
  }, [isConfirmed, refetchAccess, refresh]);

  const handlePurchase = () => {
    if (!marketAddress || !pubId) return;
    setPurchaseError("");

    if (requiresPersonhood && !purchaseCert) {
      setPurchaseError(
        "Please complete World ID verification before purchasing."
      );
      return;
    }

    try {
      // Generate a unique 32-byte requestId to satisfy the contract uniqueness check
      const requestId = keccak256(
        toHex(`req-${address}-${pubId}-${Date.now()}-${Math.random()}`)
      );
      const emptyCert: PersonhoodCertificate = {
        wallet: address ?? zeroAddress,
        action: 1, // Purchase action
        expiresAt: BigInt(0),
        nonce: BigInt(0),
      };

      const certToUse = purchaseCert ? purchaseCert.certificate : emptyCert;
      const sigToUse = purchaseCert ? purchaseCert.signature : ("0x" as Hex);

      writeContract({
        address: marketAddress,
        abi: consentCraftMarketAbi,
        functionName: "purchase",
        args: [pubId, requestId, certToUse, sigToUse],
        value: priceWei,
      });
    } catch (err) {
      setPurchaseError((err as Error).message);
    }
  };

  return (
    <section className="surface collectible-sale">
      <div>
        <span className="eyebrow">A STORY WORTH KEEPING</span>
        <h2>A place on your bookshelf.</h2>
        <p className="muted">
          {project.sample
            ? "You’re reading sample artwork from the UI reference."
            : "Enjoy this story and the people behind it. Permanent reading entitlement."}
        </p>

        {hasAccess ? (
          <div className="chain-success">
            <Icon name="check" size={20} />
            <strong>
              {" "}
              Reading Entitlement Verified! You own perpetual access to this
              edition.
            </strong>
            <p>Access is preserved even if the author delists this comic.</p>
          </div>
        ) : (
          <div className="chain-proof" style={{ marginTop: "16px" }}>
            <summary>
              <strong>Transparent Fee Split</strong>
            </summary>
            <p>
              • Copy Price: <strong>{priceEth} ETH</strong>
              <br />
              • Platform Fee: 5% (credited to marketplace treasury)
              <br />• Creator Share: 95% (credited directly to author)
            </p>
          </div>
        )}
      </div>

      <div>
        <div className="chain-price">
          <span>READING ENTITLEMENT</span>
          <strong>
            {priceEth} <small>ETH</small>
          </strong>
        </div>

        {hasAccess ? (
          <button className="button purple full" disabled>
            <Icon name="check" size={18} />
            Already in your library
          </button>
        ) : !marketAddress ? (
          <div>
            <button className="button yellow full" disabled>
              Purchase comic
            </button>
            <p className="field-hint">
              Configure <code>NEXT_PUBLIC_MARKETPLACE_ADDRESS</code> in{" "}
              <code>.env.local</code>.
            </p>
          </div>
        ) : !pubId ? (
          <div>
            <button className="button yellow full" disabled>
              Purchase comic
            </button>
            <p className="field-hint">
              This draft has not been published to the on-chain marketplace yet.
            </p>
          </div>
        ) : !address ? (
          <div>
            <button className="button yellow full" disabled>
              Connect wallet to purchase
            </button>
          </div>
        ) : (
          <div>
            {/* World ID Personhood Attestation */}
            {!hasAccess && address && (
              <div
                style={{
                  marginBottom: "16px",
                  padding: "12px",
                  background: "rgba(255, 255, 255, 0.6)",
                  borderRadius: "8px",
                  border: "1px solid #e1e4e8",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "6px",
                    marginBottom: "4px",
                  }}
                >
                  <Icon name="shield" size={16} />
                  <strong style={{ fontSize: "13px" }}>
                    World ID Sybil Protection
                  </strong>
                  {requiresPersonhood && (
                    <span
                      className="badge yellow"
                      style={{ fontSize: "10px", padding: "1px 6px" }}
                    >
                      Required
                    </span>
                  )}
                </div>
                <WorldIDVerifier
                  action="purchase"
                  wallet={address}
                  chainId={chainId}
                  buttonLabel="Verify Human (World ID)"
                  onVerified={(certificate, signature) => {
                    setPurchaseCert({ certificate, signature });
                  }}
                />
              </div>
            )}

            <button
              className="button yellow full"
              disabled={
                isWriting ||
                isConfirming ||
                (requiresPersonhood && !purchaseCert)
              }
              onClick={handlePurchase}
            >
              <Icon name="book" size={18} />
              {isWriting
                ? "Confirm in wallet..."
                : isConfirming
                ? "Minting entitlement..."
                : requiresPersonhood && !purchaseCert
                ? "Verify World ID to purchase"
                : `Purchase for ${priceEth} ETH`}
            </button>

            {isConfirmed && (
              <div className="chain-success" style={{ marginTop: "12px" }}>
                Purchase confirmed! Reading access unlocked.
              </div>
            )}

            {(purchaseError || writeError) && (
              <p
                className="form-error"
                role="alert"
                style={{ marginTop: "12px" }}
              >
                {purchaseError || (writeError as Error)?.message}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

export function EarningsPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const marketAddress = getMarketplaceAddress();

  const [withdrawError, setWithdrawError] = useState("");

  // Read caller's withdrawable credit
  const {
    data: credit,
    isLoading: isReadingCredit,
    refetch: refetchCredit,
  } = useReadContract({
    address: marketAddress,
    abi: consentCraftMarketAbi,
    functionName: "creditOf",
    args: address ? [address] : undefined,
    query: { enabled: !!marketAddress && !!address },
  });

  // Write contract hook
  const {
    data: txHash,
    isPending: isWriting,
    writeContract,
    error: writeError,
  } = useWriteContract();

  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({
      hash: txHash,
    });

  useEffect(() => {
    if (isConfirmed) {
      void refetchCredit();
    }
  }, [isConfirmed, refetchCredit]);

  const availableEth = credit ? formatEther(credit) : "0.0";
  const hasBalance = credit !== undefined && credit > BigInt(0);

  const handleWithdraw = () => {
    if (!marketAddress || !hasBalance) return;
    setWithdrawError("");
    try {
      writeContract({
        address: marketAddress,
        abi: consentCraftMarketAbi,
        functionName: "withdraw",
      });
    } catch (err) {
      setWithdrawError((err as Error).message);
    }
  };

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">YOUR SHARE, IN YOUR CONTROL</span>
          <h1>Earnings from your stories.</h1>
          <p>
            A home for the rewards of your creative work. Pull payments direct
            from the contract.
          </p>
        </div>
      </div>

      <section className="surface earnings-card">
        <div className="chain-connect">
          <Icon name="shield" size={22} />
          <div>
            <p>
              <strong>Marketplace Contract: </strong>
              {marketAddress ? (
                <code>{truncateAddress(marketAddress)}</code>
              ) : (
                <span className="form-error">
                  Not configured. Set <code>NEXT_PUBLIC_MARKETPLACE_ADDRESS</code>{" "}
                  in <code>.env.local</code>.
                </span>
              )}
              {" · "}
              <strong>Network: </strong>
              {chainId === 11155111
                ? "Sepolia Testnet"
                : chainId === 31337
                ? "Hardhat Local"
                : `Chain ${chainId}`}
            </p>
          </div>
        </div>

        <div className="earnings-balance">
          <span>Available to withdraw</span>
          <strong>
            {isReadingCredit ? "Loading..." : availableEth} <small>ETH</small>
          </strong>
        </div>

        <p className="muted">
          All sale proceeds, deposit refunds, and reviewer allocations are
          credited on-chain and withdrawn directly to your wallet.
        </p>

        <label>
          Recipient wallet (only your connected address can withdraw its credits)
          <input
            placeholder="0x wallet address"
            value={address ?? "Wallet not connected"}
            disabled
          />
        </label>

        <div className="chain-button-row">
          <button
            className="button yellow"
            disabled={!hasBalance || isWriting || isConfirming || !isConnected}
            onClick={handleWithdraw}
          >
            <Icon name="arrow" size={17} />
            {isWriting
              ? "Signing withdrawal..."
              : isConfirming
              ? "Confirming in block..."
              : "Withdraw proceeds"}
          </button>
        </div>

        {isConfirmed && txHash && (
          <div className="chain-success" style={{ marginTop: "16px" }}>
            <Icon name="check" size={18} />
            Withdrawal successful! Transferred {availableEth} ETH to your
            wallet.
            <br />
            <code>Tx: {truncateAddress(txHash)}</code>
          </div>
        )}

        {(withdrawError || writeError) && (
          <p className="form-error" role="alert" style={{ marginTop: "16px" }}>
            {withdrawError || (writeError as Error)?.message}
          </p>
        )}

        <p className="field-hint">
          ConsentCraft uses pull-payment settlement to ensure funds cannot be
          reentrantly drained or held in custody.
        </p>
      </section>
    </>
  );
}

export function NetworkPage() {
  const { address, isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const marketAddress = getMarketplaceAddress();

  // Read global metrics
  const { data: publicationCount } = useReadContract({
    address: marketAddress,
    abi: consentCraftMarketAbi,
    functionName: "publicationCount",
    query: { enabled: !!marketAddress },
  });

  const { data: policyCount } = useReadContract({
    address: marketAddress,
    abi: consentCraftMarketAbi,
    functionName: "policyCount",
    query: { enabled: !!marketAddress },
  });

  const { data: totalCredits } = useReadContract({
    address: marketAddress,
    abi: consentCraftMarketAbi,
    functionName: "totalCredits",
    query: { enabled: !!marketAddress },
  });

  const { data: totalLockedDeposits } = useReadContract({
    address: marketAddress,
    abi: consentCraftMarketAbi,
    functionName: "totalLockedDeposits",
    query: { enabled: !!marketAddress },
  });

  const { data: totalLiabilities } = useReadContract({
    address: marketAddress,
    abi: consentCraftMarketAbi,
    functionName: "totalLiabilities",
    query: { enabled: !!marketAddress },
  });

  const { data: liabilitiesCovered } = useReadContract({
    address: marketAddress,
    abi: consentCraftMarketAbi,
    functionName: "liabilitiesCovered",
    query: { enabled: !!marketAddress },
  });

  const { data: ownerRecipient } = useReadContract({
    address: marketAddress,
    abi: consentCraftMarketAbi,
    functionName: "ownerRecipient",
    query: { enabled: !!marketAddress },
  });

  const { data: aiExpenseRecipient } = useReadContract({
    address: marketAddress,
    abi: consentCraftMarketAbi,
    functionName: "aiExpenseRecipient",
    query: { enabled: !!marketAddress },
  });

  const { data: paused } = useReadContract({
    address: marketAddress,
    abi: consentCraftMarketAbi,
    functionName: "paused",
    query: { enabled: !!marketAddress },
  });

  return (
    <>
      <div className="page-heading">
        <div>
          <span className="eyebrow">THE WEB3 CONNECTION</span>
          <h1>Ethereum, connected to your craft.</h1>
          <p>
            Live network state, contract solvency metrics, and chain
            configuration.
          </p>
        </div>
      </div>

      <section className="surface network-card">
        <h2>Connection Overview</h2>
        <p className="muted">
          {isConnected
            ? `Connected as ${truncateAddress(address)}`
            : "Connect your wallet via RainbowKit in the header."}
        </p>

        <div className="chain-connect">
          <p>
            <strong>Active Chain: </strong>
            {chainId === 11155111
              ? "Sepolia Testnet (Chain ID 11155111)"
              : chainId === 31337
              ? "Hardhat Local (Chain ID 31337)"
              : `Chain ID ${chainId}`}
            <br />
            <strong>Marketplace Status: </strong>
            {marketAddress ? (
              <span className="badge published">
                {paused ? "Paused" : "Online & Active"}
              </span>
            ) : (
              <span className="badge draft">Not Configured</span>
            )}
          </p>
        </div>

        <h3>ConsentCraftMarket Contract</h3>
        {marketAddress ? (
          <div>
            <code className="chain-hash">{marketAddress}</code>
            <div className="chain-links">
              {chainId === 11155111 && (
                <a
                  href={`https://sepolia.etherscan.io/address/${marketAddress}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View on Etherscan <Icon name="arrow" size={14} />
                </a>
              )}
            </div>
          </div>
        ) : (
          <code className="chain-hash">
            No marketplace address configured. Add{" "}
            <code>NEXT_PUBLIC_MARKETPLACE_ADDRESS</code> in{" "}
            <code>.env.local</code>.
          </code>
        )}

        {/* Solvency Invariants Card */}
        {marketAddress && (
          <div style={{ marginTop: "24px" }}>
            <h3>Protocol Solvency & Health</h3>
            <p className="muted">
              Contract balance coverage of total locked deposits ($S - A$) and
              unclaimed credits ($totalCredits$).
            </p>

            <div className="stat-strip" style={{ marginTop: "12px" }}>
              <div>
                <span className="stat-icon green">
                  <Icon name="shield" />
                </span>
                <div>
                  <strong>
                    {liabilitiesCovered ? "100% Covered" : "Deficit"}
                  </strong>
                  <span>Solvency Status</span>
                </div>
              </div>
              <div>
                <span className="stat-icon lilac">
                  <Icon name="book" />
                </span>
                <div>
                  <strong>
                    {totalLockedDeposits
                      ? formatEther(totalLockedDeposits)
                      : "0"}{" "}
                    ETH
                  </strong>
                  <span>Locked Deposits ($S - A$)</span>
                </div>
              </div>
              <div>
                <span className="stat-icon yellow-bg">
                  <Icon name="spark" />
                </span>
                <div>
                  <strong>
                    {totalCredits ? formatEther(totalCredits) : "0"} ETH
                  </strong>
                  <span>Unwithdrawn Credits</span>
                </div>
              </div>
              <div>
                <span className="stat-icon peach">
                  <Icon name="grid" />
                </span>
                <div>
                  <strong>
                    {publicationCount ? publicationCount.toString() : "0"}
                  </strong>
                  <span>Total Publications</span>
                </div>
              </div>
            </div>

            <div className="chain-proof" style={{ marginTop: "16px" }}>
              <summary>
                <strong>Contract Roles & Configuration</strong>
              </summary>
              <p>
                • Append-Only Policy Count:{" "}
                <strong>{policyCount ? policyCount.toString() : "0"}</strong>
                <br />
                • Total Liabilities ($S - A + credits$):{" "}
                <strong>
                  {totalLiabilities ? formatEther(totalLiabilities) : "0"} ETH
                </strong>
                <br />
                • Owner Platform Fee Recipient:{" "}
                <code>{truncateAddress(ownerRecipient)}</code>
                <br />• AI Cost Reimbursement Recipient:{" "}
                <code>{truncateAddress(aiExpenseRecipient)}</code>
              </p>
            </div>
          </div>
        )}

        {/* Switch Chain Action if needed */}
        {chainId !== 11155111 && chainId !== 31337 && (
          <div style={{ marginTop: "20px" }}>
            <p className="form-error">
              You are connected to an unsupported chain.
            </p>
            <div className="chain-button-row">
              <button
                className="button yellow"
                onClick={() => switchChain({ chainId: sepolia.id })}
              >
                Switch to Sepolia
              </button>
              <button
                className="button ink"
                onClick={() => switchChain({ chainId: hardhat.id })}
              >
                Switch to Local
              </button>
            </div>
          </div>
        )}

        <Link className="text-button" href="/help">
          Read the workflow <Icon name="arrow" size={16} />
        </Link>
      </section>
    </>
  );
}

export function ChainHistory({ project }: { project: Project }) {
  const marketAddress = getMarketplaceAddress();
  const pubId = getPublicationId(project);

  const { data: publication } = useReadContract({
    address: marketAddress,
    abi: consentCraftMarketAbi,
    functionName: "getPublication",
    args: pubId ? [pubId] : undefined,
    query: { enabled: !!marketAddress && !!pubId },
  });

  return (
    <div className="chain-history">
      <h3>On-Chain Publication History</h3>
      {pubId && publication ? (
        <div>
          <div>
            <strong>Publication ID:</strong> #{pubId.toString()}
          </div>
          <div>
            <strong>State:</strong>{" "}
            {PublicationStateLabels[
              publication.state as keyof typeof PublicationStateLabels
            ] ?? "Unknown"}
          </div>
          <div>
            <strong>Listing:</strong>{" "}
            {ListingStateLabels[
              publication.listingState as keyof typeof ListingStateLabels
            ] ?? "Unknown"}
          </div>
          <div>
            <strong>Original Deposit ($S$):</strong>{" "}
            {formatEther(publication.deposit)} ETH
          </div>
          <div>
            <strong>Recognized AI Cost ($A$):</strong>{" "}
            {formatEther(publication.aiCost)} ETH
          </div>
          <div>
            <strong>Cumulative Sales ($R$):</strong>{" "}
            {formatEther(publication.grossSales)} ETH
          </div>
          {publication.publishedAt > BigInt(0) && (
            <div>
              <strong>Published:</strong>{" "}
              {new Date(
                Number(publication.publishedAt) * 1000
              ).toLocaleString()}
            </div>
          )}
          {publication.refundEligibleAt > BigInt(0) && (
            <div>
              <strong>Refund Eligible At:</strong>{" "}
              {new Date(
                Number(publication.refundEligibleAt) * 1000
              ).toLocaleString()}
            </div>
          )}
          {publication.settlementReason !== 0 && (
            <div>
              <strong>Settlement:</strong>{" "}
              {SettlementReasonLabels[
                publication.settlementReason as keyof typeof SettlementReasonLabels
              ] ?? "Settled"}
            </div>
          )}
        </div>
      ) : (
        <p className="muted">
          {project.sample
            ? "This sample has no on-chain transactions."
            : "No on-chain publication recorded for this draft yet."}
        </p>
      )}
    </div>
  );
}
