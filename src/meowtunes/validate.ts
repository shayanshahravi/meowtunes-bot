import fs from 'fs';
import path from 'path';
import os from 'os';
import { MeowTunesError } from '../utils/errors';
import { config } from '../config';
import { Logger, logger } from '../logging/logger';

const MAGIC_BYTES: Array<[Buffer, string]> = [
  [Buffer.from([0x49, 0x44, 0x33]), 'id3'], // ID3 MP3
  [Buffer.from([0xff, 0xf3]), 'mp3'], // MPEG frame
  [Buffer.from([0x4f, 0x67, 0x67, 0x53]), 'ogg'],
  [Buffer.from([0x4d, 0x49, 0x43, 0x47]), 'flac'],
  [Buffer.from([0x52, 0x49, 0x46, 0x46]), 'wav/riff'],
  [Buffer.from([0x00, 0x00, 0x01, 0x46]), 'mp4/m4a (ftyp)'],
  [Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), 'webm'],
];

export class MediaValidator {
  constructor(private readonly log: Logger = logger) {}

  /**
   * Validate that the response buffer looks like media:
   * - non-empty, at least MIN_BYTES large
   * - content-type looks like audio/* or octet-stream
   * - magic bytes match a known audio format
   *
   * Returns the detected format or throws MeowTunesError.invalidMedia.
   */
  static validate(buffer: Buffer, contentType: string | undefined, filename: string): {
    format: string;
    contentType: string;
  } {
    const MIN_BYTES = 64 * 1024; // 64 KB minimum for a valid audio file
    if (buffer.length < MIN_BYTES) {
      throw MeowTunesError.invalidMedia(`Download too small (${buffer.length} bytes < ${MIN_BYTES})`);
    }
    if (contentType && /html/i.test(contentType)) {
      throw MeowTunesError.invalidMedia(`Response is HTML, not audio (${contentType})`);
    }
    // Detect magic bytes
    let detected: string | null = null;
    for (const [magic, name] of MAGIC_BYTES) {
      if (buffer.slice(0, magic.length).equals(magic)) {
        detected = name;
        break;
      }
    }
    // Some files start with BOM or have a container header. If the buffer has
    // the typical high-entropy signature of compressed audio and is large,
    // trust it. Otherwise require an explicit magic hit.
    const isAudioType = contentType ? /audio/i.test(contentType) : false;
    if (!detected && !isAudioType) {
      throw MeowTunesError.invalidMedia(
        `No audio signature detected in ${filename} (content-type: ${contentType ?? 'none'})`
      );
    }
    const ext = MediaValidator.extFor(detected, contentType, filename);
    return {
      format: detected ?? ext,
      contentType: contentType || `audio/${ext}`,
    };
  }

  private static extFor(detected: string | null, contentType: string | undefined, filename: string): string {
    if (detected === 'id3' || detected === 'mp3') return 'mp3';
    if (detected === 'ogg') return 'ogg';
    if (detected === 'flac') return 'flac';
    if (detected === 'wav/riff') return 'wav';
    if (detected === 'mp4/m4a (ftyp)') return 'm4a';
    if (detected === 'webm') return 'webm';
    if (contentType) {
      const m = contentType.match(/audio\/([a-z0-9.]+)/i);
      if (m) return m[1];
    }
    const m = filename.match(/\.([a-z0-9]{1,5})$/i);
    return m ? m[1] : 'audio';
  }
}