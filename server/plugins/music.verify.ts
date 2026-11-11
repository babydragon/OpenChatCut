import assert from 'node:assert/strict';
import {
  IncompleteGenerationResultError,
  generationResultCheckpoint,
  setGenerationResultUrlAt,
  requireGenerationResultUrls,
} from './generation-jobs.ts';
import { expectedMusicResultCount, isMinimaxCoverModel, pickMurekaAudioUrl, validateMusicRequest } from './music.ts';
import { atlasRequestBody, generateAtlasMusic, parseAtlasPrediction } from './music-atlas.ts';
import { murekaRequestShape } from './music-mureka.ts';

assert.equal(pickMurekaAudioUrl({ choices: [{ audio_url: 'a' }] }), 'a');
assert.equal(pickMurekaAudioUrl({ choices: [{ url: 'u' }] }), 'u');

const mureka = validateMusicRequest({ prompt: 'calm piano bed' });
assert.equal(mureka.provider, 'mureka');
assert.equal(mureka.isInstrumental, true);
assert.equal(mureka.mode, 'instrumental');

const murekaSong = validateMusicRequest({
  provider: 'mureka', mode: 'song', lyrics: '[Verse]\nhello', prompt: 'indie folk', gender: 'female', count: 3,
});
assert.equal(murekaSong.count, 3);
assert.equal(murekaSong.gender, 'female');
assert.equal(murekaRequestShape(murekaSong, 'auto').endpoint, '/v1/song/generate');
assert.equal(expectedMusicResultCount(mureka), 1);
assert.equal(expectedMusicResultCount(murekaSong), 3);
assert.equal(expectedMusicResultCount({ provider: 'minimax', count: 3 }), 1);
assert.equal(expectedMusicResultCount({ provider: 'atlas', count: 3 }), 1);
assert.deepEqual(
  generationResultCheckpoint(['https://cdn/audio-1.mp3'], 3, 'mureka-task'),
  { urls: ['https://cdn/audio-1.mp3'], complete: false },
);
assert.deepEqual(
  generationResultCheckpoint(['https://cdn/audio-1.mp3', 'https://cdn/audio-2.mp3'], 3, 'mureka-task'),
  { urls: ['https://cdn/audio-1.mp3', 'https://cdn/audio-2.mp3'], complete: false },
);
assert.throws(
  () => generationResultCheckpoint(['https://cdn/audio-1.mp3'], 3),
  (error) => error instanceof IncompleteGenerationResultError && error.retryable,
);
const providerMurekaUrls = [
  'https://cdn/new-audio-1.mp3',
  'https://cdn/new-audio-2.mp3',
  'https://cdn/new-audio-3.mp3',
];
let afterFirstMurekaCheckpoint = ['https://cdn/old-audio-1.mp3'];
for (const [index, url] of providerMurekaUrls.entries()) {
  afterFirstMurekaCheckpoint = setGenerationResultUrlAt(afterFirstMurekaCheckpoint, index, url);
}
assert.deepEqual(
  requireGenerationResultUrls(afterFirstMurekaCheckpoint, 3),
  providerMurekaUrls,
  'Mureka recovery after the first checkpoint must replace stale signed URLs and restore all three results',
);
let afterSecondMurekaCheckpoint = [
  'https://cdn/old-audio-1.mp3',
  'https://cdn/old-audio-2.mp3',
];
for (const [index, url] of providerMurekaUrls.entries()) {
  afterSecondMurekaCheckpoint = setGenerationResultUrlAt(afterSecondMurekaCheckpoint, index, url);
}
assert.deepEqual(
  requireGenerationResultUrls(afterSecondMurekaCheckpoint, 3),
  providerMurekaUrls,
  'Mureka recovery after the second checkpoint must replace the authoritative ordered result set',
);
assert.deepEqual(
  setGenerationResultUrlAt(afterSecondMurekaCheckpoint, 2, providerMurekaUrls[2]),
  afterSecondMurekaCheckpoint,
  'repeating a Mureka resume checkpoint must be idempotent',
);

