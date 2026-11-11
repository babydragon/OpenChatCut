// Volcengine (豆包) 流式语音识别 2.0 — "nostream" 模式.
//
// Why the streaming endpoint instead of 录音文件识别 (0.8 元/小时):
// the file API takes only a public `audio.url`, and a desktop editor has no
// public address for the user's local audio. `bigmodel_nostream` accepts raw
// audio over WebSocket, so local files work with a single API key. It bills as
// 流式识别 (1 元/小时) and, per the vendor docs, returns the more accurate
// "流式输入" result once the last (negative) packet arrives.
//
// Wire format follows the official sauc_python demo shipped with docs
// 6561/1354869: every frame carries a signed sequence, payloads are gzip
// compressed, and the final audio frame uses NEG_WITH_SEQUENCE (0b0011).
//   4-byte header | int32 sequence | uint32 payload size | payload
//   byte0 = 0x11 (version 1, header 4 bytes)
//   byte1 = messageType<<4 | flags
//   byte2 = serialization<<4 | compression
//   byte3 = 0
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { ffmpegBin } from '../media-binaries.ts';
import { ffmpegThreadArgs, spawnMediaProcess } from '../media-process.ts';
import type {
  NormalizedTranscriptResult,
  NormalizedTranscriptUtterance,
  NormalizedTranscriptWord,
} from './transcription-types.ts';

export const VOLCENGINE_WS_URL = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_nostream';
export const VOLCENGINE_RESOURCE_ID = 'volc.seedasr.sauc.duration';
const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // s16le mono
/** One WebSocket session per segment keeps long videos well inside any single-session limit. */
const SEGMENT_SECONDS = 600;
const AUDIO_CHUNK_BYTES = 64 * 1024;
const SESSION_TIMEOUT_MS = 10 * 60 * 1000;
const DECODE_TIMEOUT_MS = 10 * 60 * 1000;

export interface VolcengineAsrConfig {
  readonly apiKey: string;
  readonly appId: string;
  readonly accessToken: string;
  readonly resourceId: string;
  /** Test seam; production uses VOLCENGINE_WS_URL. */
  readonly wsUrl?: string;
}

export class VolcengineAsrError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = 'VolcengineAsrError';
    this.code = code;
  }
}

// ── Protocol ────────────────────────────────────────────────────────────────

export const MESSAGE_FULL_CLIENT_REQUEST = 0b0001;
export const MESSAGE_AUDIO_ONLY_REQUEST = 0b0010;
export const MESSAGE_FULL_SERVER_RESPONSE = 0b1001;
export const MESSAGE_ERROR = 0b1111;
export const FLAG_NO_SEQUENCE = 0b0000;
export const FLAG_POS_SEQUENCE = 0b0001;
export const FLAG_NEG_SEQUENCE = 0b0010;
export const FLAG_NEG_WITH_SEQUENCE = 0b0011;

/** gzip keeps a 19 MB PCM segment well under any frame/backpressure limit. */
export function encodeFrame(
  messageType: number,
  flags: number,
  sequence: number,
  payload: Uint8Array,
  options: { json?: boolean } = {},
): Uint8Array {
  const body = gzipSync(payload);
  const out = new Uint8Array(8 + 4 + body.byteLength);
  out[0] = 0x11; // version 1, header 4 bytes
  out[1] = ((messageType & 0x0f) << 4) | (flags & 0x0f);
  out[2] = (options.json ? 0x10 : 0x00) | 0x01; // JSON + gzip
  out[3] = 0x00;
  const view = new DataView(out.buffer);
  view.setInt32(4, sequence);
  view.setUint32(8, body.byteLength);
  out.set(body, 12);
  return out;
}

export interface ParsedFrame {
  readonly messageType: number;
  readonly flags: number;
  readonly sequence?: number;
  readonly event?: number;
  readonly payload: Uint8Array;
}

/** Mirrors the demo's ResponseParser: sequence/event are flag-gated, payload may be gzip. */
export function parseServerFrame(bytes: Uint8Array): ParsedFrame | { errorCode: number; message: string } {
  if (bytes.byteLength < 4) throw new VolcengineAsrError('火山返回的帧不完整');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerSize = (bytes[0]! & 0x0f) * 4;
  const messageType = (bytes[1]! >> 4) & 0x0f;
  const flags = bytes[1]! & 0x0f;
  const compression = bytes[2]! & 0x0f;
  let offset = headerSize;
  let sequence: number | undefined;
  let event: number | undefined;
  if (flags & 0x01) { sequence = view.getInt32(offset); offset += 4; }
  if (flags & 0x04) { event = view.getInt32(offset); offset += 4; }
  if (messageType === MESSAGE_ERROR) {
    const code = view.getInt32(offset);
    const size = view.getUint32(offset + 4);
    offset += 8;
    const text = new TextDecoder().decode(bytes.subarray(offset, offset + size));
    return { errorCode: code, message: text || `火山识别错误 ${code}` };
  }
  if (messageType !== MESSAGE_FULL_SERVER_RESPONSE) {
    return { messageType, flags, sequence, event, payload: new Uint8Array(0) };
  }
  const size = view.getUint32(offset);
  offset += 4;
  let payload = bytes.subarray(offset, offset + size);
  if (compression === 0x01) {
    try {
      payload = new Uint8Array(gunzipSync(payload));
    } catch {
      throw new VolcengineAsrError('火山返回的 gzip 数据无法解压');
    }
  }
  return { messageType, flags, sequence, event, payload };
}

