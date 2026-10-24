/**
 * Saved Remote Connections (Settings > Connections), kept in localStorage.
 * Also the Teleport targets in the thread menu (#1702).
 */

export type SavedHost = {
  id: string;
  label: string;
  host: string;
  remotePort: number;
  /** Hint only: the encrypted token itself lives in the main process. */
  tokenSaved?: boolean;
};
export const STORAGE_KEY = "coder.remoteConnections";

export function loadHosts(): SavedHost[] {
  try {
    const raw: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw.filter((item): item is SavedHost =>
      item && typeof item.id === "string" &&
      typeof item.label === "string" && typeof item.host === "string" &&
      Number.isInteger(item.remotePort) && item.remotePort > 0 &&
      item.remotePort <= 65535,
    ).slice(0, 30);
  } catch {
    return [];
  }
}
