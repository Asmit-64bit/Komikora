export const editionPermitTypes = { Permit: [
  { name: "author", type: "address" }, { name: "key", type: "bytes32" },
  { name: "manifestHash", type: "bytes32" }, { name: "metadataHash", type: "bytes32" }, { name: "uriHash", type: "bytes32" },
  { name: "licenseHash", type: "bytes32" }, { name: "auctionHash", type: "bytes32" }, { name: "supply", type: "uint16" }, { name: "deadline", type: "uint64" },
] } as const;
