import fetch from 'node-fetch';
import { Logger, logger } from '../logging/logger';

export interface TelegramFile {
  fileId: string;
  fileUniqueId: string;
  fileSize?: number;
  fileName?: string;
  mimeType?: string;
}

export interface TelegramUploadResult {
  messageId: number;
  chatId: number;
}

export interface TelegramServiceApi {
  sendMessage(chatId: number, text: string): Promise<TelegramUploadResult>;
  editMessage(chatId: number, messageId: number, text: string): Promise<TelegramUploadResult>;
  uploadAudio(
    chatId: number,
    filePath: string,
    caption: string,
    title: string,
    performer?: string,
    albumTitle?: string
  ): Promise<TelegramUploadResult>;
  uploadDocument(chatId: number, filePath: string, caption: string): Promise<TelegramUploadResult>;
}

export class TelegramService implements TelegramServiceApi {
  constructor(
    private readonly botToken: string,
    private readonly log: Logger = logger
  ) {}

  private api(method: string): string {
    return `https://api.telegram.org/bot${this.botToken}/${method}`;
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    const resp = await fetch(this.api(method), {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Telegram ${method} failed: ${resp.status} ${txt}`);
    }
    return resp.json() as Promise<T>;
  }

  async sendMessage(chatId: number, text: string): Promise<TelegramUploadResult> {
    const data = await this.call<{ result: { message_id: number; chat: { id: number } } }>(
      'sendMessage',
      { chat_id: chatId, text, parse_mode: 'HTML' }
    );
    return { messageId: data.result.message_id, chatId: data.result.chat.id };
  }

  async editMessage(
    chatId: number,
    messageId: number,
    text: string
  ): Promise<TelegramUploadResult> {
    const data = await this.call<{ result: { message_id: number } }>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
    });
    return { messageId: data.result.message_id, chatId };
  }

  async uploadAudio(
    chatId: number,
    filePath: string,
    caption: string,
    title: string,
    performer?: string,
    albumTitle?: string
  ): Promise<TelegramUploadResult> {
    const fs = await import('fs');
    const stream = fs.createReadStream(filePath);
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('audio', stream, 'track');
    form.append('caption', caption);
    form.append('title', title);
    if (performer) form.append('performer', performer);
    if (albumTitle) form.append('album', albumTitle);

    const resp = await fetch(this.api('sendAudio'), {
      method: 'POST',
      body: form as any,
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Telegram sendAudio failed: ${resp.status} ${txt}`);
    }
    const data = (await resp.json()) as { result: { message_id: number; chat: { id: number } } };
    return { messageId: data.result.message_id, chatId: data.result.chat.id };
  }

  async uploadDocument(
    chatId: number,
    filePath: string,
    caption: string
  ): Promise<TelegramUploadResult> {
    const fs = await import('fs');
    const stream = fs.createReadStream(filePath);
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('document', stream, 'track');
    form.append('caption', caption);

    const resp = await fetch(this.api('sendDocument'), {
      method: 'POST',
      body: form as any,
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`Telegram sendDocument failed: ${resp.status} ${txt}`);
    }
    const data = (await resp.json()) as { result: { message_id: number; chat: { id: number } } };
    return { messageId: data.result.message_id, chatId: data.result.chat.id };
  }
}
