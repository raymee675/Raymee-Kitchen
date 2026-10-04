"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { clockSample, type Command, type Snapshot } from "./kitchen-model";

export function useKitchen() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [now, setNow] = useState(0);
  const [connection, setConnection] = useState<"connecting" | "online" | "offline" | "unauthorized">("connecting");
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const state = useRef<Snapshot | null>(null);
  const clock = useRef({server:0, local:0, rtt:Infinity, sampled:0});
  const lastSuccess = useRef(-Infinity);
  const pending = useRef(new Set<string>());
  const syncing = useRef<Promise<void> | null>(null);
  const alive = useRef(true);
  const currentTime = useCallback(() => clock.current.server ? clock.current.server + performance.now() - clock.current.local : Date.now(), []);
  const accept = useCallback((data: Snapshot, sent:number) => {
    if (!alive.current) return;
    const received = performance.now();
    const sample = clockSample(data.serverNow, data.serverReceivedAt ?? data.serverNow, received - sent);
    const rtt = sample.networkRtt;
    if (rtt <= clock.current.rtt || received - clock.current.sampled > 30000) {
      clock.current = {server:sample.estimatedNow, local:received, rtt, sampled:received};
    }
    if (!state.current || data.revision >= state.current.revision) {
      state.current = data;
      setSnapshot(data);
    }
    lastSuccess.current = received;
    setConnection("online");
    setNow(currentTime());
  }, [currentTime]);
  const sync = useCallback(():Promise<void> => {
    if (syncing.current) return syncing.current;
    const task = async () => {
      if (!navigator.onLine) { if(alive.current) setConnection("offline"); return; }
      const sent = performance.now();
      try {
        const response = await fetch("/api/board", {cache:"no-store", signal:AbortSignal.timeout(4000)});
        if (response.status === 401) { if(alive.current) setConnection("unauthorized"); return; }
        if (!response.ok) throw new Error("sync failed");
        accept(await response.json(), sent);
      } catch { if(alive.current) setConnection("offline"); }
    };
    syncing.current = task().finally(() => { syncing.current = null; });
    return syncing.current;
  }, [accept]);
  useEffect(() => {
    alive.current = true;
    let stopped = false;
    let timeout: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (!document.hidden) await sync();
      if (!stopped) timeout = setTimeout(poll, navigator.onLine ? 700 : 2000);
    };
    void poll();
    const tick = setInterval(() => {
      if (document.hidden) return;
      setNow(currentTime());
      if (performance.now() - lastSuccess.current > 4000) setConnection(c => c === "online" ? "offline" : c);
    }, 100);
    const resume = () => {
      if (!document.hidden) { clock.current.rtt = Infinity; setConnection("connecting"); void sync(); }
    };
    const offline = () => setConnection("offline");
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("online", resume);
    window.addEventListener("offline", offline);
    return () => { alive.current=false; stopped=true; clearTimeout(timeout); clearInterval(tick); document.removeEventListener("visibilitychange",resume); window.removeEventListener("online",resume); window.removeEventListener("offline",offline); };
  }, [currentTime,sync]);
  const send = useCallback(async (command:Command) => {
    if (!navigator.onLine || performance.now() - lastSuccess.current > 4000) throw new Error("接続が戻ってから操作してください。");
    const currentState = state.current;
    if (!currentState) throw new Error("最新の盤面を読み込んでから操作してください。");
    const request = {...command, expectedGeneration:command.expectedGeneration ?? currentState.generation} as Command;
    const pendingKey = request.type === "create" || request.type === "undo" || request.type === "reset" ? request.operationId : request.id;
    if (pending.current.has(pendingKey)) throw new Error("このお好み焼きは操作を送信中です。");
    pending.current.add(pendingKey);
    setPendingIds(new Set(pending.current));
    try {
      for (let attempt=0; attempt<2; attempt++) {
        const sent = performance.now();
        let response:Response;
        try {
          response = await fetch("/api/board", {method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(request), signal:AbortSignal.timeout(4500)});
        } catch {
          if (attempt === 0 && navigator.onLine) continue;
          setConnection("offline");
          throw new Error("送信結果を確認できません。再接続後に最新の状態を表示します。");
        }
        const data = await response.json() as Snapshot & {error?:string};
        if (!response.ok) {
          if (response.status === 401) setConnection("unauthorized");
          else void sync();
          throw new Error(data.error || "操作を保存できませんでした。");
        }
        accept(data,sent);
        return data as Snapshot;
      }
      throw new Error("操作結果を確認できませんでした。");
    } catch(error) { toast.error(error instanceof Error ? error.message : "操作を保存できませんでした。"); throw error; }
    finally { pending.current.delete(pendingKey); if(alive.current) setPendingIds(new Set(pending.current)); }
  }, [accept,sync]);
  return {snapshot, now, connection, pendingIds, send, sync, currentTime, getSnapshot:() => state.current};
}
