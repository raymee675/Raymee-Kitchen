import { COMPLETION_EXPIRED_REASON, LEGACY_SERVICE_OUTCOME, PLATE_DISCARD_REASON, completionStatus, isPancakeId, type ExecutionRecord } from "./kitchen-model";

const headers = [
  "お好み焼きID", "鉄板投入時刻", "下段→上段移動時刻", "タイマー開始時刻", "回収時刻", "温度区間(℃・開始順)", "区間加熱秒数(開始順)", "合計加熱秒数",
  "焼き上がり時刻", "30分タイマー開始時刻", "提供時刻", "30分タイマー期限時刻", "30分タイマー停止時刻", "最終ステータス", "提供不可理由",
];

function localTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function seconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}

function csvField(value: string | number): string {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function excelTextId(value: string): string {
  if (!isPancakeId(value)) throw new Error("実行記録のお好み焼きIDが正しくありません。");
  // A fixed formula makes Excel keep values such as 1-1 as text. The ID
  // allowlist prevents user-controlled formula content inside this wrapper.
  return `="${value}"`;
}

export function executionRecordsToCsv(records: readonly ExecutionRecord[], now = Date.now()): string {
  const orderedRecords = [...records].sort((a, b) => a.creationOrdinal - b.creationOrdinal);
  const lines = [headers, ...orderedRecords.map(record => {
    const totalMilliseconds = record.segments.reduce((total, segment) => total + segment.endedAt - segment.startedAt, 0);
    const outcome = completionStatus(record, now);
    const expiredButUnconfirmed = record.serveDeadlineAt !== null && now >= record.serveDeadlineAt
      && record.servedAt === null && record.unavailableAt === null;
    const finalStatus = outcome === "legacy" ? LEGACY_SERVICE_OUTCOME
      : outcome === "served" ? "提供済み"
      : outcome === "unavailable" ? "提供不可"
      : "保管中";
    const unavailableReason = expiredButUnconfirmed ? COMPLETION_EXPIRED_REASON
      : record.unavailableReason === PLATE_DISCARD_REASON ? PLATE_DISCARD_REASON
      : record.unavailableReason === COMPLETION_EXPIRED_REASON ? COMPLETION_EXPIRED_REASON
      : "";
    const stoppedAt = record.servedAt
      ?? (record.serveTimerStartedAt !== null && (record.unavailableAt !== null || expiredButUnconfirmed)
        ? record.serveDeadlineAt
        : null);
    const temperatures = record.segments.map(segment =>
      segment.temperature === null ? "温度不明" : String(segment.temperature),
    ).join(" | ");
    const segmentSeconds = record.segments.map(segment =>
      seconds(segment.endedAt - segment.startedAt),
    ).join(" | ");
    return [
      excelTextId(record.id),
      record.griddlePlacedAt === null ? "" : localTimestamp(record.griddlePlacedAt),
      record.movedToUpperAt === null ? "" : localTimestamp(record.movedToUpperAt),
      localTimestamp(record.startedAt),
      localTimestamp(record.collectedAt),
      temperatures,
      segmentSeconds,
      seconds(totalMilliseconds),
      record.cookCompletedAt === null || outcome === "legacy" ? "" : localTimestamp(record.cookCompletedAt),
      record.serveTimerStartedAt === null ? "" : localTimestamp(record.serveTimerStartedAt),
      record.servedAt === null ? "" : localTimestamp(record.servedAt),
      record.serveDeadlineAt === null ? "" : localTimestamp(record.serveDeadlineAt),
      stoppedAt === null ? "" : localTimestamp(stoppedAt),
      finalStatus,
      unavailableReason,
    ];
  })].map(line => line.map(csvField).join(",")).join("\r\n");
  return `\uFEFF${lines}\r\n`;
}

function fileTimestamp(timestamp: number): string {
  return localTimestamp(timestamp).replaceAll("-", "").replaceAll(":", "").replace(" ", "-");
}

export function downloadExecutionRecords(records: readonly ExecutionRecord[], now = Date.now()): void {
  const url = URL.createObjectURL(new Blob([executionRecordsToCsv(records, now)], {type:"text/csv;charset=utf-8"}));
  const link = document.createElement("a");
  link.href = url;
  link.download = `teppan-execution-records-${fileTimestamp(now)}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