/** The server marks the final result with bit 0b0010 (NEG_SEQUENCE / NEG_WITH_SEQUENCE). */
export function isLastResponse(frame: ParsedFrame): boolean {
  return (frame.flags & 0x02) !== 0 || (frame.sequence !== undefined && frame.sequence < 0);
}

// ── Request payload ─────────────────────────────────────────────────────────

/** Volcengine uses BCP-47-ish codes; the editor stores bare ISO-639-1. */
export function volcengineLanguage(language: string): string | undefined {
  const value = language.trim().toLowerCase();
  if (!value || value === 'auto' || value === 'autodetect') return undefined;
  if (value.startsWith('zh') || value === 'cmn' || value === 'yue') return 'zh-CN';
  const table: Record<string, string> = {
    en: 'en-US', ja: 'ja-JP', ko: 'ko-KR', es: 'es-MX', fr: 'fr-FR', de: 'de-DE',
    it: 'it-IT', ru: 'ru-RU', pt: 'pt-BR', id: 'id-ID', th: 'th-TH', ar: 'ar-SA',
    vi: 'vi-VN', ms: 'ms-MY', fil: 'fil-PH', nl: 'nl-NL', pl: 'pl-PL', tr: 'tr-TR',
    ro: 'ro-RO', el: 'el-GR', bn: 'bn-BD', uk: 'uk-UA', ne: 'ne-NP',
  };
  return table[value.slice(0, 3)] ?? table[value.slice(0, 2)];
}

export function clientRequestPayload(language: string, diarize: boolean): Record<string, unknown> {
  const mapped = volcengineLanguage(language);
  // Speaker separation only applies to zh-CN (or unspecified) per the docs.
  const speaker = diarize && (mapped === undefined || mapped === 'zh-CN');
  return {
    user: { uid: 'openchatcut' },
    audio: {
      format: 'wav',
      codec: 'raw',
      rate: SAMPLE_RATE,
      bits: 16,
      channel: 1,
      ...(mapped === undefined ? {} : { language: mapped }),
    },
    request: {
      model_name: 'bigmodel',
      enable_itn: true,
      enable_punc: true,
      // Keep disfluencies: the editor's own clean-script tools remove fillers,
      // and 语义顺滑 would delete the words users want to cut.
      enable_ddc: false,
      show_utterances: true,
      result_type: 'full',
      ...(speaker ? { enable_speaker_info: true } : {}),
    },
  };
}

export function requestHeaders(config: VolcengineAsrConfig): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Api-Resource-Id': config.resourceId.trim() || VOLCENGINE_RESOURCE_ID,
    'X-Api-Request-Id': randomUUID(),
    'X-Api-Connect-Id': randomUUID(),
    'X-Api-Sequence': '-1',
  };
  if (config.apiKey.trim()) headers['X-Api-Key'] = config.apiKey.trim();
  else if (config.appId.trim() && config.accessToken.trim()) {
    headers['X-Api-App-Key'] = config.appId.trim();
    headers['X-Api-Access-Key'] = config.accessToken.trim();
  }
  return headers;
}

// ── Audio ───────────────────────────────────────────────────────────────────

/** Decode anything ffmpeg understands into 16 kHz mono s16le (what the API requires). */
export async function decodePcm16k(audio: Uint8Array): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), 'occ-volc-asr-'));
  const input = join(dir, 'input.bin');
  try {
    await writeFile(input, audio);
    return await new Promise<Uint8Array>((resolve, reject) => {
      const child = spawnMediaProcess(ffmpegBin(), [
        ...ffmpegThreadArgs(),
        '-nostdin', '-hide_banner', '-loglevel', 'error',
        '-i', input, '-vn', '-ac', '1', '-ar', String(SAMPLE_RATE),
        '-f', 's16le', 'pipe:1',
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      const chunks: Buffer[] = [];
      let total = 0;
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new VolcengineAsrError('音频解码超时'));
      }, DECODE_TIMEOUT_MS);
      child.stdout.on('data', (chunk: Buffer) => { chunks.push(chunk); total += chunk.length; });
      child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('close', (code) => {
        clearTimeout(timer);
        if (code !== 0) {
          reject(new VolcengineAsrError(`音频解码失败：${stderr.trim() || `ffmpeg exit ${code}`}`));
          return;
        }
        if (!total) {
          reject(new VolcengineAsrError('该素材没有可识别的音频'));
          return;
        }
        const joined = Buffer.concat(chunks, total);
        resolve(new Uint8Array(joined.buffer, joined.byteOffset, joined.byteLength));
      });
    });
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface PcmSegment {
  readonly pcm: Uint8Array;
  readonly offsetMs: number;
}