const promptSong = validateMusicRequest({ provider: 'mureka', mode: 'prompt-song', styles: ['pop', 'j-pop'] });
assert.deepEqual(promptSong.styles, ['pop', 'j-pop']);
assert.equal(murekaRequestShape(promptSong, 'auto').endpoint, '/v1/song/easy-generate');

const soundtrack = validateMusicRequest({
  provider: 'mureka', mode: 'soundtrack', sourceAssetPath: '/media/uploads/shot.mp4',
  sourceAssetKind: 'video', audioStartMs: 1_000, audioEndMs: 4_000,
});
assert.equal(soundtrack.mode, 'soundtrack');
const soundtrackRequest = murekaRequestShape(soundtrack, 'auto', 'uploaded-video');
assert.equal(soundtrackRequest.endpoint, '/v1/soundtrack/generate');
assert.equal(soundtrackRequest.body.video_id, 'uploaded-video');

const track = validateMusicRequest({
  provider: 'mureka', mode: 'track', songId: 'song-1', trackType: 'Vocals',
  prompt: 'warm lead vocal', vocalGender: 'male', lyrics: 'hello',
});
assert.equal(track.trackType, 'Vocals');
assert.equal(murekaRequestShape(track, 'auto').endpoint, '/v1/track/generate');
assert.equal(murekaRequestShape(mureka, 'auto').endpoint, '/v1/instrumental/generate');

const mmInst = validateMusicRequest({ provider: 'minimax', prompt: 'lofi chill' });
assert.equal(mmInst.isInstrumental, true);
assert.equal(mmInst.lyricsOptimizer, false);

const mmLyrics = validateMusicRequest({
  provider: 'minimax',
  prompt: 'indie folk',
  lyrics: '[Verse]\nhello',
});
assert.equal(mmLyrics.isInstrumental, false);
assert.equal(mmLyrics.lyrics, '[Verse]\nhello');

const mmAuto = validateMusicRequest({
  provider: 'minimax',
  prompt: 'rainy night pop',
  lyricsOptimizer: true,
});
assert.equal(mmAuto.isInstrumental, false);
assert.equal(mmAuto.lyricsOptimizer, true);

const mmAudio = validateMusicRequest({
  provider: 'minimax',
  prompt: 'orchestral',
  sampleRate: 32_000,
  bitrate: 128_000,
  audioFormat: 'wav',
});
assert.equal(mmAudio.sampleRate, 32_000);
assert.equal(mmAudio.audioFormat, 'wav');

// minimax prompt can be longer than 1024
validateMusicRequest({ provider: 'minimax', prompt: 'x'.repeat(1500) });

const atlas = validateMusicRequest({
  provider: 'atlas', prompt: 'Warm documentary underscore', lyrics: '[Verse]\nQuiet city lights',
  sampleRate: 32_000, bitrate: 128_000, audioFormat: 'wav',
});
assert.equal(atlas.mode, 't2m');
assert.equal(atlas.isInstrumental, false);
assert.deepEqual(atlasRequestBody(atlas, 'minimax/music-2.6'), {
  model: 'minimax/music-2.6',
  prompt: 'Warm documentary underscore',
  lyrics: '[Verse]\nQuiet city lights',
  is_instrumental: false,
  format: 'wav',
  sample_rate: 32_000,
  bitrate: 128_000,
});
assert.deepEqual(
  parseAtlasPrediction({ code: 200, data: { id: 'pred-1', status: 'processing' } }),
  { id: 'pred-1', status: 'processing' },
);
assert.throws(() => parseAtlasPrediction({ code: 401, message: 'unauthorized' }), /unauthorized/);
assert.throws(() => validateMusicRequest({ provider: 'atlas', mode: 'cover', prompt: 'cover me' }), /mode must be t2m/);
assert.throws(
  () => validateMusicRequest({ provider: 'atlas', prompt: 'song', lyricsOptimizer: true }),
  /not supported by atlas/,
);
assert.throws(
  () => validateMusicRequest({ provider: 'atlas', prompt: 'song', lyrics: 'words', isInstrumental: true }),
  /cannot be combined with lyrics/,
);

