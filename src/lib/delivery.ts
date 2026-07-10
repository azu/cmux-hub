import type { DeliveryResult } from "./api.ts";

/**
 * Handle a delivery response from the server. When the payload could not be
 * pasted into a cmux terminal, the server returns the formatted text and the
 * browser copies it to the clipboard — the toast makes that unmissable so
 * the user knows to paste it into whichever session is active.
 */
export async function handleDelivery(
  result: DeliveryResult,
  showToast: (message: string, kind?: "info" | "success") => void,
): Promise<void> {
  if (result.delivered === "clipboard" && result.text) {
    try {
      await navigator.clipboard.writeText(result.text);
      showToast("📋 Copied to clipboard — paste it into your agent session", "success");
    } catch {
      showToast("Could not copy to clipboard — no terminal is connected", "info");
    }
  }
}
