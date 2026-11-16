/**
 * Best-effort short-lived cache for playlist search (optional).
 * Cloudflare Workers isolates are reused across requests but not guaranteed durable.
 * This Map is NOT required for correctness:
 *  - playlist selection is stateless: callback_data is "select:<playlistId>" (a real
 *    MeowTunes ID) and handlePlaylistSelection re-fetches via getPlaylist(id).
 *  - artist flow is stateless: callback_data is "artist:<fileId>" (real fileId),
 *    handleArtistSelection downloads directly via getFileSourceBytes(fileId).
 * No KV/D1/Durable Objects needed. The Maps are pure best-effort caches kept to
 * allow optional validation/telemetry without extra cost. See STATE DECISION.
 */

type PlaylistSummary = { id: string; title: string; ownerId: string; isOwner: boolean; songCount: number; coverUrl?: string };

const pendingSearches = new Map<number, { at: number; rows: PlaylistSummary[] }>();
const TTL_MS = 10 * 60 * 1000;

function gc<K, V extends { at: number }>(m: Map<K, V>): void {
  const now = Date.now();
  for (const [k, v] of m) if (now - v.at > TTL_MS) m.delete(k);
}

export function putPendingSearch(chatId: number, rows: PlaylistSummary[]): void {
  gc(pendingSearches);
  pendingSearches.set(chatId, { at: Date.now(), rows });
}

export function getPendingSearch(chatId: number): PlaylistSummary[] | undefined {
  gc(pendingSearches);
  return pendingSearches.get(chatId)?.rows;
}
