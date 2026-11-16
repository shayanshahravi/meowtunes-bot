/**
 * MeowTunes API contract — SINGLE source of truth.
 *
 * Evidence: _research/main.js (hash 2292cccb) — axios client `x` with baseURL = `${apiUrl}api`
 * where apiUrl = `https://api2.vasl.social/` in prod. All Pt.* methods were extracted
 * verbatim below. No endpoint string should be duplicated outside this file.
 *
 * Transport (src/transport/TransportService.ts) prepends config.meowtunes.baseUrl
 * to these paths — so they are stored here as relative paths without the host.
 */
export const MeowTunesContract = {
  baseNote:
    'Prod base is https://api2.vasl.social/ + "api". Default config MEOWTUNES_BASE_URL is https://vasl.social/api — must resolve to same host+prefix; keep as env override.',

  auth: {
    session: { method: 'GET' as const, path: '/auth/session' },
  },

  // Pt.* — music/playlist domain
  playlists: {
    list:               { method: 'GET' as const, path: '/music/playlists' },
    create:              { method: 'POST' as const, path: '/music/playlists' },
    get:                 { method: 'GET' as const, path: '/music/playlists/:id' },
    update:              { method: 'PUT' as const, path: '/music/playlists/:id' },
    remove:              { method: 'DELETE' as const, path: '/music/playlists/:id' },
    addSong:             { method: 'POST' as const, path: '/music/playlists/:id/songs', body: '{songId}' },
    removeSong:          { method: 'DELETE' as const, path: '/music/playlists/:id/songs/:songId' },
    reorder:             { method: 'PUT' as const, path: '/music/playlists/:id/reorder', body: '{songIds}' },
    collaborators:       { method: 'GET' as const, path: '/music/playlists/:id/collaborators' },
    addCollaborators:    { method: 'POST' as const, path: '/music/playlists/:id/collaborators', body: '{userIds, silent?}' },
    removeCollaborator:  { method: 'DELETE' as const, path: '/music/playlists/:id/collaborators/:userId' },
    searchCollaborators: { method: 'GET' as const, path: '/music/collaborators/search', query: '{q}' },
    discover:            { method: 'GET' as const, path: '/music/playlists/discover' },
    // VERIFIED PRIMARY SEARCH: GET /music/playlists/search?q=<query> (Pt.searchPlaylists)
    search:              { method: 'GET' as const, path: '/music/playlists/search', query: '{q, pos?}' },
    saved:               { method: 'GET' as const, path: '/music/playlists/saved' },
    public:              { method: 'GET' as const, path: '/music/playlists/public/:ownerUserId/:playlistId' },
  },

  music: {
    liked:               { method: 'GET' as const, path: '/music/liked' },
    likedToggle:         { method: 'POST' as const, path: '/music/liked/:songId' }, // toggle
    likedStatus:         { method: 'GET' as const, path: '/music/liked/:songId/status' },
    queueSave:           { method: 'PUT' as const, path: '/music/queue', socketFallback: 'music:queue:set' },
    queueGet:            { method: 'GET' as const, path: '/music/queue' },
    queueClear:          { method: 'DELETE' as const, path: '/music/queue' },
    lyrics:              { method: 'GET' as const, path: '/music/lyrics/:songId' },
    similar:             { method: 'GET' as const, path: '/music/similar/:songId', query: '{limit?}' },
    browse:              { method: 'GET' as const, path: '/music/browse' },
    discover:            { method: 'GET' as const, path: '/music/discover' },
    queueRelated:        { method: 'GET' as const, path: '/music/queue-related' },
    discoverShelves:     { method: 'GET' as const, path: '/music/discover-shelves' },
    search:              { method: 'GET' as const, path: '/music/search', query: '{q, limit?, page?}' },
    // Usage evidence: searchMusic:(e,t={})=>x.get("/music/search",{params:{q:e,...t}}) — extra
    // params spread through. VaslMusic (79aa2a67) calls $.browseMusic({page,limit,search,sortBy:"relevance"})
    // for library UI and reads p.data?.songs + p.data?.pagination?.total (VaslFile[], key _id||id).
    resongCreate:        { method: 'POST' as const, path: '/music/resong', body: '{fileId, note}' },
    resongDelete:        { method: 'DELETE' as const, path: '/music/resong' },
    resongsFeed:         { method: 'GET' as const, path: '/music/resongs-feed' },
    // Spec correction: PUT = like, DELETE = unlike (do NOT implement like feature in MVP)
    resongLike:          { method: 'PUT' as const, path: '/music/resong/:id/like' },
    resongUnlike:        { method: 'DELETE' as const, path: '/music/resong/:id/like' },
    resongLikes:         { method: 'GET' as const, path: '/music/resong/:id/likes' },
    playEvent:           { method: 'POST' as const, path: '/music/play-event' },
    playCounts:          { method: 'GET' as const, path: '/music/play-counts', query: '{ids}' },
    ytSearch:            { method: 'GET' as const, path: '/music/yt/search', query: '{q, limit?}' },
    ytImport:            { method: 'POST' as const, path: '/music/yt/import', body: '{videoId}' },
    ytImportStatus:      { method: 'GET' as const, path: '/music/yt/import/:id' },
  },

  // yt-style files API — source/download for media bytes
  files: {
    get:                 { method: 'GET' as const, path: '/files/:id' },
    source:              { method: 'GET' as const, path: '/files/:id/source', query: '{slide:0}', responseType: 'blob' as const },
    mediaReplace:        { method: 'PUT' as const, path: '/files/:id/media' },
    shareLink:           { method: 'GET' as const, path: '/files/:id/share-link' },
    presignUpload:       { method: 'POST' as const, path: '/files/presign-upload' },
    finalizeUpload:      { method: 'POST' as const, path: '/files/finalize-upload' },
  },
} as const;

export function fillPath(template: string, params: Record<string, string>): string {
  let out = template;
  for (const [k, v] of Object.entries(params)) out = out.replace(`:${k}`, encodeURIComponent(v));
  return out;
}
