export const teamApprovalTypes = { TeamApproval: [
  { name: "key", type: "bytes32" }, { name: "contentHash", type: "bytes32" },
  { name: "licenseHash", type: "bytes32" }, { name: "contributorsHash", type: "bytes32" },
  { name: "price", type: "uint256" }, { name: "approvalDeadline", type: "uint64" },
] } as const;
export const readingPermitTypes = { Permit: [
  { name: "author", type: "address" }, { name: "key", type: "bytes32" },
  { name: "contentHash", type: "bytes32" }, { name: "manifestHash", type: "bytes32" },
  { name: "metadataHash", type: "bytes32" }, { name: "uriHash", type: "bytes32" },
  { name: "licenseHash", type: "bytes32" }, { name: "contributorsHash", type: "bytes32" },
  { name: "price", type: "uint256" }, { name: "approvalDeadline", type: "uint64" },
  { name: "deadline", type: "uint64" },
] } as const;
