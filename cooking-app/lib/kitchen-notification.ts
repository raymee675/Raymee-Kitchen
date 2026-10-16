import { toast } from "sonner";

export function showKitchenError(message: string): void {
  const summary = message.split(/[。\r\n]/, 1)[0].trim() || "操作できませんでした";
  toast.error(summary.length > 48 ? `${summary.slice(0, 47)}…` : summary, {
    id: "kitchen-notification",
    duration: 2500,
  });
}
