// 火山流式识别 2.0 (nostream) 兼容层：协议编码、响应解析、分片与合并。
// 帧格式与官方 sauc_python demo 对齐：带 sequence、gzip、最后一包用 0b0011 负序号。
// npx tsx server/plugins/volcengine-asr.verify.ts
import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  FLAG_NEG_WITH_SEQUENCE,
  FLAG_POS_SEQUENCE,
  MESSAGE_AUDIO_ONLY_REQUEST,
  MESSAGE_FULL_CLIENT_REQUEST,
  MESSAGE_FULL_SERVER_RESPONSE,
  clientRequestPayload,
  encodeFrame,
  isLastResponse,
  parseServerFrame,
  requestHeaders,
  splitPcm,
  transcribeWithVolcengine,
  volcengineLanguage,
  wavContainer,
  type VolcengineSocket,
} from './volcengine-asr.ts';

// ── 帧编码 ────────────────────────────────────────────────────────────────
{
  const payload = new TextEncoder().encode('{"model":"x"}');
  const frame = encodeFrame(MESSAGE_FULL_CLIENT_REQUEST, FLAG_POS_SEQUENCE, 1, payload, { json: true });
  assert.deepEqual([...frame.slice(0, 4)], [0x11, 0x11, 0x11, 0x00], 'full request: JSON + gzip + 正序号');
  const view = new DataView(frame.buffer);
  assert.equal(view.getInt32(4), 1, 'sequence 在 header 之后');
  const bodySize = view.getUint32(8);
  assert.equal(bodySize, frame.byteLength - 12);
  assert.equal(new TextDecoder().decode(gunzipSync(frame.subarray(12))), '{"model":"x"}', 'payload 为 gzip');

  const audio = encodeFrame(MESSAGE_AUDIO_ONLY_REQUEST, FLAG_POS_SEQUENCE, 2, new Uint8Array([1, 2, 3]));
  assert.deepEqual([...audio.slice(0, 4)], [0x11, 0x21, 0x01, 0x00], 'audio-only: 无 JSON + gzip');
  assert.deepEqual([...gunzipSync(audio.subarray(12))], [1, 2, 3]);

  const last = encodeFrame(MESSAGE_AUDIO_ONLY_REQUEST, FLAG_NEG_WITH_SEQUENCE, -2, new Uint8Array(0));
  assert.deepEqual([...last.slice(0, 4)], [0x11, 0x23, 0x01, 0x00], '最后一包 0b0011');
  assert.equal(new DataView(last.buffer).getInt32(4), -2, '负序号');
}

// ── 服务端帧解析 ──────────────────────────────────────────────────────────
function serverFrame(body: string, flags: number, sequence?: number, gzip = true): Uint8Array {
  const payload = gzip ? gzipSync(new TextEncoder().encode(body)) : new TextEncoder().encode(body);
  const out = new Uint8Array(4 + (sequence === undefined ? 0 : 4) + 4 + payload.byteLength);
  out[0] = 0x11;
  out[1] = (MESSAGE_FULL_SERVER_RESPONSE << 4) | flags;
  out[2] = 0x10 | (gzip ? 0x01 : 0x00);
  out[3] = 0x00;
  let offset = 4;
  if (sequence !== undefined) {
    new DataView(out.buffer).setInt32(offset, sequence);
    offset += 4;
  }
  new DataView(out.buffer).setUint32(offset, payload.byteLength);
  out.set(payload, offset + 4);
  return out;
}

{
  const mid = parseServerFrame(serverFrame('{"result":{"text":"a"}}', 0b0001, 2));
  assert.ok(!('errorCode' in mid));
  assert.equal(mid.sequence, 2);
  assert.equal(isLastResponse(mid), false);
  assert.equal(JSON.parse(new TextDecoder().decode(mid.payload)).result.text, 'a');

  const last = parseServerFrame(serverFrame('{"result":{"text":"ab"}}', 0b0011, -3));
  assert.ok(!('errorCode' in last));
  assert.equal(last.sequence, -3);
  assert.equal(isLastResponse(last), true, '负序号 = 最终结果');

  const plain = parseServerFrame(serverFrame('{"result":{"text":"p"}}', 0b0001, 4, false));
  assert.ok(!('errorCode' in plain));
  assert.equal(JSON.parse(new TextDecoder().decode(plain.payload)).result.text, 'p', '未压缩响应也要能解析');
}

