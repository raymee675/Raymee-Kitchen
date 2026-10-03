// The rendered griddle is 16:9. Keep the oval's physical shape unchanged by
// expressing its horizontal radius as a fraction of the wider board.
export const OVAL_RX = 0.07875;
export const OVAL_RY = 0.095;
export const TIMER_DURATION = 90;
export const DEFAULT_TEMPERATURE = 96;

export interface Pancake {
  id: string;
  plate: 1 | 2;
  x: number;
  y: number;
  // Kept in the stored/API shape for older clients, but canonicalized to 90.
  duration: number;
  temperature: number;
  startedAt: number | null;
  version: number;
}
export type StoredPancake = Omit<Pancake, "temperature"> & { temperature?: number };
export interface Snapshot { revision: number; items: Pancake[]; serverNow: number; serverReceivedAt?: number }
export function clockSample(serverNow:number, serverReceivedAt:number, elapsed:number) {
  const networkRtt = Math.max(0, elapsed - Math.max(0, serverNow - serverReceivedAt));
  return {networkRtt, estimatedNow:serverNow + networkRtt / 2};
}
export type Command =
  | { operationId: string; type: "create"; id: string; plate: 1 | 2; x: number; y: number }
  | { operationId: string; type: "start" | "remove"; id: string; expectedVersion: number }
  | { operationId: string; type: "adjust"; id: string; expectedVersion: number; delta: -1 | 1 };

export function normalizePancake(item: StoredPancake): Pancake {
  return {
    ...item,
    duration: TIMER_DURATION,
    temperature: item.temperature !== undefined && Number.isSafeInteger(item.temperature)
      ? item.temperature
      : DEFAULT_TEMPERATURE,
  };
}

export function normalizePancakes(items: readonly StoredPancake[]): Pancake[] {
  return items.map(normalizePancake);
}

export class KitchenError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 409) { super(message); this.code=code; this.status=status; }
}
export function timer(item: Pancake, now: number) {
  if (item.startedAt === null) return { state: "blank" as const, remaining: TIMER_DURATION, progress: 0 };
  const remainingMs = Math.max(0, item.startedAt + TIMER_DURATION * 1000 - now);
  return { state: remainingMs === 0 ? "done" as const : "running" as const,
    remaining: Math.ceil(remainingMs / 1000),
    progress: Math.min(1, Math.max(0, (now - item.startedAt) / (TIMER_DURATION * 1000))) };
}
export function clampPosition(x: number, y: number) {
  return { x: Math.max(OVAL_RX + 0.02, Math.min(1 - OVAL_RX - 0.02, x)),
    y: Math.max(OVAL_RY + 0.02, Math.min(1 - OVAL_RY - 0.02, y)) };
}
export function overlaps(a: {x: number; y: number}, b: {x: number; y: number}) {
  return ((a.x - b.x) / (2 * OVAL_RX + 0.025)) ** 2 + ((a.y - b.y) / (2 * OVAL_RY + 0.025)) ** 2 < 1;
}
export function gesture(dx: number, dy: number, maximumDistance: number) {
  if (maximumDistance < 10) return "tap";
  if (Math.abs(dx) >= 30 && Math.abs(dx) > Math.abs(dy) * 1.4) return dx > 0 ? "right" : "left";
  if (dy <= -30 && -dy > Math.abs(dx) * 1.4) return "up";
  return "none";
}
const isId = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
export function parseCommand(input: unknown): Command {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new KitchenError("invalid", "操作内容を確認してください。", 400);
  const c = input as Record<string, unknown>;
  if (!isId(c.operationId) || !isId(c.id)) throw new KitchenError("invalid", "操作IDが正しくありません。", 400);
  if (c.type === "create" && (c.plate === 1 || c.plate === 2) && typeof c.x === "number" && typeof c.y === "number" && Number.isFinite(c.x) && Number.isFinite(c.y) && c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1) {
    return { operationId:c.operationId, type:c.type, id:c.id, plate:c.plate, x:c.x, y:c.y };
  }
  if ((c.type === "start" || c.type === "remove" || c.type === "adjust") && Number.isSafeInteger(c.expectedVersion) && (c.expectedVersion as number) > 0) {
    const base = { operationId:c.operationId, id:c.id, expectedVersion:c.expectedVersion as number };
    if (c.type !== "adjust") return {...base, type:c.type};
    if (c.delta === -1 || c.delta === 1) return {...base, type:c.type, delta:c.delta};
  }
  throw new KitchenError("invalid", "操作内容が正しくありません。", 400);
}
export function applyCommand(items: Pancake[], command: Command, now: number): Pancake[] {
  const canonicalItems = normalizePancakes(items);
  if (command.type === "create") {
    if (canonicalItems.some(i => i.id === command.id)) throw new KitchenError("exists", "すでに追加されています。");
    const position = clampPosition(command.x, command.y);
    if (canonicalItems.some(i => i.plate === command.plate && overlaps(i, position))) throw new KitchenError("overlap", "少し離れた空き場所をタップしてください。");
    return [...canonicalItems, {id:command.id, plate:command.plate, ...position, duration:TIMER_DURATION, temperature:DEFAULT_TEMPERATURE, startedAt:null, version:1}];
  }
  const item = canonicalItems.find(i => i.id === command.id);
  if (!item) throw new KitchenError("removed", "このお好み焼きは取り出されています。");
  if (command.type === "start" && item.startedAt !== null) return canonicalItems;
  if (item.version !== command.expectedVersion) throw new KitchenError("conflict", "別の端末で変更されました。最新の表示でもう一度操作してください。");
  const current = timer(item, now);
  if (command.type === "remove") {
    if (current.state !== "done") throw new KitchenError("not_finished", "焼き上がった赤いお好み焼きをタップしてください。");
    return canonicalItems.filter(i => i.id !== item.id);
  }
  let next: Pancake;
  if (command.type === "start") next = {...item, startedAt:now, version:item.version + 1};
  else if (command.type === "adjust") {
    if (current.state === "done") throw new KitchenError("not_running", "待機中または計測中のお好み焼きだけ温度を変更できます。");
    const temperature = item.temperature + command.delta;
    if (!Number.isSafeInteger(temperature)) throw new KitchenError("temperature_limit", "これ以上温度を変更できません。");
    next = {...item, temperature, version:item.version + 1};
  } else throw new KitchenError("invalid", "操作内容が正しくありません。", 400);
  return canonicalItems.map(i => i.id === item.id ? next : i);
}
