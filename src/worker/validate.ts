/**
 * Media validation over Uint8Array (Worker-compatible).
 * Same magic table as src/meowtunes/validate.ts but without Buffer/fs/os.
 */
export class MediaValidator {
  private static readonly MAGIC: Array<[Uint8Array, string]> = [
    [Uint8Array.from([0x49, 0x44, 0x33]), 'id3'],
    [Uint8Array.from([0xff, 0xf3]), 'mp3'],
    [Uint8Array.from([0x4f, 0x67, 0x67, 0x53]), 'ogg'],
    [Uint8Array.from([0x4d, 0x49, 0x43, 0x47]), 'flac'],
    [Uint8Array.from([0x52, 0x49, 0x46, 0x46]), 'wav/riff'],
    [Uint8Array.from([0x00, 0x00, 0x01, 0x46]), 'mp4/m4a (ftyp)'],
    [Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]), 'webm'],
  ];

  static validate(bytes: Uint8Array, contentType: string | undefined, filename: string): { format: string; contentType: string } {
    const MIN = 16 * 1024; // 16 KB min for Worker path (lighter than 64KB file path — audio preview ok)
    if (bytes.length < MIN) throw new Error(`Download too small (${bytes.length} bytes < ${MIN})`);
    if (contentType && /html/i.test(contentType)) throw new Error(`Response is HTML, not audio (${contentType})`);
    let detected: string | null = null;
    for (const [magic, name] of this.MAGIC) {
      if (bytes.length >= magic.length) {
        let ok = true;
        for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) { ok = false; break; }
        if (ok) { detected = name; break; }
      }
    }
    const isAudio = contentType ? /audio/i.test(contentType) : false;
    if (!detected && !isAudio) throw new Error(`No audio signature in ${filename} (content-type: ${contentType ?? 'none'})`);
    const ext = this.extFor(detected, contentType, filename);
    return { format: detected ?? ext, contentType: contentType || `audio/${ext}` };
  }

  private static extFor(detected: string | null, ct: string | undefined, fn: string): string {
    if (detected === 'id3' || detected === 'mp3') return 'mp3';
    if (detected === 'ogg') return 'ogg';
    if (detected === 'flac') return 'flac';
    if (detected === 'wav/riff') return 'wav';
    if (detected === 'mp4/m4a (ftyp)') return 'm4a';
    if (detected === 'webm') return 'webm';
    if (ct) { const m = ct.match(/audio\/([a-z0-9.]+)/i); if (m) return m[1]; }
    const m = fn.match(/\.([a-z0-9]{1,5})$/i);
    return m ? m[1] : 'audio';
  }
}
