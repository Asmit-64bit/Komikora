import Link from "next/link";
import type { Project, User } from "@/lib/types";
import { Icon } from "./icons";

type PreviewAction = (body: Record<string, unknown>, message?: string) => Promise<{ id?: string; token?: string }>;

export function OnchainReview({ project, dirty }: {
  project: Project; user: User; dirty: boolean; execute: PreviewAction; refresh: () => Promise<void>;
}) {
  return <section className="surface review-surface">
    <span className="eyebrow">EVERY VOICE HAS A PLACE</span>
    <h2>{project.state === "draft" ? "A little care before the next chapter." : "Give this story a little love."}</h2>
    <p className="muted">Review the artwork, credits, and terms in one place.</p>
    <div className="chain-connect"><Icon name="shield" size={22}/><p>Your draft is saved. Wallet reviews, approvals, and publishing are not connected yet.</p></div>
    <div className="review-checklist">
      <p><Icon name="image" size={17}/> {project.panels.filter(panel => panel.image).length} of 4 panels have artwork</p>
      <p><Icon name="users" size={17}/> {project.members.length} creators in the credits</p>
      <p><Icon name="book" size={17}/> {project.terms ? "Use terms added" : "Use terms still to add"}</p>
    </div>
    {dirty && <p className="field-hint">Save your draft changes to update this preview.</p>}
    <div className="terms-box"><h3>A note from the creators</h3><p>{project.terms || "Add your use terms in Team & shares."}</p></div>
    <button className="button yellow full" disabled>Publish story<Icon name="arrow" size={17}/></button>
    <p className="field-hint">Publishing will be available after the service integration is implemented.</p>
  </section>;
}

export function ChainHistory({ project }: { project: Project }) {
  return <div className="chain-history"><h3>Publication history</h3><p className="muted">{project.sample ? "This sample has no onchain transactions." : "No publication transactions yet."}</p></div>;
}

export function CollectibleActions({ project }: { project: Project; user: User | null; refresh: () => Promise<void> }) {
  return <section className="surface collectible-sale"><div><span className="eyebrow">A STORY WORTH KEEPING</span><h2>A place on your bookshelf.</h2><p className="muted">{project.sample ? "You’re reading sample artwork from the UI reference." : "Enjoy this story and the people behind it."}</p></div><div><button className="button yellow full" disabled>Purchase comic<Icon name="book" size={18}/></button><p className="field-hint">Purchases are not connected in this preview.</p></div></section>;
}

export function EarningsPage() {
  return <><div className="page-heading"><div><span className="eyebrow">YOUR SHARE, IN YOUR CONTROL</span><h1>Earnings from your stories.</h1><p>A home for the rewards of your creative work.</p></div></div>
    <section className="surface earnings-card"><div className="chain-connect"><p>Wallet sign-in is available. Earnings will appear when the marketplace is connected.</p></div><div className="earnings-balance"><span>Available to withdraw</span><strong>— <small>ETH</small></strong></div><p className="muted">Balances and withdrawals will appear here once the marketplace is connected.</p><label>Recipient wallet<input placeholder="0x wallet address" disabled/></label><div className="chain-button-row"><button className="button yellow" disabled>Withdraw proceeds<Icon name="arrow" size={17}/></button></div><p className="field-hint">No balance is being queried or transferred.</p></section></>;
}

export function NetworkPage() {
  return <><div className="page-heading"><div><span className="eyebrow">THE WEB3 CONNECTION</span><h1>Ethereum, connected to your craft.</h1><p>Your studio’s home for network and contract details.</p></div></div><section className="surface network-card"><h2>Not connected</h2><p className="muted">Wallet sign-in is available. Contract transactions are not connected yet.</p><h3>ConsentCraft contract</h3><code className="chain-hash">No contract configured</code><p className="field-hint">Sign in from the studio header. Signing in does not submit a transaction.</p><Link className="text-button" href="/help">Read the workflow<Icon name="arrow" size={16}/></Link></section></>;
}
