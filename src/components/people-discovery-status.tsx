"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { NetworkSettings } from "@/lib/domain/network";
import { Mark } from "./brand";

type Status = { accountId: string; settings: NetworkSettings; matching: { pending: boolean; lastCheckedAt: string | null }; opportunities: { id: string; name: string }[] };
export function PeopleDiscoveryStatus({ accountId, revision }: { accountId: string; revision: number }) {
  const [state, setState] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch("/api/network/status", { cache: "no-store", signal, headers: { "X-Sidekick-Account": accountId } });
    const result = await response.json();
    if (signal?.aborted) return;
    if (response.status === 401 || result.accountId && result.accountId !== accountId) { window.location.replace("/login"); return; }
    if (!response.ok) throw new Error(result.message || "Could not check people discovery.");
    setState(result);
  }, [accountId]);
  useEffect(() => {
    const controller = new AbortController();
    const update = () => {
      if (!document.hidden && !lock.current) void refresh(controller.signal).catch(() => {});
    };
    update();
    const interval = setInterval(update, 30000);
    window.addEventListener("focus", update);
    return () => { controller.abort(); clearInterval(interval); window.removeEventListener("focus", update); };
  }, [refresh, revision]);
  async function enable() {
    if (!state || lock.current) return;
    lock.current = true; setBusy(true); setError("");
    try {
      const response = await fetch("/api/network", { method: "POST", headers: { "Content-Type": "application/json", "X-Sidekick-Account": accountId }, body: JSON.stringify({
        action: "settings", settings: {
          revision: state.settings.revision, discoverable: true,
          visibility: { ...state.settings.visibility, profile: "network", goal: "network", trip: "network" },
          area: state.settings.area,
        },
      }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.message || "Could not enable discovery.");
      await refresh();
    } catch (problem) { setError(problem instanceof Error ? problem.message : "Could not enable discovery."); }
    finally { lock.current = false; setBusy(false); }
  }
  if (!state) return null;
  const visible = ["profile", "goal", "trip"].every((field) => state.settings.visibility[field as keyof typeof state.settings.visibility] === "network");
  const enabled = state.settings.discoverable && visible;
  return <article className="message assistant discovery-chat-status" aria-label="People discovery">
    <div className="assistant-avatar"><Mark small /></div>
    <div className="message-content">
      <span className="message-author">Sidekick · People</span>
      {!enabled ? <>
        <p>Would you like me to find people who fit your goals while you’re away?</p>
        <p className="meeting-context">Share your professional profile, goal, and SF dates with discoverable people. Introductions still need your approval.</p>
        <button className="secondary-button" disabled={busy} onClick={() => void enable()}>{busy ? "Enabling…" : "Enable people discovery"}</button>
      </> : state.opportunities.length ? <>
        <p>{state.opportunities.length === 1 ? `${state.opportunities[0].name} could be worth meeting.` : `I found ${state.opportunities.length} people who could be worth meeting.`}</p>
        <a className="secondary-button" href="/network?view=opportunities">Review connections</a>
      </> : <p>{state.matching.pending ? "I’m checking the network for people who fit your goals. This continues when you close the app." : "People discovery is active. I’ll keep checking as new people join or plans change."}</p>}
      <a className="text-button" href="/network?sharing=1">Sharing settings</a>
      {error && <p role="alert" className="notice">{error}</p>}
    </div>
  </article>;
}
