"use client";
// Replaces RainbowKit's account modal so a wallet can carry a memorable, unique @username.
import { useEffect, useRef, useState } from "react";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useDisconnect } from "wagmi";
import type { User } from "@/lib/types";
import { studioRequest, useStudio } from "./studio-provider";
import { Icon } from "./icons";
import { cleanUsername, usernameProblem, USERNAME_MAX, USERNAME_RULES } from "@/lib/username";

const PROMPT_KEY = "consentcraft:username-prompt-dismissed";
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;
const hue = (address: string) => parseInt(address.slice(2, 8), 16) % 360;

function Dialog({ label, close, children }: { label: string; close: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current; dialog?.showModal(); return () => dialog?.close(); }, []);
  return <dialog className="modal account-dialog" aria-label={label} ref={ref} onCancel={e => { e.preventDefault(); close(); }} onClick={e => { if (e.target === ref.current) close(); }}>
    <div className="modal-inner"><button className="icon-button account-close" aria-label="Close dialog" onClick={close}><Icon name="close"/></button>{children}</div>
  </dialog>;
}

function AccountAvatar({ user, address }: { user: User | null; address: string }) {
  const label = user?.username ? Array.from(user.username)[0].toUpperCase() : address.slice(2, 4).toUpperCase();
  return <span className="account-avatar" aria-hidden="true" style={{ background: `hsl(${hue(address)} 55% 62%)` }}>{label}</span>;
}

/** Username field with live availability check. Calls onSaved after a successful save. */
export function UsernameForm({ current, onSaved, submitLabel = "Save username" }: { current?: string; onSaved: () => void; submitLabel?: string }) {
  const { execute } = useStudio();
  const [value, setValue] = useState(current || "");
  const [status, setStatus] = useState<"idle" | "checking" | "available" | "taken">("idle");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const clean = cleanUsername(value);
  const problem = usernameProblem(clean);
  const valid = !problem;
  const unchanged = clean === current;
  useEffect(() => {
    if (!valid || unchanged) return;
    let active = true;
    const timer = setTimeout(() => {
      setStatus("checking");
      studioRequest<{ available: boolean }>({ action: "checkUsername", username: clean })
        .then(result => { if (active) setStatus(result.available ? "available" : "taken"); })
        .catch(() => { if (active) setStatus("idle"); });
    }, 350);
    return () => { active = false; clearTimeout(timer); };
  }, [clean, valid, unchanged]);
  const hint = !clean ? USERNAME_RULES : !valid ? problem : unchanged ? "This is your current username." : status === "checking" ? "Checking…" : status === "available" ? `@${clean} is available.` : status === "taken" ? `@${clean} is already taken.` : " ";
  return <form className="username-form" onSubmit={async e => {
    e.preventDefault(); setError(""); setSaving(true);
    try { await execute({ action: "setUsername", username: clean }); onSaved(); }
    catch (err) { setError((err as Error).message); }
    finally { setSaving(false); }
  }}>
    <label>Username<span className="username-input"><span>@</span><input autoFocus value={value} maxLength={USERNAME_MAX * 2 + 1} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="anything you like" aria-describedby="username-hint" onChange={e => { setValue(e.target.value); setStatus("idle"); setError(""); }}/></span></label>
    <p id="username-hint" className={`field-hint ${status === "taken" ? "is-error" : status === "available" ? "is-ok" : ""}`} aria-live="polite">{hint}</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <button className="button purple" disabled={saving || !valid || unchanged || status === "taken" || status === "checking"}>{saving ? "Saving…" : submitLabel}</button>
  </form>;
}

function AccountDialog({ user, address, close, notify }: { user: User | null; address: string; close: () => void; notify: (message: string) => void }) {
  const { disconnectAsync } = useDisconnect();
  const [editing, setEditing] = useState(false);
  return <Dialog label="Your account" close={close}>
    <div className="account-summary">
      <AccountAvatar user={user} address={address}/>
      {user?.username ? <h2>@{user.username}</h2> : <h2>{short(address)}</h2>}
      {user?.username && <p className="account-address">{short(address)}</p>}
    </div>
    {user && (editing ? <UsernameForm current={user.username} onSaved={() => { setEditing(false); notify("Username saved."); }}/> :
      <button className="account-name-button" onClick={() => setEditing(true)}><Icon name="edit" size={16}/>{user.username ? "Change username" : "Add a username so people can find you"}</button>)}
    <div className="account-actions">
      <button onClick={() => navigator.clipboard.writeText(address).then(() => notify("Address copied.")).catch(() => notify("Could not copy the address."))}><Icon name="link" size={18}/>Copy address</button>
      <button onClick={() => { close(); void disconnectAsync(); }}><Icon name="exit" size={18}/>Disconnect</button>
    </div>
  </Dialog>;
}

function UsernamePrompt({ close, notify }: { close: () => void; notify: (message: string) => void }) {
  return <Dialog label="Choose a username" close={close}>
    <span className="eyebrow">MAKE IT EASY TO FIND YOU</span>
    <h2>Pick a username</h2>
    <p className="modal-description">Collaborators can invite you by @username instead of a long wallet address. Each username belongs to one person.</p>
    <UsernameForm onSaved={() => { close(); notify("Welcome! Your username is set."); }}/>
    <button className="auth-switch" onClick={close}>Maybe later</button>
  </Dialog>;
}

export function AccountButton({ notify }: { notify: (message: string) => void }) {
  const { data } = useStudio();
  const user = data.user;
  const [open, setOpen] = useState(false);
  // Ask once per browser session after sign-in until a username is chosen.
  const [dismissedFor, setDismissedFor] = useState<string | null>(() => { try { return sessionStorage.getItem(PROMPT_KEY); } catch { return null; } });
  const prompt = !!user && !user.username && dismissedFor !== user.id;
  const dismissPrompt = () => { if (!user) return; setDismissedFor(user.id); try { sessionStorage.setItem(PROMPT_KEY, user.id); } catch {} };
  return <ConnectButton.Custom>{({ account, chain, mounted, authenticationStatus, openConnectModal, openChainModal }) => {
    if (!mounted || authenticationStatus === "loading") return <button className="button purple" disabled>Connect wallet</button>;
    if (!account) return <button className="button purple" onClick={openConnectModal}>Connect wallet</button>;
    if (authenticationStatus === "unauthenticated") return <button className="button purple" onClick={openConnectModal}>Sign in</button>;
    if (chain?.unsupported) return <button className="button purple" onClick={openChainModal}>Switch network</button>;
    const signedIn = user && user.address.toLowerCase() === account.address.toLowerCase() ? user : null;
    return <>
      <button className="account-button" onClick={() => setOpen(true)} aria-label="Open account">
        <AccountAvatar user={signedIn} address={account.address}/>
        <span>{signedIn?.username ? `@${signedIn.username}` : short(account.address)}</span>
      </button>
      {open && <AccountDialog user={signedIn} address={account.address} close={() => setOpen(false)} notify={notify}/>}
      {prompt && signedIn && !signedIn.username && !open && <UsernamePrompt close={dismissPrompt} notify={notify}/>}
    </>;
  }}</ConnectButton.Custom>;
}
