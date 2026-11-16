/**
 * Telegram Bot API over native fetch (Worker-compatible).
 * Same method surface the Node bot uses: sendMessage / editMessageText /
 * answerCallbackQuery / sendAudio / sendDocument. No node-fetch, no fs streams —
 * uploads go as FormData + Blob built from in-memory bytes.
 */
import type { WorkerLogger } from './env';

export interface TelegramSendResult {
  messageId: number;
  chatId: number;
}

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly log: WorkerLogger,
  ) {}

  private url(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  private async call<T>(method: string, body: Record<string, unknown>): Promise<T> {
    let resp: Response;
    try {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 15000);
      try {
        resp = await fetch(this.url(method), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } finally { clearTimeout(to); }
    } catch (err) {
      throw new Error(`Telegram ${method} network error: ${(err as Error).message}`);
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`Telegram ${method} failed: ${resp.status} ${txt.slice(0, 300)}`);
    }
    const data = (await resp.json()) as unknown as Record<string, unknown>;
    if (data && typeof data === 'object' && 'ok' in data && (data as { ok: unknown }).ok === false) {
      const desc = String((data as { description?: unknown }).description ?? JSON.stringify(data).slice(0, 300));
      throw new Error(`Telegram ${method} error: ${desc.slice(0, 300)}`);
    }
    return data as T;
  }

  async sendMessage(chatId: number, text: string): Promise<TelegramSendResult> {
    const data = await this.call<{ result: { message_id: number; chat: { id: number } } }>(
      'sendMessage',
      { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true },
    );
    return { messageId: data.result.message_id, chatId: data.result.chat.id };
  }

  async sendMessageWithKeyboard(chatId: number, text: string, keyboard: unknown[][]): Promise<TelegramSendResult> {
    const data = await this.call<{ result: { message_id: number; chat: { id: number } } }>(
      'sendMessage',
      { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, reply_markup: { inline_keyboard: keyboard } },
    );
    return { messageId: data.result.message_id, chatId: data.result.chat.id };
  }

  async editMessage(chatId: number, messageId: number, text: string): Promise<TelegramSendResult> {
    const data = await this.call<{ result: { message_id: number } }>('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    return { messageId: data.result.message_id, chatId };
  }

  async answerCallbackQuery(id: string, text?: string): Promise<void> {
    try {
      await this.call('answerCallbackQuery', text ? { callback_query_id: id, text } : { callback_query_id: id });
    } catch (err) {
      this.log.warn('answerCallbackQuery failed', { error: (err as Error).message });
    }
  }

  private async sendFile(
    kind: 'sendAudio' | 'sendDocument',
    chatId: number,
    bytes: Uint8Array,
    filename: string,
    fields: Record<string, string>,
  ): Promise<TelegramSendResult> {
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append(kind === 'sendAudio' ? 'audio' : 'document', new Blob([bytes]), filename);
    for (const [k, v] of Object.entries(fields)) if (v) form.append(k, v);
    let resp: Response;
    try {
      const ctrl2 = new AbortController();
      const to2 = setTimeout(() => ctrl2.abort(), 30000);
      try { resp = await fetch(this.url(kind), { method: 'POST', body: form, signal: ctrl2.signal }); } finally { clearTimeout(to2); }
    } catch (err) {
      throw new Error(`Telegram ${kind} network error: ${(err as Error).message}`);
    }
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`Telegram ${kind} failed: ${resp.status} ${txt.slice(0, 300)}`);
    }
    const data = (await resp.json()) as { result: { message_id: number; chat: { id: number } } };
    return { messageId: data.result.message_id, chatId: data.result.chat.id };
  }

  async sendAudio(
    chatId: number,
    bytes: Uint8Array,
    filename: string,
    caption: string,
    title: string,
    performer?: string,
  ): Promise<TelegramSendResult> {
    return this.sendFile('sendAudio', chatId, bytes, filename, {
      caption,
      title,
      ...(performer ? { performer } : {}),
    });
  }

  async sendDocument(
    chatId: number,
    bytes: Uint8Array,
    filename: string,
    caption: string,
  ): Promise<TelegramSendResult> {
    return this.sendFile('sendDocument', chatId, bytes, filename, { caption });
  }
}
