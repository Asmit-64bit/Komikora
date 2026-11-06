import { Suspense } from "react";
import { ConsentApp } from "@/components/consent-app";

export default function StudioPage() {
  return <Suspense fallback={<div className="loading-state"><span className="loading-star">✳</span><h2>Opening the studio…</h2></div>}><ConsentApp /></Suspense>;
}