const originalFetch = globalThis.fetch;
let atlasPosts = 0;
let atlasGets = 0;
let acceptedAtlasTask = '';
globalThis.fetch = async (_input, init) => {
  if (init?.method === 'POST') {
    atlasPosts += 1;
    return new Response(JSON.stringify({ code: 200, data: { id: 'pred-1', status: 'processing' } }));
  }
  atlasGets += 1;
  return new Response(JSON.stringify({
    code: 200,
    data: { id: 'pred-1', status: 'completed', outputs: ['https://cdn/audio.mp3'] },
  }));
};
try {
  const atlasOptions = {
    baseUrl: '', apiKey: '', model: '', minimaxBaseUrl: '', minimaxApiKey: '', minimaxModel: '',
    atlasBaseUrl: 'https://api.atlascloud.ai/api/v1', atlasApiKey: 'test-key', atlasModel: 'minimax/music-2.6',
  };
  assert.deepEqual(
    await generateAtlasMusic(atlasOptions, atlas, async (taskId) => { acceptedAtlasTask = taskId; }),
    ['https://cdn/audio.mp3'],
  );
  assert.equal(acceptedAtlasTask, 'pred-1');
  assert.equal(atlasPosts, 1, 'fresh Atlas generation submits exactly once');
  assert.equal(atlasGets, 1);
  assert.deepEqual(
    await generateAtlasMusic(atlasOptions, atlas, async () => assert.fail('resumed Atlas job must not register a new task'), 'pred-1'),
    ['https://cdn/audio.mp3'],
  );
  assert.equal(atlasPosts, 1, 'resumed Atlas generation must not submit again');
  assert.equal(atlasGets, 2);
} finally {
  globalThis.fetch = originalFetch;
}

assert.throws(() => validateMusicRequest({ provider: 'mureka', mode: 'song', prompt: 'x' }), /requires lyrics/);
assert.throws(
  () => validateMusicRequest({ provider: 'mureka', mode: 'soundtrack', sourceAssetPath: '/media/uploads/a.mp3', sourceAssetKind: 'audio' }),
  /image or video/,
);
assert.throws(
  () => validateMusicRequest({ provider: 'mureka', mode: 'track', songId: 's', trackType: 'Drums', prompt: 'drums', vocalGender: 'male' }),
  /Vocals trackType only/,
);
assert.throws(
  () => validateMusicRequest({ provider: 'minimax', prompt: 'x', isInstrumental: false }),
  /require lyrics/,
);
assert.throws(
  () => validateMusicRequest({ provider: 'minimax', prompt: 'x', lyrics: 'hi', isInstrumental: true }),
  /cannot be combined with lyrics/,
);
assert.throws(
  () => validateMusicRequest({ provider: 'minimax', prompt: 'x', sampleRate: 48_000 }),
  /sampleRate must be/,
);
assert.throws(
  () => validateMusicRequest({ provider: 'minimax', prompt: 'x', stream: true }),
  /Mureka generation controls/,
);
assert.throws(
  () => validateMusicRequest({ provider: 'mureka', prompt: 'x', bitrate: 128_000 }),
  /MiniMax-only controls/,
);
assert.throws(
  () => validateMusicRequest({ provider: 'minimax', prompt: 'x'.repeat(2001) }),
  /at most 2000/,
);

// music-cover
assert.equal(isMinimaxCoverModel('music-cover'), true);
assert.equal(isMinimaxCoverModel('music-cover-free'), true);
assert.equal(isMinimaxCoverModel('music-2.6'), false);

const cover = validateMusicRequest({
  provider: 'minimax',
  prompt: 'Jazz piano cover, soft and intimate',
  referenceAudioPath: '/media/uploads/source.mp3',
});
assert.equal(cover.coverMode, true);
assert.equal(cover.referenceAudioPath, '/media/uploads/source.mp3');