{
  const message = new TextEncoder().encode('invalid payload');
  const out = new Uint8Array(4 + 4 + 4 + message.byteLength);
  out[0] = 0x11;
  out[1] = (0b1111 << 4) | 0x00;
  out[2] = 0x10;
  new DataView(out.buffer).setInt32(4, 45000001);
  new DataView(out.buffer).setUint32(8, message.byteLength);
  out.set(message, 12);
  const parsed = parseServerFrame(out);
  assert.ok('errorCode' in parsed);
  assert.equal(parsed.errorCode, 45000001);
  assert.equal(parsed.message, 'invalid payload');
}

// ── 请求参数 ──────────────────────────────────────────────────────────────
assert.equal(volcengineLanguage('zh'), 'zh-CN');
assert.equal(volcengineLanguage('zh-TW'), 'zh-CN');
assert.equal(volcengineLanguage('en'), 'en-US');
assert.equal(volcengineLanguage('ja'), 'ja-JP');
assert.equal(volcengineLanguage('auto'), undefined, 'auto 时交给服务端检测');
assert.equal(volcengineLanguage(''), undefined);

{
  const zh = clientRequestPayload('zh', true) as {
    audio: Record<string, unknown>;
    request: Record<string, unknown>;
  };
  assert.equal(zh.audio.format, 'wav', '官方 demo 走 wav 容器');
  assert.equal(zh.audio.rate, 16000);
  assert.equal(zh.audio.bits, 16);
  assert.equal(zh.audio.channel, 1);
  assert.equal(zh.audio.language, 'zh-CN');
  assert.equal(zh.request.model_name, 'bigmodel');
  assert.equal(zh.request.show_utterances, true, '词级时间戳依赖 show_utterances');
  assert.equal(zh.request.enable_speaker_info, true, 'zh-CN 可以开说话人分离');

  const en = clientRequestPayload('en', true) as { request: Record<string, unknown> };
  assert.equal(en.request.enable_speaker_info, undefined, '非中文语种不支持说话人分离');
}

{
  const fresh = requestHeaders({ apiKey: 'k-1', appId: '', accessToken: '', resourceId: '' });
  assert.equal(fresh['X-Api-Key'], 'k-1');
  assert.equal(fresh['X-Api-Resource-Id'], 'volc.seedasr.sauc.duration');
  assert.equal(fresh['X-Api-Sequence'], '-1');
  assert.ok(fresh['X-Api-Request-Id']);
  assert.ok(fresh['X-Api-Connect-Id']);

  const legacy = requestHeaders({ apiKey: '', appId: 'app-1', accessToken: 'tok-1', resourceId: 'volc.bigasr.sauc.duration' });
  assert.equal(legacy['X-Api-App-Key'], 'app-1');
  assert.equal(legacy['X-Api-Access-Key'], 'tok-1');
  assert.equal(legacy['X-Api-Key'], undefined);
  assert.equal(legacy['X-Api-Resource-Id'], 'volc.bigasr.sauc.duration');
}

// ── 分片与 WAV 封装 ───────────────────────────────────────────────────────
{
  const bytes = 16_000 * 2 * 3 + 400; // 3.2 秒
  const segments = splitPcm(new Uint8Array(bytes), 1);
  assert.equal(segments.length, 4);
  assert.deepEqual(segments.map((s) => s.offsetMs), [0, 1000, 2000, 3000]);
  assert.deepEqual(segments.map((s) => s.pcm.byteLength), [32000, 32000, 32000, 400]);

  const wav = wavContainer(segments[0]!.pcm);
  assert.equal(new TextDecoder().decode(wav.subarray(0, 4)), 'RIFF');
  assert.equal(new TextDecoder().decode(wav.subarray(8, 12)), 'WAVE');
  assert.equal(new DataView(wav.buffer).getUint32(24, true), 16000);
  assert.equal(new DataView(wav.buffer).getUint16(34, true), 16);
  assert.equal(new DataView(wav.buffer).getUint32(40, true), 32000);
  assert.equal(wav.byteLength, 44 + 32000);
}

// ── 端到端（假 socket） ───────────────────────────────────────────────────
class FakeSocket implements VolcengineSocket {
  binaryType = '';
  readonly sent: Uint8Array[] = [];
  private listeners = new Map<string, Array<(event: unknown) => void>>();
  constructor(private readonly respond: (socket: FakeSocket) => void) {}

