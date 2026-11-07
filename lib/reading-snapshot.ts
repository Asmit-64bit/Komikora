import { encodeAbiParameters, getAddress, keccak256, toHex } from "viem";
import type { Project, ReadingPublication } from "./types";

export function readingContributors(project: Project) {
  return { people: project.members.map(m => getAddress(m.address!)), allocations: project.members.map(m => m.share) };
}
export function readingHashes(project: Project, key: `0x${string}`) {
  const team = readingContributors(project);
  return {
    contentHash: keccak256(toHex(JSON.stringify({ key, title: project.title, description: project.description, genre: project.genre, panels: project.panels, license: project.terms, members: project.members, priceWei: project.priceWei || "0" }))),
    licenseHash: keccak256(toHex(project.terms)),
    contributorsHash: keccak256(encodeAbiParameters([{ type: "address[]" }, { type: "uint16[]" }], [team.people, team.allocations])),
  };
}
export function approvalMessage(reading: ReadingPublication) {
  return { key: reading.key, contentHash: reading.contentHash, licenseHash: reading.licenseHash, contributorsHash: reading.contributorsHash, price: BigInt(reading.priceWei), approvalDeadline: BigInt(reading.approvalDeadline) };
}
export function readingDomain(reading: Pick<ReadingPublication, "chainId" | "contract">) {
  return { name: "ConsentCraftReading", version: "1", chainId: reading.chainId, verifyingContract: reading.contract } as const;
}