assert.throws(
  () => validateMusicRequest({
    provider: 'minimax',
    prompt: 'short',
    referenceAudioPath: '/media/uploads/source.mp3',
  }),
  /10–300 characters/,
);
assert.throws(
  () => validateMusicRequest({
    provider: 'mureka',
    prompt: 'Jazz piano cover style',
    referenceAudioPath: '/media/uploads/source.mp3',
  }),
  /MiniMax-only controls/,
);
assert.throws(
  () => validateMusicRequest({
    provider: 'minimax',
    prompt: 'Jazz piano cover, soft and intimate',
    referenceAudioPath: '/media/uploads/source.mp3',
    isInstrumental: true,
  }),
  /not used for music-cover/,
);

const coverFeature = validateMusicRequest({
  provider: 'minimax', mode: 'cover', prompt: 'Warm acoustic cover with close vocals',
  coverFeatureId: 'feature-1', lyrics: 'ten letters or more',
});
assert.equal(coverFeature.coverFeatureId, 'feature-1');

console.log('music.check: ok (Mureka, MiniMax, and Atlas Cloud modes)');

// ── ePhone: Mureka 统一异步任务接口 ─────────────────────────────────────
// ePhone 把 Mureka 暴露成 submit + poll；模型 id 带斜杠时走这条通道。
{
  const { createServer } = await import('node:http');
  const { generateMureka, isEphoneTaskModel } = await import('./music-mureka.ts');

  assert.equal(isEphoneTaskModel('mureka-9/instrumental'), true);
  assert.equal(isEphoneTaskModel('mureka-9.5/song'), true);
  assert.equal(isEphoneTaskModel('mureka-o2/song'), true);
  assert.equal(isEphoneTaskModel('mureka-9'), false, '原生 Mureka 模型不带斜杠');
  assert.equal(isEphoneTaskModel('auto'), false);

  const submitted: unknown[] = [];
  let polls = 0;
  const mock = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'POST' && req.url === '/v1/task/submit') {
      submitted.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.end(JSON.stringify({ id: 'task_1', status: 'queued' }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/task/task_1') {
      polls += 1;
      res.end(JSON.stringify(polls === 1
        ? { id: 'task_1', status: 'in_progress' }
        : { id: 'task_1', status: 'completed', outputs: [{ url: 'https://cdn.example/bgm.mp3' }] }));
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/task/bad') {
      res.end(JSON.stringify({ id: 'bad', status: 'failed', error: { message: 'quota exceeded' } }));
      return;
    }
    res.statusCode = 404;
    res.end('{}');
  });
  const port = await new Promise<number>((resolve) => {
    mock.listen(0, '127.0.0.1', () => {
      const address = mock.address();
      resolve(typeof address === 'object' && address ? address.port : 0);
    });
  });
  const options = {
    baseUrl: `http://127.0.0.1:${port}`, apiKey: 'ephone-key', model: 'mureka-9/instrumental',
    minimaxBaseUrl: '', minimaxApiKey: '', minimaxModel: '',
    atlasBaseUrl: '', atlasApiKey: '', atlasModel: '',
    soniloBaseUrl: '', soniloApiKey: '',
  };
  try {
    const request = validateMusicRequest({ provider: 'mureka', prompt: 'calm piano bed', count: 1 });
    const taskIds: string[] = [];
    const urls = await generateMureka(options, request, async (id) => { taskIds.push(id); });
    assert.deepEqual(urls, ['https://cdn.example/bgm.mp3']);
    assert.deepEqual(taskIds, ['task_1']);
    assert.deepEqual(submitted, [{
      model: 'mureka-9/instrumental',
      input: { n: 1, prompt: 'calm piano bed' },
    }], 'ePhone 提交体：模型 + input，n 取用户数量');
    assert.ok(polls >= 2, '必须轮询到 completed 才返回');

    // 断点续跑：已有 task id 时不再提交，只轮询
    const resumed = await generateMureka(options, request, async () => { throw new Error('must not resubmit'); }, 'task_1');
    assert.deepEqual(resumed, ['https://cdn.example/bgm.mp3']);

    // 失败任务把上游原因带出来
    await assert.rejects(
      generateMureka(options, request, async () => undefined, 'bad'),
      /quota exceeded/,
    );
  } finally {
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  }
  console.log('music.check: ePhone Mureka task API ok');
}
