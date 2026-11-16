import fs from 'fs';
import os from 'os';
import path from 'path';
import { MeowTunesError } from '../utils/errors';
import { config } from '../config';
import { Logger, logger } from '../logging/logger';
import { TransportService } from '../transport/TransportService';
import { MeowTunesContract, fillPath } from './contract';
import { MediaValidator } from './validate';

export interface DownloadResult {
  filePath: string;
  bytes: number;
  contentType: string;
  format: string;
  cleanup: () => Promise<void>;
}

/**
 * Downloads via GET /files/:id/source?slide=0 — the ONLY download path the frontend uses.
 * Evidence: yt.getFileSource: x.get(`/files/${e}/source`, {params:{slide:t}, responseType:"blob"})
 * fileId is VaslFile._id resolved by TrackResolver — never a playlist/song synthetic id.
 */
export class MeowTunesDownloadService {
  constructor(private readonly transport: TransportService, private readonly log: Logger = logger) {}

  async download(fileId: string): Promise<DownloadResult> {
    if (!fileId || !/^[0-9a-f]{24}$/i.test(fileId)) {
      // vasl fileIds are Mongo ObjectIds — reject obvious garbage early
      this.log.warn('download called with non-ObjectId fileId', { fileId });
    }
    const safe = fileId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filePath = path.join(os.tmpdir(), `meowtunes_${safe}_${Date.now()}.bin`);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const maxSize = config.download.maxFileSizeBytes;

    // Use transport so baseUrl/host allowlist, auth header, retries apply uniformly
    const p = fillPath(MeowTunesContract.files.source.path, { id: fileId });
    let buffer: Buffer;
    let contentType = 'application/octet-stream';
    try {
      const res = await this.transport.request<Buffer>({
        path: p,
        params: { slide: 0 },
        responseType: 'arraybuffer',
        raw: true,
      } as any);
      // Transport returns Buffer for raw/arraybuffer
      buffer = (res.data as unknown as Buffer) ?? Buffer.alloc(0);
      contentType = (res.headers?.['content-type'] as string) || contentType;
      if (!buffer || buffer.length === 0) throw MeowTunesError.invalidMedia('Empty download');
      if (buffer.length > maxSize) throw MeowTunesError.invalidMedia(`File too large: ${buffer.length} > ${maxSize}`);
    } catch (err) {
      // Map transport errors to download-specific ones where helpful
      if (err instanceof MeowTunesError) throw err;
      throw new MeowTunesError((err as Error).message, 'DOWNLOAD_ERROR', undefined, true);
    }

    await fs.promises.writeFile(filePath, buffer);

    const validation = MediaValidator.validate(buffer, contentType, path.basename(filePath));
    this.log.info('download complete', { fileId, bytes: buffer.length, format: validation.format });

    return {
      filePath,
      bytes: buffer.length,
      contentType: validation.contentType,
      format: validation.format,
      cleanup: async () => {
        if (fs.existsSync(filePath)) await fs.promises.unlink(filePath).catch(() => {});
      },
    };
  }
}
