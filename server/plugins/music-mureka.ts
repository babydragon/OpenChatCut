import { proxyDispatcher } from '../outbound-proxy.ts';
import { musicProviderError, uploadMurekaFile } from './music-media.ts';
import type { MurekaChoice, MurekaTask, MusicAudioFormat, MusicOptions, ValidMusicRequest } from './music-types.ts';
// Proxy-aware fetch: attaches the configured outbound proxy (keystore
// PROXY_URL or HTTPS_PROXY/HTTP_PROXY env) via undici dispatcher.
type FetchInit = Parameters<typeof fetch>[1] & { dispatcher?: unknown };
const fetchWithProxy = (url: RequestInfo | URL, init?: FetchInit): Promise<Response> =>
  fetch(url, { ...init, dispatcher: proxyDispatcher() } as RequestInit);


const TERMINAL_FAILURES = new Set(['failed', 'timeouted', 'cancelled']);
const wait = (milliseconds: number) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

function choiceUrl(choice: MurekaChoice | undefined, format: MusicAudioFormat): string | undefined {
  if (format === 'flac') return choice?.flac_url ?? choice?.wav_url ?? choice?.url ?? choice?.audio_url;
  if (format === 'wav') return choice?.wav_url ?? choice?.flac_url ?? choice?.url ?? choice?.audio_url;
  return choice?.audio_url ?? choice?.url ?? choice?.wav_url ?? choice?.flac_url;
}

export function pickMurekaAudioUrl(task: MurekaTask, format: MusicAudioFormat = 'mp3'): string | undefined {
  return choiceUrl(task.choices?.[0], format);
}

export function pickMurekaAudioUrls(task: MurekaTask, format: MusicAudioFormat): string[] {
  return (task.choices ?? []).map((choice) => choiceUrl(choice, format)).filter((url): url is string => Boolean(url));
}

// ── ePhone AI: Mureka 统一异步任务接口 ────────────────────────────────────
// ePhone 把 Mureka 暴露成 POST /v1/task/submit + GET /v1/task/:id，模型 id 形如
// `mureka-9/instrumental`。原生 Mureka 的模型 id 不带斜杠，所以用模型 id 判断
// 走哪套协议：这样设置页不用新增厂商，Base URL 指到 ePhone、模型填
// `mureka-9/instrumental` 即可。
const EPHONE_TASK_MODEL = /^mureka-(?:[\d.]+|o\d+)\//i;

export function isEphoneTaskModel(model: string): boolean {
  return EPHONE_TASK_MODEL.test(model.trim());
}

function ephoneInput(input: ValidMusicRequest): Record<string, unknown> {
  const n = Math.min(3, Math.max(1, Math.round(input.count || 1)));
  if (input.mode === 'instrumental') {
    return {
      n,
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.instrumentalId ? { reference_id: input.instrumentalId } : {}),
    };
  }
  if (input.mode === 'prompt-song') {
    return {
      n,
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.styles?.length ? { styles: input.styles } : {}),
      ...(input.referenceId ? { reference_id: input.referenceId } : {}),
      ...(input.vocalId ? { vocal_id: input.vocalId } : {}),
    };
  }
  if (input.mode === 'song') {
    return {
      n,
      ...(input.lyrics ? { lyrics: input.lyrics } : {}),
      ...(input.prompt ? { prompt: input.prompt } : {}),
      ...(input.gender ? { gender: input.gender } : {}),
      ...(input.referenceId ? { reference_id: input.referenceId } : {}),
      ...(input.vocalId ? { vocal_id: input.vocalId } : {}),
      ...(input.melodyId ? { melody_id: input.melodyId } : {}),
    };
  }
  throw new Error(`ePhone 的 Mureka 通道暂不支持 ${input.mode}（只支持 instrumental / song / prompt-song）`);
}