  send(data: Uint8Array): void {
    this.sent.push(data);
    // 收到最后一包（flags 0b0011）后返回最终结果，模拟真实服务的时序。
    if ((data[1]! & 0x0f) === FLAG_NEG_WITH_SEQUENCE) queueMicrotask(() => this.respond(this));
  }
  close(): void { this.emit('close', {}); }
  addEventListener(type: string, listener: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }
  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  open(): void { queueMicrotask(() => this.emit('open', {})); }
}

function finalResultBody(text: string, speaker?: string): string {
  return JSON.stringify({
    result: {
      text,
      utterances: [{
        text, start_time: 0, end_time: 500, ...(speaker ? { speaker } : {}),
        words: [
          { text: '你', start_time: 0, end_time: 200 },
          { text: '好', start_time: 200, end_time: 500 },
        ],
      }],
    },
  });
}

{
  const sockets: FakeSocket[] = [];
  const result = await transcribeWithVolcengine(
    new Uint8Array(10),
    {
      language: 'zh',
      diarize: true,
      config: { apiKey: 'k-1', appId: '', accessToken: '', resourceId: '' },
    },
    {
      decode: async () => new Uint8Array(16_000 * 2 * 1.5), // 1.5 秒 PCM
      socketFactory: () => {
        const socket = new FakeSocket((self) => {
          self.emit('message', { data: serverFrame(finalResultBody('你好', '1'), 0b0011, -2).buffer });
        });
        sockets.push(socket);
        socket.open();
        return socket;
      },
    },
  );

  assert.equal(sockets.length, 1, '1.5 秒音频只需一个会话');
  const [full, ...rest] = sockets[0]!.sent;
  assert.deepEqual([...full!.slice(0, 4)], [0x11, 0x11, 0x11, 0x00], '先发 full client request');
  const requestBody = JSON.parse(new TextDecoder().decode(gunzipSync(full!.subarray(12)))) as {
    audio: Record<string, unknown>; request: Record<string, unknown>;
  };
  assert.equal(requestBody.audio.format, 'wav');
  assert.equal(requestBody.audio.language, 'zh-CN');
  const last = rest.at(-1)!;
  assert.equal(last[1]! & 0x0f, FLAG_NEG_WITH_SEQUENCE, '最后发送负包');
  assert.ok(new DataView(last.buffer).getInt32(4) < 0, '负包序号为负');

  assert.equal(result.text, '你好');
  assert.deepEqual(result.words.map((w) => [w.text, w.start, w.end]), [['你', 0, 200], ['好', 200, 500]]);
  assert.equal(result.utterances.length, 1);
  assert.equal(result.utterances[0]!.speaker, '1');
}

// 多分片：第二段的词级时间戳必须带上偏移。
{
  let index = 0;
  const result = await transcribeWithVolcengine(
    new Uint8Array(10),
    {
      language: 'zh',
      diarize: false,
      config: { apiKey: 'k-1', appId: '', accessToken: '', resourceId: '' },
    },
    {
      decode: async () => new Uint8Array(16_000 * 2 * 1200), // 20 分钟 -> 2 段
      socketFactory: () => {
        const current = index++;
        const socket = new FakeSocket((self) => {
          const body = JSON.stringify({
            result: {
              text: `段${current}`,
              utterances: [{
                text: `段${current}`, start_time: 100, end_time: 600,
                words: [{ text: `段${current}`, start_time: 100, end_time: 600 }],
              }],
            },
          });
          self.emit('message', { data: serverFrame(body, 0b0011, -2).buffer });
        });
        socket.open();
        return socket;
      },
    },
  );
  assert.equal(result.words.length, 2);
  assert.equal(result.words[0]!.start, 100);
  assert.equal(result.words[1]!.start, 600_000 + 100, '第二段偏移 10 分钟');
  assert.equal(result.text, '段0\n段1');
  assert.deepEqual(result.utterances, [], '未开说话人分离时不产出 utterances');
}

// 未配置 Key 时在发起网络请求前就失败。
await assert.rejects(
  transcribeWithVolcengine(new Uint8Array(4), {
    language: 'zh',
    diarize: false,
    config: { apiKey: '', appId: '', accessToken: '', resourceId: '' },
  }),
  /API Key 未配置/,
);

