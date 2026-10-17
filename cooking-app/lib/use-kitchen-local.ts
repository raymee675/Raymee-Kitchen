"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { showKitchenError } from "./kitchen-notification";
import { applySnapshotCommand, parseCommand, type Command, type Snapshot } from "./kitchen-model";
import { createLocalTimestampClock } from "./local-timestamp-clock";
import { settleForCompletionVariant, type CompletionVariant } from "./completion-variant";
import { LegacyDoughTimerResetRequiredError, localBoardKey, readLocalBoard, resetUnreadableLegacyDoughBoard, writeLocalBoard, type ParsedLocalBoardBackup } from "./local-kitchen-storage";



type CacheState = "preparing" | "ready" | "unavailable";

export function useKitchenLocal(variant:CompletionVariant = "recall") {
  const boardKey = localBoardKey(variant);
  const editorLock = `${boardKey}:editor`;
  const lockSupported = typeof navigator !== "undefined" && "locks" in navigator;
  const serviceWorkerSupported = typeof navigator !== "undefined" && "serviceWorker" in navigator;
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [now, setNow] = useState(0);
  const [connection, setConnection] = useState<"connecting" | "online" | "offline" | "unauthorized">(lockSupported ? "connecting" : "offline");
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [backupBusy, setBackupBusy] = useState(false);
  const [recoveryAvailable, setRecoveryAvailable] = useState(false);
  const [legacyDoughResetRequired, setLegacyDoughResetRequired] = useState(false);
  const [legacyDoughResetAvailable, setLegacyDoughResetAvailable] = useState(false);
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
  const legacyDoughResetSourceRaw = useRef<string|null>(null);
  const mutationQueue = useRef(Promise.resolve());
  const syncing = useRef<Promise<void> | null>(null);
  const registration = useRef<ServiceWorkerRegistration | null>(null);
  const updateRequested = useRef(false);
  const clock = useRef<ReturnType<typeof createLocalTimestampClock> | null>(null);
  if (clock.current === null) clock.current = createLocalTimestampClock();
  const currentTime = useCallback(() => clock.current!.now(), []);
  const resumeClock = useCallback(() => clock.current!.resume(), []);

  const publish = useCallback((value: Snapshot) => {
    state.current = value;
    setSnapshot(value);
    setNow(currentTime());
  }, [currentTime]);

  const prepareUnreadableBoardRecovery = useCallback((error: unknown) => {
    recoverySourceRaw.current = null;
    setRecoveryAvailable(false);
    if (error instanceof LegacyDoughTimerResetRequiredError) {
      legacyDoughResetSourceRaw.current = null;
      setLegacyDoughResetRequired(true);
      setLegacyDoughResetAvailable(false);
      if (activeEditor.current) {
        try {
          const raw = window.localStorage.getItem(boardKey);
          if (raw !== null) {
            legacyDoughResetSourceRaw.current = raw;
            setLegacyDoughResetAvailable(true);
          }
        } catch {
          // Keep editing blocked and do not expose recovery or reset without a stable source value.
        }
      }
      return false;
    }
    legacyDoughResetSourceRaw.current = null;
    setLegacyDoughResetRequired(false);
    setLegacyDoughResetAvailable(false);
    if (!activeEditor.current || error instanceof DOMException || !(error instanceof Error)) return false;

    try {
      const storage = window.localStorage;
      const raw = storage.getItem(boardKey);
      if (raw === null) return false;
      recoverySourceRaw.current = raw;
      setRecoveryAvailable(true);
      return true;
    } catch {
      return false;
    }
  }, [boardKey]);

  const saveSettlement = useCallback((current:Snapshot, time:number) => {
    const next = settleForCompletionVariant(current, time, variant);
    if (next !== current) {
      try { writeLocalBoard(next, undefined, variant); }
      catch (error) {
        writeFailed.current = true;
        setConnection("offline");
        setStatusMessage("提供結果を端末へ保存できません。保存領域とサイトデータ設定を確認して開き直してください。");
        throw error;
      }
    }
    return next;
  }, [variant]);

  const sync = useCallback(():Promise<void> => {
    if (syncing.current) return syncing.current;
    if (!activeEditor.current || writeFailed.current || backupRestoreInProgress.current) {
      return Promise.reject(new Error("保存画面の準備ができていません。画面を開き直してください。"));
    }
    const operation = mutationQueue.current.then(() => {
      if (!activeEditor.current || writeFailed.current) throw new Error("端末へ保存できません。画面を開き直してください。");
      const time = currentTime();
      publish({...saveSettlement(readLocalBoard(undefined, variant), time), serverNow:time});
      recoverySourceRaw.current = null;
      legacyDoughResetSourceRaw.current = null;
      setRecoveryAvailable(false);
      setLegacyDoughResetRequired(false);
      setLegacyDoughResetAvailable(false);
      setStatusMessage(null);
      if (activeEditor.current) setConnection("online");
    }).catch(error => {
      const message = error instanceof Error ? error.message : "保存データを読み取れません。";
      if (!writeFailed.current) {
        prepareUnreadableBoardRecovery(error);
        setStatusMessage(message);
      }
      setConnection("offline");
      throw error;
    });
    mutationQueue.current = operation.then(() => undefined, () => undefined);
    syncing.current = operation.finally(() => { syncing.current = null; });
    return syncing.current;
  }, [currentTime, prepareUnreadableBoardRecovery, publish, saveSettlement, variant]);

  useEffect(() => {
    alive.current = true;
    if (!lockSupported) return () => { alive.current = false; };

    let disposed = false;
    let releaseLock: (() => void) | null = null;
    const lockStart = window.setTimeout(() => {
      void navigator.locks.request(editorLock, { mode: "exclusive", ifAvailable: true }, async lock => {
        if (disposed || !alive.current) return;
        if (!lock) {
          setConnection("offline");
          setStatusMessage("別のタブまたはホーム画面でアプリが開いています。そちらを閉じてから開き直してください。");
          return;
        }

        activeEditor.current = true;
        try {
          await sync();
        } catch (error) {
          if (!writeFailed.current) prepareUnreadableBoardRecovery(error);
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
      if (!document.hidden) {
        const time = currentTime();
        setNow(time);
        const current = state.current;
        if (variant === "recall" && current && activeEditor.current && !writeFailed.current && !backupRestoreInProgress.current && !syncing.current) {
          const recordsByKey = new Map(current.records.map(record => [record.entityKey, record]));
          if (current.completionItems.some(item => {
            const record = recordsByKey.get(item.entityKey);
            return item.isRecalled === false && record?.serveDeadlineAt != null && time >= record.serveDeadlineAt;
          })) void sync().catch(() => {});
        }
      }
    }, 100);
    const refreshOnResume = () => {
      if (!document.hidden) {
        resumeClock();
        void sync().catch(() => {});
      }
    };
    const refreshOnStorage = (event: StorageEvent) => {
      if (event.key === boardKey) void sync().catch(() => {});
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
  }, [boardKey, currentTime, editorLock, lockSupported, prepareUnreadableBoardRecovery, publish, resumeClock, sync, variant]);

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
    if (legacyDoughResetRequired) throw new Error("旧24個タイマーの未完了セットがあります。全体リセットが必要です。");
    if (!activeEditor.current || !state.current) throw new Error("保存画面の準備ができていません。画面を開き直してください。");
    if (writeFailed.current) throw new Error("端末へ保存できません。画面を開き直してください。");
    const command = parseCommand({...input, expectedGeneration:input.expectedGeneration ?? state.current.generation});
    const targetEntityKey = command.type === "create"
      ? command.operationId
      : "id" in command
        ? state.current.items.find(item => item.id === command.id)?.entityKey
          ?? state.current.completionItems.find(item => item.id === command.id)?.entityKey
        : undefined;
    const pendingKey = targetEntityKey ?? command.operationId;
    if (pending.current.has(pendingKey)) throw new Error("このお好み焼きは操作中です。");

    pending.current.add(pendingKey);
    setPendingIds(new Set(pending.current));
    const operation = mutationQueue.current.then(() => {
      if (!activeEditor.current || writeFailed.current) throw new Error("操作を保存できません。アプリを開き直してください。");
      const now = currentTime();
      const current = saveSettlement(readLocalBoard(undefined, variant), now);
      publish(current);
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
      if (!Number.isSafeInteger(next.revision)) throw new Error("保存データの更新番号が上限に達したため保存できません。");
      writeLocalBoard(next, undefined, variant);
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
      } else if (error instanceof LegacyDoughTimerResetRequiredError) {
        prepareUnreadableBoardRecovery(error);
        setStatusMessage(error.message);
        setConnection("offline");
      } else if (message.includes("保存データ")) {
        writeFailed.current = true;
        prepareUnreadableBoardRecovery(error);
        setStatusMessage(message);
        setConnection("offline");
      }
      try { publish(readLocalBoard(undefined, variant)); } catch { /* Preserve the last confirmed view if storage cannot be reread. */ }
      showKitchenError(message);
      throw error;
    }).finally(() => {
      pending.current.delete(pendingKey);
      if (alive.current) setPendingIds(new Set(pending.current));
    });
  }, [currentTime, legacyDoughResetRequired, prepareUnreadableBoardRecovery, publish, saveSettlement, variant]);

  const restoreBackup = useCallback((backup: ParsedLocalBoardBackup, expectedRevision: number|null): Promise<Snapshot> => {
    if (backup.completionVariant !== variant) throw new Error("別方式のバックアップは復元できません。");
    if (legacyDoughResetRequired) throw new Error("旧24個タイマーの未完了セットがあるため、バックアップ復元は停止しています。全体リセットが必要です。");
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
        const currentRaw = window.localStorage.getItem(boardKey);
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
        const current = readLocalBoard(undefined, variant);
        if (current.revision !== expectedRevision) throw new Error("盤面が更新されています。内容を確認してから、もう一度復元してください。");
        revisionBase = current.revision;
        generationBase = current.generation;
      }
      const revision = revisionBase + 1;
      const generation = generationBase + 1;
      if (!Number.isSafeInteger(revision) || !Number.isSafeInteger(generation)) throw new Error("盤面の更新番号が上限に達したため復元できません。");

      const now = currentTime();
      const next = settleForCompletionVariant({
        ...backup.snapshot,
        revision,
        generation,
        serverNow:now,
      }, now, variant);
      writeLocalBoard(next, undefined, variant);
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
            canRetryUnreadableBoardRecovery = window.localStorage.getItem(boardKey) === recoverySourceRaw.current;
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
      showKitchenError(message);
      throw error;
    }).finally(() => {
      backupRestoreInProgress.current = false;
      pending.current.delete(pendingKey);
      if (alive.current) {
        setBackupBusy(false);
        setPendingIds(new Set(pending.current));
      }
    });
  }, [boardKey, currentTime, legacyDoughResetRequired, prepareUnreadableBoardRecovery, publish, recoveryAvailable, variant]);

  const resetLegacyDoughData = useCallback((): Promise<Snapshot> => {
    if (!activeEditor.current || !legacyDoughResetRequired || !legacyDoughResetSourceRaw.current) {
      throw new Error("旧生地タイマーの状態を確認できません。画面を開き直して再確認してください。");
    }
    if (backupRestoreInProgress.current || pending.current.size > 0) {
      throw new Error("別の操作が終わってから全体リセットしてください。");
    }

    const expectedRaw = legacyDoughResetSourceRaw.current;
    const pendingKey = "__legacy-dough-full-reset__";
    pending.current.add(pendingKey);
    setPendingIds(new Set(pending.current));
    const operation = mutationQueue.current.then(() => {
      if (!activeEditor.current) throw new Error("操作を保存できません。アプリを開き直してください。");
      const next = resetUnreadableLegacyDoughBoard(expectedRaw, undefined, variant);
      writeFailed.current = false;
      legacyDoughResetSourceRaw.current = null;
      recoverySourceRaw.current = null;
      setRecoveryAvailable(false);
      setLegacyDoughResetRequired(false);
      setLegacyDoughResetAvailable(false);
      publish(next);
      setStatusMessage(null);
      setConnection("online");
      return next;
    });
    mutationQueue.current = operation.then(() => undefined, () => undefined);

    return operation.catch(error => {
      const message = error instanceof Error ? error.message : "全体リセットを保存できませんでした。";
      let sourceStillMatches = false;
      try {
        sourceStillMatches = activeEditor.current && window.localStorage.getItem(boardKey) === expectedRaw;
      } catch {
        sourceStillMatches = false;
      }
      setLegacyDoughResetAvailable(sourceStillMatches);
      if (!sourceStillMatches) legacyDoughResetSourceRaw.current = null;
      if (error instanceof DOMException && error.name === "QuotaExceededError") {
        writeFailed.current = true;
        setStatusMessage(sourceStillMatches
          ? "端末の保存領域がいっぱいで全体リセットを保存できませんでした。現在のデータは保持しています。空き容量を確保してから再試行してください。"
          : "保存状態が変わったため全体リセットを停止しました。画面を開き直して確認してください。");
        setConnection("offline");
      } else if (error instanceof DOMException || error instanceof TypeError) {
        setStatusMessage("端末へ保存できないため全体リセットを停止しました。現在のデータは保持しています。ブラウザーのサイトデータ設定を確認してください。");
        setConnection("offline");
      } else {
        setStatusMessage(message);
        setConnection("offline");
      }
      showKitchenError(message);
      throw error;
    }).finally(() => {
      pending.current.delete(pendingKey);
      if (alive.current) setPendingIds(new Set(pending.current));
    });
  }, [boardKey, legacyDoughResetRequired, publish, variant]);

  const applyUpdate = useCallback(() => {
    const waiting = registration.current?.waiting;
    if (!waiting) return;
    updateRequested.current = true;
    waiting.postMessage({ type: "APPLY_UPDATE" });
  }, []);

  return {
    completionVariant:variant,
    waitForIdle: async () => { await mutationQueue.current; },
    snapshot,
    now,
    connection,
    pendingIds,
    backupBusy,
    recoveryAvailable,
    legacyDoughResetRequired,
    legacyDoughResetAvailable,
    send,
    restoreBackup,
    resetLegacyDoughData,
    sync,
    prepareSnapshot: async () => {
      await sync();
      if (!state.current) throw new Error("盤面を読み取れません。");
      return state.current;
    },
    prepareExportSnapshot: async () => {
      if (backupRestoreInProgress.current) throw new Error("バックアップを復元中です。完了してから書き出してください。");
      if (activeEditor.current && !writeFailed.current) {
        try {
          await sync();
          if (!state.current) throw new Error("盤面を読み取れません。");
          return state.current;
        }
        catch (error) { if (!writeFailed.current) throw error; }
      }
      if (!state.current) throw new Error("盤面を読み取れません。");
      const time = currentTime();
      // A recovery export may derive results from the last confirmed snapshot;
      // it never publishes that derived state or claims it has been saved.
      return {...settleForCompletionVariant(state.current, time, variant), serverNow:time};
    },
    currentTime,
    getSnapshot: () => state.current,
    statusMessage,
    cacheState,
    updateReady,
    applyUpdate,
  };
}
