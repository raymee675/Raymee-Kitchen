"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { applySnapshotCommand, parseCommand, type Command, type Snapshot } from "./kitchen-model";
import { LOCAL_BOARD_KEY, readLocalBoard, writeLocalBoard, type ParsedLocalBoardBackup } from "./local-kitchen-storage";

const EDITOR_LOCK = `${LOCAL_BOARD_KEY}:editor`;

type CacheState = "preparing" | "ready" | "unavailable";

export function useKitchenLocal() {
  const lockSupported = typeof navigator !== "undefined" && "locks" in navigator;
  const serviceWorkerSupported = typeof navigator !== "undefined" && "serviceWorker" in navigator;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [now, setNow] = useState(0);
  const [connection, setConnection] = useState<"connecting" | "online" | "offline" | "unauthorized">(lockSupported ? "connecting" : "offline");
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [backupBusy, setBackupBusy] = useState(false);
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(lockSupported ? null : "このブラウザーは複数画面の競合を防ぐ機能に対応していません。対応ブラウザーで開いてください。");
  const [cacheState, setCacheState] = useState<CacheState>(serviceWorkerSupported ? "preparing" : "unavailable");
  const [updateReady, setUpdateReady] = useState(false);
  const state = useRef<Snapshot | null>(null);
  const activeEditor = useRef(false);
  const writeFailed = useRef(false);
  const alive = useRef(false);
  const pending = useRef(new Set<string>());
  const backupRestoreInProgress = useRef(false);
  const recoverySourceRaw = useRef<string|null>(null);
  const mutationQueue = useRef(Promise.resolve());
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const updateRequested = useRef(false);

  const publish = useCallback((value: Snapshot) => {
    state.current = value;
    setSnapshot(value);
    setNow(Date.now());
  }, []);

  const prepareUnreadableBoardRecovery = useCallback((error: unknown) => {
    recoverySourceRaw.current = null;
    setRecoveryAvailable(false);
    if (!activeEditor.current || error instanceof DOMException || !(error instanceof Error)) return false;

    try {
      const storage = window.localStorage;
      const raw = storage.getItem(LOCAL_BOARD_KEY);
      if (raw === null) return false;
      recoverySourceRaw.current = raw;
      setRecoveryAvailable(true);
      return true;
    } catch {
      return false;
    }
  }, []);

  const sync = useCallback(async () => {
    if (!activeEditor.current || writeFailed.current) return;
    try {
      publish(readLocalBoard());
      recoverySourceRaw.current = null;
      setRecoveryAvailable(false);
      setStatusMessage(null);
      if (activeEditor.current) setConnection("online");
    } catch (error) {
      const message = error instanceof Error ? error.message : "保存データを読み取れません。";
      prepareUnreadableBoardRecovery(error);
      setStatusMessage(message);
      setConnection("offline");
      throw error;
    }
  }, [prepareUnreadableBoardRecovery, publish]);

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
          recoverySourceRaw.current = null;
          setRecoveryAvailable(false);
          setStatusMessage(null);
          setConnection("online");
        } catch (error) {
          prepareUnreadableBoardRecovery(error);
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
  }, [lockSupported, prepareUnreadableBoardRecovery, publish, sync]);

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
    if (backupRestoreInProgress.current) throw new Error("バックアップを復元中です。完了してから操作してください。");
    if (!activeEditor.current || !state.current) throw new Error("保存画面の準備ができていません。画面を開き直してください。");
    const command = parseCommand({...input, expectedGeneration:input.expectedGeneration ?? state.current.generation});
    const pendingKey = command.type === "create" || command.type === "undo" || command.type === "reset"
      || command.type === "doughStart" || command.type === "doughReset" || command.type === "doughDiscardAndStart"
      ? command.operationId
      : command.id;
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
        nextCreationOrdinal:applied.nextCreationOrdinal,
        undoHistory: applied.undoHistory,
        doughBatch:applied.doughBatch ?? null,
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
      try { publish(readLocalBoard()); } catch { /* Preserve the last confirmed view if storage cannot be reread. */ }
      toast.error(message);
      throw error;
    }).finally(() => {
      pending.current.delete(pendingKey);
      if (alive.current) setPendingIds(new Set(pending.current));
    });
  }, [publish]);

  const restoreBackup = useCallback((backup: ParsedLocalBoardBackup, expectedRevision: number|null): Promise<Snapshot> => {
    const recoveringUnreadableBoard = expectedRevision === null;
    if (!activeEditor.current || (!state.current && !recoveringUnreadableBoard)) throw new Error("保存画面の準備ができていません。画面を開き直してください。");
    if (recoveringUnreadableBoard && (!recoveryAvailable || recoverySourceRaw.current === null)) throw new Error("この画面では保存データを復旧できません。編集ロックと保存領域を確認して開き直してください。");
    if (backupRestoreInProgress.current || pending.current.size > 0) throw new Error("別の操作が終わってからバックアップを復元してください。");

    backupRestoreInProgress.current = true;
    setBackupBusy(true);
    const pendingKey = "__local-board-backup-restore__";
    pending.current.add(pendingKey);
    setPendingIds(new Set(pending.current));

    const operation = mutationQueue.current.then(() => {
      if (!activeEditor.current) throw new Error("操作を保存できません。アプリを開き直してください。");
      let revisionBase: number;
      let generationBase: number;
      if (recoveringUnreadableBoard) {
        const currentRaw = window.localStorage.getItem(LOCAL_BOARD_KEY);
        if (currentRaw === null || currentRaw !== recoverySourceRaw.current) {
          recoverySourceRaw.current = null;
          setRecoveryAvailable(false);
          throw new Error("保存データが変わっています。画面を開き直して状態を確認してください。");
        }
        revisionBase = Math.max(state.current?.revision ?? 0, backup.snapshot.revision);
        generationBase = Math.max(state.current?.generation ?? 0, backup.snapshot.generation);
        try {
          const rawBoard: unknown = JSON.parse(currentRaw);
          if (rawBoard && typeof rawBoard === "object" && !Array.isArray(rawBoard)) {
            const counters = rawBoard as Record<string, unknown>;
            if (Number.isSafeInteger(counters.revision) && (counters.revision as number) >= 0) revisionBase = Math.max(revisionBase, counters.revision as number);
            if (Number.isSafeInteger(counters.generation) && (counters.generation as number) >= 0) generationBase = Math.max(generationBase, counters.generation as number);
          }
        } catch {
          // A malformed board has no trusted counters; the backup and last in-memory state are the fallback.
        }
      } else {
        const current = readLocalBoard();
        if (current.revision !== expectedRevision) throw new Error("盤面が更新されています。内容を確認してから、もう一度復元してください。");
        revisionBase = current.revision;
        generationBase = current.generation;
      }
      const revision = revisionBase + 1;
      const generation = generationBase + 1;
      if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(generation)) throw new Error("盤面の更新番号が上限に達したため復元できません。");

      const now = Date.now();
      const next: Snapshot = {
        ...backup.snapshot,
        revision,
        generation,
        serverNow:now,
      };
      writeLocalBoard(next);
      writeFailed.current = false;
      recoverySourceRaw.current = null;
      setRecoveryAvailable(false);
      publish(next);
      setStatusMessage(null);
      setConnection("online");
      return next;
    });
    mutationQueue.current = operation.then(() => undefined, () => undefined);

    return operation.catch(error => {
      const message = error instanceof Error ? error.message : "バックアップを復元できませんでした。";
      if (error instanceof DOMException && error.name === "QuotaExceededError") {
        writeFailed.current = true;
        let canRetryUnreadableBoardRecovery = false;
        if (recoveringUnreadableBoard && activeEditor.current && recoverySourceRaw.current !== null) {
          try {
            canRetryUnreadableBoardRecovery = window.localStorage.getItem(LOCAL_BOARD_KEY) === recoverySourceRaw.current;
          } catch {
            canRetryUnreadableBoardRecovery = false;
          }
        }
        if (canRetryUnreadableBoardRecovery) {
          setRecoveryAvailable(true);
          setStatusMessage("端末の保存領域がいっぱいです。現在の保存データは置き換えていません。空き容量を確保するか、小さいバックアップを選んでもう一度お試しください。");
        } else {
          recoverySourceRaw.current = null;
          setRecoveryAvailable(false);
          setStatusMessage("端末の保存領域がいっぱいです。現在の盤面は置き換えていません。空き容量を確保してから開き直してください。");
        }
        setConnection("offline");
      } else if (error instanceof DOMException || error instanceof TypeError) {
        writeFailed.current = true;
        recoverySourceRaw.current = null;
        setRecoveryAvailable(false);
        setStatusMessage("端末へ保存できません。現在の盤面は置き換えていません。ブラウザーのサイトデータ設定を確認してください。");
        setConnection("offline");
      } else if (message.includes("保存データが変わっています")) {
        setStatusMessage(message);
        setConnection("offline");
      } else if (message.includes("保存データ")) {
        writeFailed.current = true;
        prepareUnreadableBoardRecovery(error);
        setStatusMessage(message);
        setConnection("offline");
      }
      toast.error(message);
      throw error;
    }).finally(() => {
      backupRestoreInProgress.current = false;
      pending.current.delete(pendingKey);
      if (alive.current) {
        setBackupBusy(false);
        setPendingIds(new Set(pending.current));
      }
    });
  }, [prepareUnreadableBoardRecovery, publish, recoveryAvailable]);

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
    backupBusy,
    recoveryAvailable,
    send,
    restoreBackup,
    sync,
    currentTime: () => Date.now(),
    getSnapshot: () => state.current,
    statusMessage,
    cacheState,
    updateReady,
    applyUpdate,
  };
}