// ── 真实 WebSocket 传输（本地最小 WS 服务端） ─────────────────────────────
// 前面的假 socket 只验证编排；这里让 undici 的 WebSocket 真正连一次，确认
// 自定义 header、gzip 帧和负包在传输层也成立。
{
  const { createServer } = await import('node:http');
  const { createHash } = await import('node:crypto');
  const seenHeaders: Record<string, string> = {};
  const seenFrames: Array<{ flags: number; body: Uint8Array }> = [];
  let lastSequence = 0;

  const accept = (key: string): string => createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');

  const server = createServer();
  server.on('upgrade', (req, socket) => {
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') seenHeaders[name] = value;
    }
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept(String(req.headers['sec-websocket-key'] ?? ''))}`,
      '', '',
    ].join('\r\n'));

    let buffer = Buffer.alloc(0);
    const sendFrame = (payload: Uint8Array): void => {
      const length = payload.byteLength;
      const head = length < 126
        ? Buffer.from([0x82, length])
        : Buffer.from([0x82, 126, (length >> 8) & 0xff, length & 0xff]);
      socket.write(Buffer.concat([head, Buffer.from(payload)]));
    };
    const respondFinal = (): void => {
      const body = gzipSync(new TextEncoder().encode(JSON.stringify({
        result: {
          text: '真实传输',
          utterances: [{
            text: '真实传输', start_time: 0, end_time: 800,
            words: [{ text: '真实传输', start_time: 0, end_time: 800 }],
          }],
        },
      })));
      const out = new Uint8Array(4 + 4 + 4 + body.byteLength);
      out[0] = 0x11;
      out[1] = (MESSAGE_FULL_SERVER_RESPONSE << 4) | 0b0011;
      out[2] = 0x11; // JSON + gzip
      new DataView(out.buffer).setInt32(4, lastSequence);
      new DataView(out.buffer).setUint32(8, body.byteLength);
      out.set(body, 12);
      sendFrame(out);
    };

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0]! & 0x0f;
        if (opcode === 0x8) { socket.end(); return; } // close
        const masked = (buffer[1]! & 0x80) !== 0;
        let length = buffer[1]! & 0x7f;
        let offset = 2;
        if (length === 126) { length = buffer.readUInt16BE(2); offset = 4; }
        else if (length === 127) { length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
        const maskKey = masked ? buffer.subarray(offset, offset + 4) : null;
        if (masked) offset += 4;
        if (buffer.length < offset + length) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        if (maskKey) for (let i = 0; i < payload.length; i += 1) payload[i]! ^= maskKey[i % 4]!;
        buffer = buffer.subarray(offset + length);

        const header = payload.subarray(0, 4);
        const messageFlags = header[1]! & 0x0f;
        const sequence = new DataView(payload.buffer, payload.byteOffset).getInt32(4);
        const size = new DataView(payload.buffer, payload.byteOffset).getUint32(8);
        const body = gunzipSync(payload.subarray(12, 12 + size));
        seenFrames.push({ flags: messageFlags, body: new Uint8Array(body) });
        if (messageFlags === FLAG_NEG_WITH_SEQUENCE) {
          lastSequence = sequence;
          respondFinal();
        }
      }
    });
    socket.on('error', () => undefined);
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });

  try {
    const result = await transcribeWithVolcengine(
      new Uint8Array(10),
      {
        language: 'zh',
        diarize: false,
        config: {
          apiKey: 'real-key', appId: '', accessToken: '', resourceId: '',
          wsUrl: `ws://127.0.0.1:${port}/api/v3/sauc/bigmodel_nostream`,
        },
      },
      { decode: async () => new Uint8Array(16_000 * 2 * 0.5) },
    );
    assert.equal(seenHeaders['x-api-key'], 'real-key', '鉴权头随握手送达');
    assert.equal(seenHeaders['x-api-resource-id'], 'volc.seedasr.sauc.duration');
    assert.equal(seenFrames[0]!.flags, FLAG_POS_SEQUENCE, '第一帧为正序号');
    assert.equal(JSON.parse(new TextDecoder().decode(seenFrames[0]!.body)).audio.format, 'wav');
    const audioFrames = seenFrames.slice(1);
    assert.ok(audioFrames.length >= 1, '至少发送一包音频');
    assert.ok(audioFrames.slice(0, -1).every((f) => f.flags === FLAG_POS_SEQUENCE), '音频帧均为正序号');
    assert.equal(audioFrames.at(-1)!.flags, FLAG_NEG_WITH_SEQUENCE, '最后一包为负包');
    assert.equal(result.text, '真实传输');
    assert.equal(result.words[0]!.text, '真实传输');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

console.log('volcengine-asr.verify: 协议帧 / 响应解析 / WAV 封装 / 分片合并 / 鉴权分支 / 真实 WS 传输 通过');
