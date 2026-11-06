export type PublicationApproval = {
  id: string; userId: string; projectId: string; sessionHash: string; bindingHash: string;
  scopeHash: string; state: string; nonce: string; verifier: string; createdAt: number; expiresAt: number;
  status: "pending" | "exchanging" | "authenticated" | "approved" | "used" | "denied" | "failed" | "cancelled";
  allowEnrollment: boolean; identity?: string; acr: string; authTime?: number; error?: string;
  kind?: "identity" | "publication"; issuer: string;
};
