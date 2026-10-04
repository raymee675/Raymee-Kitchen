"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { applySnapshotCommand, parseCommand, type Command, type Snapshot } from "./kitchen-model";
import { LOCAL_BOARD_KEY, readLocalBoard, writeLocalBoard } from "./local-kitchen-storage";

const EDITOR_LOCK = `${LOCAL_BOARD_KEY}:editor`;

type CacheState = "preparing" | "ready" | "unavailable";

export function useKitchenLocal() {
  const lockSupported = typeof navigator !== "undefined" && "locks" in navigator;
  const serviceWorkerSupported = typeof navigator !== "undefined" && "serviceWorker" in navigator;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [now, setNow] = useState(0);
  const [connection, setConnection] = useState<"connecting" | "online" | "offline" | "unauthorized">(lockSupported ? "connecting" : "offline");
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [statusMessage, setStatusMessage] = useState<string | null>(lockSupported ? null : "このブラウザーは複数画面の競合を防ぐ機能に対応していません。対応ブラウザーで開いてください。");
  const [cacheState, setCacheState] = useState<CacheState>(serviceWorkerSupported ? "preparing" : "unavailable");
  const [updateReady, setUpdateReady] = useState(false);
  const state = useRef<Snapshot | null>(null);
  const activeEditor = useRef(false);
  const writeFailed = useRef(false);
  const alive = useRef(false);
  const pending = useRef(new Set<string>());
  const mutationQueue = useRef(Promise.resolve());
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const updateRequested = useRef(false);

  const publish = useCallback((value: Snapshot) => {
    state.current = value;
    setSnapshot(value);
    setNow(Date.now());
  }, []);

  const sync = useCallback(async () => {
    if (!activeEditor.current || writeFailed.current) return;
    try {
      publish(readLocalBoard());
      setStatusMessage(null);
      if (activeEditor.current) setConnection("online");
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存データを読み取れません。";
      setStatusMessage(message);
      setConnection("offline");
      throw error;
    }
  }, [publish]);

  useEffect(() => {
    alive.current = true;
    if (!lockSupported) return () => { alive.current = false; };

    let disposed = false;
    let releaseLock: (() => void) | null = null;
    const lockStart = window.setTimeout(() => {
      void navigator.locks.request(EDITOR_LOCK, { mode: "exclusive", ifAvailable: true }, async lock => {
        if (disposed || !alive.current) return;
        if (!lock) {
          setConnection("offline");
          setStatusMessage("別のタブまたはホーム画面でアプリが開いています。そちらを閉じてから開き直してください。");
          return;
        }

        activeEditor.current = true;
        try {
          publish(readLocalBoard());
          setStatusMessage(null);
          setConnection("online");
        } catch (error) {
          setConnection("offline");
          setStatusMessage(error instanceof Error ? error.message : "保存データを読み取れません。");
        }

        await new Promise<void>(resolve => { releaseLock = resolve; });
        activeEditor.current = false;
      }).catch(error => {
        if (disposed || !alive.current) return;
        setConnection("offline");
        setStatusMessage(error instanceof Error ? `この画面を開けません。${error.message}` : "この画面を開けません。");
      });
    }, 0);

    const tick = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 100);
    const refreshOnResume = () => {
      if (!document.hidden) void sync().catch(() => {});
    };
    const refreshOnStorage = (event: StorageEvent) => {
      if (event.key === LOCAL_BOARD_KEY) void sync().catch(() => {});
    };
    document.addEventListener("visibilitychange", refreshOnResume);
    window.addEventListener("pageshow", refreshOnResume);
    window.addEventListener("storage", refreshOnStorage);

    return () => {
      disposed = true;
      alive.current = false;
      activeEditor.current = false;
      window.clearTimeout(lockStart);
      releaseLock?.();
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", refreshOnResume);
      window.removeEventListener("pageshow", refreshOnResume);
      window.removeEventListener("storage", refreshOnStorage);
    };
  }, [lockSupported, publish, sync]);

  useEffect(() => {
    if (!serviceWorkerSupported) return;

    let disposed = false;
    let updateCheck: number | undefined;
    const updateState = (worker: ServiceWorker | null) => {
      if (!worker) return;
      const updateInstalled = () => {
        if (disposed) return;
        if (worker.state === "activated") setCacheState("ready");
        if (worker.state === "installed" && navigator.serviceWorker.controller) setUpdateReady(true);
      };
      worker.addEventListener("statechange", updateInstalled);
      updateInstalled();
    };

    const controllerChanged = () => {
      if (updateRequested.current) window.location.reload();
    };
    navigator.serviceWorker.addEventListener("controllerchange", controllerChanged);

    void navigator.serviceWorker.register(`${__PAGES_BASE__}sw.js`, { scope: __PAGES_BASE__ })
      .then(result => {
        if (disposed) return;
        registration.current = result;
        if (result.active?.state === "activated") setCacheState("ready");
        if (result.waiting) setUpdateReady(true);
        updateState(result.installing);
        updateCheck = window.setInterval(() => { void result.update().catch(() => {}); }, 60 * 60 * 1000);
        result.addEventListener("updatefound", () => updateState(result.installing));
      })
      .catch(() => { if (!disposed) setCacheState("unavailable"); });

    return () => {
      disposed = true;
      window.clearInterval(updateCheck);
      navigator.serviceWorker.removeEventListener("controllerchange", controllerChanged);
    };
  }, [serviceWorkerSupported]);

  const send = useCallback((input: Command): Promise<Snapshot> => {
    if (!activeEditor.current || !state.current) throw new Error("保存画面の準備ができていません。画面を開き直してください。");
    const command = parseCommand({...input, expectedGeneration:input.expectedGeneration ?? state.current.generation});
    const pendingKey = command.type === "create" || command.type === "undo" || command.type === "reset" ? command.operationId : command.id;
    if (pending.current.has(pendingKey)) throw new Error("このお好み焼きは操作中です。");

    pending.current.add(pendingKey);
    setPendingIds(new Set(pending.current));
    const operation = mutationQueue.current.then(() => {
      if (!activeEditor.current) throw new Error("操作を保存できません。アプリを開き直してください。");
      const current = readLocalBoard();
      const now = Date.now();
      const applied = applySnapshotCommand(current, command, now);
      const next: Snapshot = {
        revision: current.revision + 1,
        generation:applied.generation,
        items: applied.items,
        records: applied.records,
        completionItems: applied.completionItems,
        nextPancakeOrdinal: applied.nextPancakeOrdinal,
        undoHistory: applied.undoHistory,
        serverNow: now,
      };
      writeLocalBoard(next);
      publish(next);
      setStatusMessage(null);
      setConnection("online");
      return next;
    });
    mutationQueue.current = operation.then(() => undefined, () => undefined);

    return operation.catch(error => {
      const message = error instanceof Error ? error.message : "操作を保存できませんでした。";
      if (error instanceof DOMException && error.name === "QuotaExceededError") {
        writeFailed.current = true;
        setStatusMessage("端末の保存領域がいっぱいです。空き容量を確保してから開き直してください。");
        setConnection("offline");
      } else if (error instanceof DOMException || error instanceof TypeError) {
        writeFailed.current = true;
        setStatusMessage("端末へ保存できません。ブラウザーのサイトデータ設定を確認してください。");
        setConnection("offline");
      } else if (message.includes("保存データ")) {
        writeFailed.current = true;
        setStatusMessage(message);
        setConnection("offline");
      }
      toast.error(message);
      throw error;
    }).finally(() => {
      pending.current.delete(pendingKey);
      if (alive.current) setPendingIds(new Set(pending.current));
    });
  }, [publish]);

  const applyUpdate = useCallback(() => {
    const waiting = registration.current?.waiting;
    if (!waiting) return;
    updateRequested.current = true;
    waiting.postMessage({ type: "APPLY_UPDATE" });
  }, []);

  return {
    snapshot,
    now,
    connection,
    pendingIds,
    send,
    sync,
    currentTime: () => Date.now(),
    getSnapshot: () => state.current,
    statusMessage,
    cacheState,
    updateReady,
    applyUpdate,
  };
}