/** Split PCM on exact sample boundaries so segment timestamps stay contiguous. */
export function splitPcm(pcm: Uint8Array, secondsPerSegment = SEGMENT_SECONDS): PcmSegment[] {
  const bytesPerSegment = Math.max(2, Math.floor((secondsPerSegment * BYTES_PER_SECOND) / 2) * 2);
  const segments: PcmSegment[] = [];
  for (let start = 0; start < pcm.byteLength; start += bytesPerSegment) {
    const end = Math.min(pcm.byteLength, start + bytesPerSegment);
    segments.push({ pcm: pcm.subarray(start, end), offsetMs: Math.round((start / BYTES_PER_SECOND) * 1000) });
  }
  return segments;
}

/** The reference demo streams WAV (header + pcm_s16le); each session is independent, so each needs its own header. */
export function wavContainer(pcm: Uint8Array): Uint8Array {
  const out = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(out.buffer);
  const write = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) out[offset + i] = text.charCodeAt(i);
  };
  write(0, 'RIFF');
  view.setUint32(4, 36 + pcm.byteLength, true);
  write(8, 'WAVE');
  write(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, BYTES_PER_SECOND, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, 'data');
  view.setUint32(40, pcm.byteLength, true);
  out.set(pcm, 44);
  return out;
}

// ── Socket ──────────────────────────────────────────────────────────────────

