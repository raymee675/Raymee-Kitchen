import { settleUnsearchedCompletions, type Snapshot } from "./kitchen-model";

export type CompletionVariant = "recall" | "all";
export const completionVariantLabels:Record<CompletionVariant,string> = {recall:"呼出あり", all:"自動一覧"};

export function resolveCompletionVariant(search:string):CompletionVariant {
  return new URLSearchParams(search).get("completion") === "all" ? "all" : "recall";
}

export function settleForCompletionVariant(snapshot:Snapshot, now:number, variant:CompletionVariant):Snapshot {
  return variant === "recall" ? settleUnsearchedCompletions(snapshot, now) : snapshot;
}