function ephoneOutputUrls(task: unknown): string[] {
  const value = task && typeof task === 'object' ? task as Record<string, unknown> : {};
  const data = value.data && typeof value.data === 'object' ? value.data as Record<string, unknown> : value;
  const outputs = data.outputs ?? (data.result as Record<string, unknown> | undefined)?.outputs
    ?? data.audio_urls ?? data.urls;
  const urls: string[] = [];
  const push = (item: unknown): void => {
    if (typeof item === 'string' && /^https?:\/\//i.test(item)) { urls.push(item); return; }
    if (!item || typeof item !== 'object') return;
    const record = item as Record<string, unknown>;
    for (const key of ['url', 'audio_url', 'wav_url', 'flac_url', 'src']) {
      const candidate = record[key];
      if (typeof candidate === 'string' && candidate) { urls.push(candidate); return; }
    }
  };
  if (Array.isArray(outputs)) outputs.forEach(push);
  else push(outputs);
  return [...new Set(urls)];
}

async function ephoneTask(baseUrl: string, apiKey: string, id: string): Promise<Record<string, unknown>> {
  const response = await fetchWithProxy(`${baseUrl}/v1/task/${encodeURIComponent(id)}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(await musicProviderError(response));
  const body = await response.json() as Record<string, unknown>;
  const data = body.data;
  return data && typeof data === 'object' ? data as Record<string, unknown> : body;
}

async function generateEphoneMusic(
  options: MusicOptions,
  input: ValidMusicRequest,
  onTaskAccepted: (taskId: string) => Promise<void>,
  existingTaskId?: string,
): Promise<string[]> {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  let id = existingTaskId ?? '';
  if (!id) {
    const response = await fetchWithProxy(`${baseUrl}/v1/task/submit`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: options.model, input: ephoneInput(input) }),
    });
    if (!response.ok) throw new Error(await musicProviderError(response));
    const body = await response.json() as Record<string, unknown>;
    const data = body.data && typeof body.data === 'object' ? body.data as Record<string, unknown> : body;
    id = String(data.id ?? data.task_id ?? '').trim();
    if (!id) throw new Error('ePhone did not return a task id');
    await onTaskAccepted(id);
  }
  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const task = await ephoneTask(baseUrl, options.apiKey, id);
    const status = String(task.status ?? '').toLowerCase();
    if (status === 'completed' || status === 'succeeded' || status === 'success') {
      const urls = ephoneOutputUrls(task);
      if (!urls.length) throw new Error('ePhone succeeded without audio outputs');
      return urls;
    }
    if (status === 'failed' || status === 'error' || status === 'canceled' || status === 'cancelled') {
      const error = task.error;
      const message = typeof error === 'string' ? error
        : error && typeof error === 'object' ? String((error as Record<string, unknown>).message ?? '') : '';
      throw new Error(message || `ePhone task ${status}`);
    }
    await wait(2_000);
  }
  throw new Error('ePhone music generation timed out');
}


async function fetchTask(url: string, apiKey: string): Promise<MurekaTask> {
  const response = await fetchWithProxy(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(await musicProviderError(response));
  return response.json() as Promise<MurekaTask>;
}

async function awaitChoices(baseUrl: string, apiKey: string, initial: MurekaTask, queryKind: 'instrumental' | 'song'): Promise<MurekaTask> {
  if (!initial.id) throw new Error('Mureka did not return a task id');
  const deadline = Date.now() + 10 * 60_000;
  let task = initial;
  while (Date.now() < deadline) {
    if (task.status === 'succeeded') {
      if (!task.choices?.length) throw new Error('Mureka succeeded without audio choices');
      return task;
    }
    if (task.status && TERMINAL_FAILURES.has(task.status)) throw new Error(task.failed_reason || `Mureka generation ${task.status}`);
    await wait(2_000);
    task = await fetchTask(`${baseUrl}/v1/${queryKind}/query/${encodeURIComponent(initial.id)}`, apiKey);
  }
  throw new Error('Mureka generation timed out');
}

async function sourceId(baseUrl: string, apiKey: string, input: ValidMusicRequest): Promise<string | undefined> {
  if (!input.sourceAssetPath) return undefined;
  return uploadMurekaFile(baseUrl, apiKey, input.sourceAssetPath, input.mode === 'soundtrack' ? 'soundtrack' : 'audio');
}

export function murekaRequestShape(
  input: ValidMusicRequest,
  model: string,
  uploadedId?: string,
): { endpoint: string; query: 'instrumental' | 'song'; body: Record<string, unknown> } {
  if (input.mode === 'instrumental') return {
    endpoint: '/v1/instrumental/generate', query: 'instrumental',
    body: { model, n: input.count, prompt: input.prompt || undefined, instrumental_id: input.instrumentalId, stream: input.stream },
  };
  if (input.mode === 'song') return {
    endpoint: '/v1/song/generate', query: 'song',
    body: { model, n: input.count, lyrics: input.lyrics, prompt: input.prompt || undefined, gender: input.gender,
      reference_id: input.referenceId, vocal_id: input.vocalId, melody_id: input.melodyId, stream: input.stream },
  };
  if (input.mode === 'prompt-song') return {
    endpoint: '/v1/song/easy-generate', query: 'song',
    body: { model, n: input.count, styles: input.styles, prompt: input.prompt || undefined,
      reference_id: input.referenceId, vocal_id: input.vocalId, stream: input.stream },
  };
  if (input.mode === 'soundtrack') return {
    endpoint: '/v1/soundtrack/generate', query: 'song',
    body: { model, n: input.count, prompt: input.prompt || undefined,
      ...(input.sourceAssetKind === 'image' ? { image_id: uploadedId } : { video_id: uploadedId }),
      audio_start: input.audioStartMs, audio_end: input.audioEndMs },
  };
  return {
    endpoint: '/v1/track/generate', query: 'song',
    body: { song_id: input.songId, upload_audio_id: uploadedId, generate_type: input.trackType,
      generate_start: input.generateStartMs, generate_end: input.generateEndMs,
      lyrics: input.lyrics, prompt: input.prompt, vocal_gender: input.vocalGender },
  };
}

async function requestFor(input: ValidMusicRequest, options: MusicOptions) {
  const uploadedId = await sourceId(options.baseUrl.replace(/\/$/, ''), options.apiKey, input);
  return murekaRequestShape(input, options.model, uploadedId);
}


function checkModelCompatibility(model: string, input: ValidMusicRequest): void {
  if (!/mureka-o2/i.test(model)) return;
  if (input.mode === 'instrumental' || input.mode === 'soundtrack') throw new Error(`Mureka ${input.mode} does not support mureka-o2`);
  if (input.vocalId || input.melodyId) throw new Error('mureka-o2 does not support vocalId or melodyId');
}

export async function generateMureka(
  options: MusicOptions,
  input: ValidMusicRequest,
  onTaskAccepted: (taskId: string) => Promise<void>,
  existingTaskId?: string,
): Promise<string[]> {
  // ePhone 的模型 id 带斜杠（mureka-9/instrumental），走统一任务接口。
  if (isEphoneTaskModel(options.model)) {
    return generateEphoneMusic(options, input, onTaskAccepted, existingTaskId);
  }
  checkModelCompatibility(options.model, input);
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const query = input.mode === 'instrumental' ? 'instrumental' : 'song';
  let initial: MurekaTask;
  if (existingTaskId) {
    initial = await fetchTask(`${baseUrl}/v1/${query}/query/${encodeURIComponent(existingTaskId)}`, options.apiKey);
    initial.id ??= existingTaskId;
  } else {
    const request = await requestFor(input, options);
    const response = await fetchWithProxy(`${baseUrl}${request.endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(request.body),
    });
    if (!response.ok) throw new Error(await musicProviderError(response));
    initial = await response.json() as MurekaTask;
    if (!initial.id) throw new Error('Mureka did not return a task id');
    await onTaskAccepted(String(initial.id));
  }
  const task = await awaitChoices(baseUrl, options.apiKey, initial, query);
  const urls = pickMurekaAudioUrls(task, input.audioFormat);
  if (!urls.length) throw new Error(`Mureka returned no ${input.audioFormat} audio URL`);
  return urls;
}