export interface VolcengineSocket {
  binaryType: string;
  send(data: Uint8Array): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

export type VolcengineSocketFactory = (url: string, headers: Record<string, string>) => VolcengineSocket;

const defaultSocketFactory: VolcengineSocketFactory = (url, headers) => {
  // Node's global WebSocket accepts non-standard `headers` (undici extension);
  // the DOM typings do not, hence the cast.
  const Ctor = (globalThis as unknown as {
    WebSocket?: new (url: string, options: { headers: Record<string, string> }) => VolcengineSocket;
  }).WebSocket;
  if (typeof Ctor !== 'function') {
    throw new VolcengineAsrError('当前运行环境不支持 WebSocket（需要 Node 22+）');
  }
  return new Ctor(url, { headers });
};

interface SegmentResult {
  readonly text: string;
  readonly utterances: readonly RawUtterance[];
}

interface RawUtterance {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly speaker?: string;
  readonly words: readonly { text: string; start: number; end: number }[];
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function parseSegmentResult(payload: Uint8Array): SegmentResult {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    return { text: '', utterances: [] };
  }
  const record = body as { result?: { text?: unknown; utterances?: unknown } } | null;
  const text = stringValue(record?.result?.text) ?? '';
  const utterances: RawUtterance[] = [];
  if (Array.isArray(record?.result?.utterances)) {
    for (const value of record.result.utterances) {
      const item = value as {
        text?: unknown; start_time?: unknown; end_time?: unknown;
        speaker?: unknown; additions?: { speaker?: unknown };
        words?: Array<{ text?: unknown; start_time?: unknown; end_time?: unknown }>;
      } | null;
      if (!item) continue;
      const itemText = stringValue(item.text);
      const start = numberValue(item.start_time);
      const end = numberValue(item.end_time);
      if (itemText === undefined || start === undefined || end === undefined) continue;
      const words: Array<{ text: string; start: number; end: number }> = [];
      for (const rawWord of item.words ?? []) {
        const wordText = stringValue(rawWord.text);
        const wordStart = numberValue(rawWord.start_time);
        const wordEnd = numberValue(rawWord.end_time);
        if (wordText === undefined || wordStart === undefined || wordEnd === undefined) continue;
        words.push({ text: wordText, start: wordStart, end: Math.max(wordStart, wordEnd) });
      }
      utterances.push({
        text: itemText,
        start,
        end: Math.max(start, end),
        speaker: stringValue(item.speaker) ?? stringValue(item.additions?.speaker),
        words,
      });
    }
  }
  return { text, utterances };
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function runSegment(
  config: VolcengineAsrConfig,
  pcm: Uint8Array,
  language: string,
  diarize: boolean,
  socketFactory: VolcengineSocketFactory,
  signal?: AbortSignal,
): Promise<SegmentResult> {
  const url = config.wsUrl?.trim() || VOLCENGINE_WS_URL;
  const socket = socketFactory(url, requestHeaders(config));
  socket.binaryType = 'arraybuffer';

  return await new Promise<SegmentResult>((resolve, reject) => {
    let settled = false;
    let latest: SegmentResult = { text: '', utterances: [] };
    const timer = setTimeout(() => finish(new VolcengineAsrError('火山识别超时')), SESSION_TIMEOUT_MS);

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      try { socket.close(); } catch { /* already closed */ }
      if (error) reject(error);
      else resolve(latest);
    };
    const onAbort = (): void => finish(new VolcengineAsrError('火山识别已取消'));

    const sendAll = async (): Promise<void> => {
      try {
        const request = new TextEncoder().encode(JSON.stringify(clientRequestPayload(language, diarize)));
        socket.send(encodeFrame(MESSAGE_FULL_CLIENT_REQUEST, FLAG_POS_SEQUENCE, 1, request, { json: true }));
        const wav = wavContainer(pcm);
        const total = Math.max(1, Math.ceil(wav.byteLength / AUDIO_CHUNK_BYTES));
        let sequence = 2;
        for (let index = 0; index < total; index += 1) {
          const start = index * AUDIO_CHUNK_BYTES;
          const chunk = wav.subarray(start, Math.min(wav.byteLength, start + AUDIO_CHUNK_BYTES));
          const last = index === total - 1;
          socket.send(encodeFrame(
            MESSAGE_AUDIO_ONLY_REQUEST,
            last ? FLAG_NEG_WITH_SEQUENCE : FLAG_POS_SEQUENCE,
            last ? -sequence : sequence,
            chunk,
          ));
          sequence += 1;
          if (index % 8 === 7) await yieldToEventLoop();
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };

    socket.addEventListener('open', () => { void sendAll(); });

    socket.addEventListener('message', (event) => {
      try {
        const data = (event as { data?: unknown }).data;
        const bytes = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : data instanceof Uint8Array
            ? data
            : null;
        if (!bytes) return;
        const frame = parseServerFrame(bytes);
        if ('errorCode' in frame) {
          finish(new VolcengineAsrError(`火山识别失败：${frame.message}`, frame.errorCode));
          return;
        }
        if (frame.messageType !== MESSAGE_FULL_SERVER_RESPONSE) return;
        if (frame.payload.byteLength) latest = parseSegmentResult(frame.payload);
        if (isLastResponse(frame)) finish();
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });

    socket.addEventListener('error', () => finish(new VolcengineAsrError('火山 WebSocket 连接失败（检查 API Key、资源 ID 与网络）')));
    socket.addEventListener('close', () => finish());
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ── Public entry point ──────────────────────────────────────────────────────

export function isVolcengineConfigured(config: VolcengineAsrConfig): boolean {
  return Boolean(config.apiKey.trim() || (config.appId.trim() && config.accessToken.trim()));
}

export async function transcribeWithVolcengine(
  audio: Uint8Array,
  options: { language: string; diarize: boolean; config: VolcengineAsrConfig; signal?: AbortSignal },
  deps: { socketFactory?: VolcengineSocketFactory; decode?: (audio: Uint8Array) => Promise<Uint8Array> } = {},
): Promise<NormalizedTranscriptResult> {
  if (!isVolcengineConfigured(options.config)) {
    throw new VolcengineAsrError('火山引擎 API Key 未配置');
  }
  const pcm = await (deps.decode ?? decodePcm16k)(audio);
  const socketFactory = deps.socketFactory ?? defaultSocketFactory;
  const words: NormalizedTranscriptWord[] = [];
  const utterances: NormalizedTranscriptUtterance[] = [];
  const texts: string[] = [];

  for (const segment of splitPcm(pcm)) {
    const result = await runSegment(
      options.config, segment.pcm, options.language, options.diarize, socketFactory, options.signal,
    );
    if (result.text) texts.push(result.text);
    for (const utterance of result.utterances) {
      const start = segment.offsetMs + utterance.start;
      const end = segment.offsetMs + Math.max(utterance.start, utterance.end);
      const speaker = utterance.speaker ?? null;
      const utteranceWords: NormalizedTranscriptWord[] = utterance.words.map((word) => ({
        text: word.text,
        start: segment.offsetMs + word.start,
        end: segment.offsetMs + Math.max(word.start, word.end),
        speaker,
      }));
      words.push(...utteranceWords);
      if (speaker) {
        utterances.push({ speaker, text: utterance.text, start, end, words: utteranceWords });
      }
    }
  }

  return { text: texts.join('\n').trim(), words, utterances };
}
