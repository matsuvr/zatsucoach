'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { chromium } = require('playwright-core');

function loadLocalSettings() {
  const file = path.join(__dirname, '..', 'api', 'local.settings.json');
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).Values || {};
  } catch {
    return {};
  }
}

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasArg(name) {
  const prefix = `--${name}=`;
  return process.argv.some((arg) => arg.startsWith(prefix));
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function printUsage() {
  console.log(`Usage: npm run smoke:conversation -- --audio=/path/to/local-audio.mp3 [options]

Required:
  --audio=/path/to/file.mp3

Common options:
  --advisor-url=https://example.azurestaticapps.net/api/advisor
  --token-url=https://example.azurestaticapps.net/api/realtime-token
  --deployment=gpt-realtime-2
  --advisor-deployment=grok-4-20-non-reasoning
  --chunk-seconds=4
  --max-chunks=4
  --headless=true`);
}

function boolArg(name, fallback = false) {
  const value = argValue(name, fallback ? 'true' : 'false');
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function endpointBase(endpoint) {
  return String(endpoint || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/api\/models$/i, '')
    .replace(/\/models$/i, '')
    .replace(/\/openai\/v1$/i, '')
    .replace(/\/openai$/i, '');
}

function requireValue(name, value) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeJsonText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return { text };
  }
}

function mp3ToWavDataUrl(audioPath, seconds) {
  const out = path.join(os.tmpdir(), `zatsucoach-conversation-${Date.now()}.wav`);
  const result = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-y', '-ss', '0', '-t', String(seconds),
    '-i', audioPath,
    '-ac', '1', '-ar', '24000',
    '-f', 'wav',
    out
  ], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${result.stderr || result.stdout}`);
  const wav = fs.readFileSync(out);
  fs.unlinkSync(out);
  return `data:audio/wav;base64,${wav.toString('base64')}`;
}

async function createRealtimeClientSecret({ endpoint, apiKey, deployment, tokenUrl, voice, chunkSeconds }) {
  if (tokenUrl) {
    const response = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        realtimeDeployment: deployment,
        voice,
        voiceSpeed: 1.25,
        vadSilenceMs: 650,
        vadThreshold: 0.55
      })
    });
    const text = await response.text();
    const data = text ? safeJsonText(text) : {};
    if (!response.ok) {
      throw new Error(data?.error || data?.message || text || `realtime token failed: ${response.status}`);
    }
    if (!data.token || !data.webrtcUrl) throw new Error('realtime-token response is missing token or webrtcUrl');
    return {
      token: data.token,
      webrtcUrl: data.webrtcUrl,
      deployment: data.deployment || deployment,
      endpointHost: data.endpointHost || null
    };
  }

  const response = await fetch(`${endpoint}/openai/v1/realtime/client_secrets`, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      expires_after: { anchor: 'created_at', seconds: 600 },
      session: {
        type: 'realtime',
        model: deployment
      }
    })
  });
  const text = await response.text();
  const data = text ? safeJsonText(text) : {};
  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || text || `client secret failed: ${response.status}`);
  }
  const token = data.value || data.client_secret?.value;
  if (!token) throw new Error('Realtime client secret response did not include value');
  return {
    token,
    webrtcUrl: `${endpoint}/openai/v1/realtime/calls`
  };
}

async function requestAdvisor({ advisorUrl, deployment, instructions, reasoningEffort, maxTokens, latest, transcript, retryMs, maxRetries }) {
  const attempts = [];
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const result = await requestAdvisorOnce({ advisorUrl, deployment, instructions, reasoningEffort, maxTokens, latest, transcript });
    attempts.push(result);
    if (result.ok || result.status !== 429 || attempt === maxRetries) {
      return attempts.length > 1 ? { ...result, retryAttempts: attempts } : result;
    }
    await new Promise((resolve) => setTimeout(resolve, retryMs));
  }
  return attempts[attempts.length - 1];
}

async function requestAdvisorOnce({ advisorUrl, deployment, instructions, reasoningEffort, maxTokens, latest, transcript }) {
  const response = await fetch(advisorUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      deployment,
      instructions,
      reasoningEffort,
      maxTokens,
      latest,
      transcript
    })
  });
  const text = await response.text();
  const data = text ? safeJsonText(text) : {};
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: data.error || data.text || response.statusText,
      retryAfterMs: data.retryAfterMs || 0,
      attempts: data.attempts || []
    };
  }
  return { ok: true, status: response.status, ...data };
}

async function deployedHealth(advisorUrl) {
  const url = new URL(advisorUrl);
  url.pathname = url.pathname.replace(/\/api\/advisor$/, '/api/health');
  url.search = '';
  const response = await fetch(url);
  if (!response.ok) return {};
  const text = await response.text();
  return text ? safeJsonText(text) : {};
}

async function main() {
  if (hasFlag('help') || hasFlag('h')) {
    printUsage();
    return;
  }

  const audioArg = argValue('audio', '');
  if (!audioArg) {
    throw new Error('audio file is required. Pass --audio=/path/to/local-audio.mp3');
  }

  const local = loadLocalSettings();
  const endpoint = endpointBase(argValue('endpoint', process.env.AZURE_OPENAI_ENDPOINT || local.AZURE_OPENAI_ENDPOINT));
  const apiKey = argValue('api-key', process.env.AZURE_OPENAI_API_KEY || local.AZURE_OPENAI_API_KEY);
  const realtimeDeployment = argValue('deployment', process.env.REALTIME_DEPLOYMENT || local.REALTIME_DEPLOYMENT || 'gpt-realtime-2');
  const advisorUrl = argValue('advisor-url', 'https://delightful-mud-0f16e3300.7.azurestaticapps.net/api/advisor');
  const tokenUrl = argValue('token-url', advisorUrl.replace(/\/api\/advisor$/, '/api/realtime-token'));
  const health = hasArg('advisor-deployment') ? {} : await deployedHealth(advisorUrl).catch(() => ({}));
  const advisorDeployment = argValue(
    'advisor-deployment',
    health.advisorDeployment || process.env.ADVISOR_DEPLOYMENT || local.ADVISOR_DEPLOYMENT || 'grok-4-20-non-reasoning'
  );
  const voice = argValue('voice', process.env.REALTIME_VOICE || local.REALTIME_VOICE || 'marin');
  const audioPath = path.resolve(audioArg);
  const chunkSeconds = Number(argValue('chunk-seconds', '4'));
  const maxChunks = Number(argValue('max-chunks', '4'));
  const timeoutMs = Number(argValue('timeout-ms', '90000'));
  const turnTimeoutMs = Number(argValue('turn-timeout-ms', '30000'));
  const advisorIntervalMs = Number(argValue('advisor-interval-ms', '3000'));
  const advisorRetryMs = Number(argValue('advisor-retry-ms', '15000'));
  const advisorMaxRetries = Number(argValue('advisor-max-retries', '1'));
  const advisorMaxTokens = Number(argValue('advisor-max-tokens', '2048'));
  const transcriptionDeployment = argValue('transcription-deployment', process.env.TRANSCRIPTION_DEPLOYMENT || local.TRANSCRIPTION_DEPLOYMENT || 'gpt-4o-mini-transcribe');
  const headless = boolArg('headless', true);
  const humanLog = boolArg('human-log', true);
  const strictAdvisor = boolArg('strict-advisor', true);
  const advisorInstructions = argValue('advisor-instructions', `あなたは会話練習のリアルタイム助言AIです。Realtimeのユーザー発話文字起こし、アバター応答、会話履歴から、直前の会話状態を推定して助言します。

出力形式:
{ "label": "good|warn|risk", "advice": "1〜3文の日本語助言", "reason": "短い理由" }

評価軸:
- ユーザー発話が会話として成立しているか。
- ぶつ切り、未完、文脈不足に見えないか。
- 次にユーザーが足すと自然な一言があるか。
- 相手の話を受ける余地があるか。

制約:
- 返答はJSONのみ。
- ユーザー発話文字起こしがない場合は、Realtimeアバター応答から推定し、断定しすぎない。
- 速度優先。`);

  requireValue('AZURE_OPENAI_ENDPOINT', endpoint);
  requireValue('AZURE_OPENAI_API_KEY', apiKey);
  if (!fs.existsSync(audioPath)) throw new Error(`audio file not found: ${audioPath}`);

  const totalAudioSeconds = chunkSeconds * maxChunks;
  const audioDataUrl = mp3ToWavDataUrl(audioPath, totalAudioSeconds);
  const realtimeToken = await createRealtimeClientSecret({
    endpoint,
    apiKey,
    deployment: realtimeDeployment,
    tokenUrl,
    voice,
    chunkSeconds
  });
  const { token, webrtcUrl } = realtimeToken;

  const logHuman = (message) => {
    if (humanLog) console.error(`[smoke] ${message}`);
  };

  logHuman(`Realtime deployment: ${realtimeToken.deployment || realtimeDeployment}`);
  logHuman(`Realtime transport: WebRTC / ${webrtcUrl}`);
  logHuman(`Realtime token endpoint: ${tokenUrl || 'direct client_secrets'}`);
  logHuman(`Realtime transcription deployment: ${transcriptionDeployment}`);
  logHuman(`Advisor endpoint: ${advisorUrl}`);
  logHuman(`Advisor deployment: ${advisorDeployment}`);
  logHuman(`Audio: ${path.basename(audioPath)}, turns=${maxChunks}, chunk=${chunkSeconds}s`);
  logHuman(`Advisor cadence: interval=${advisorIntervalMs}ms retry=${advisorRetryMs}ms maxRetries=${advisorMaxRetries} maxTokens=${advisorMaxTokens}`);

  const transcript = [];
  const turns = Array.from({ length: maxChunks }, (_, index) => ({
    index: index + 1,
    assistantTranscript: '',
    advisor: null,
    sawResponseDone: false,
    responseStatus: ''
  }));

  const browser = await chromium.launch({
    channel: 'chrome',
    headless,
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-ui-for-media-stream',
      '--disable-web-security'
    ]
  });

  try {
    const page = await browser.newPage();
    page.on('console', (message) => logHuman(`browser ${message.type()}: ${message.text()}`));
    page.on('pageerror', (error) => logHuman(`browser pageerror: ${error.message}`));

    await page.exposeFunction('nodeLog', (message) => {
      logHuman(message);
    });

    await page.exposeFunction('nodeTurnDone', async ({ index, userTranscript, assistantTranscript }) => {
      const turn = turns[index - 1];
      turn.userTranscript = userTranscript || '';
      turn.assistantTranscript = assistantTranscript || '';
      turn.sawResponseDone = true;
      logHuman(`Turn ${index}: user="${turn.userTranscript || '(empty transcript)'}"`);
      logHuman(`Turn ${index}: assistant="${turn.assistantTranscript || '(empty transcript)'}"`);
      if (!turn.assistantTranscript) return null;

      if (turn.userTranscript) transcript.push({ role: 'user', text: turn.userTranscript });
      transcript.push({ role: 'assistant', text: turn.assistantTranscript });
      const advisor = await requestAdvisor({
        advisorUrl,
        deployment: advisorDeployment,
        instructions: advisorInstructions,
        reasoningEffort: 'none',
        maxTokens: advisorMaxTokens,
        latest: turn.userTranscript
          ? { role: 'user', text: turn.userTranscript }
          : { role: 'assistant', text: `Realtimeアバター応答: ${turn.assistantTranscript}` },
        transcript,
        retryMs: advisorRetryMs,
        maxRetries: advisorMaxRetries
      });
      turn.advisor = advisor;
      if (advisor?.ok) {
        logHuman(`Turn ${index}: advisor=${advisor.label || 'ok'} "${advisor.advice || advisor.text || ''}"`);
      } else {
        logHuman(`Turn ${index}: advisor failed HTTP ${advisor?.status || 'unknown'} ${advisor?.error || ''}`);
      }
      if (advisorIntervalMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, advisorIntervalMs));
      }
      return advisor;
    });

    await page.goto('about:blank');
    const browserResult = await page.evaluate(async ({ token, webrtcUrl, audioDataUrl, voice, chunkSeconds, maxChunks, timeoutMs, turnTimeoutMs, transcriptionDeployment }) => {
      const seen = [];
      const userTextByTurn = Array.from({ length: maxChunks }, () => '');
      const assistantDeltaByContent = new Map();
      const assistantPartsByTurn = Array.from({ length: maxChunks }, () => new Map());
      const responseDoneByTurn = Array.from({ length: maxChunks }, () => false);
      const responseStatusByTurn = Array.from({ length: maxChunks }, () => '');
      let configured = false;
      let finished = false;
      let activeTurn = -1;
      let error = null;
      let pc = null;
      let dc = null;
      let audioContext = null;
      let currentResponseDone = null;

      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const failAfter = (ms, message) => new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));

      function responseContentKey(event) {
        return [
          event.response_id || 'no-response',
          event.item_id || 'no-item',
          event.output_index ?? 0,
          event.content_index ?? 0
        ].join(':');
      }

      function assistantTranscriptForTurn(index) {
        return Array.from(assistantPartsByTurn[index].values())
          .sort((a, b) => a.outputIndex - b.outputIndex || a.contentIndex - b.contentIndex || a.itemId.localeCompare(b.itemId))
          .map((part) => part.text.trim())
          .filter(Boolean)
          .join('\n')
          .trim();
      }

      function waitForDataChannelOpen(channel, timeout) {
        if (channel.readyState === 'open') return Promise.resolve();
        return Promise.race([
          new Promise((resolve, reject) => {
            channel.addEventListener('open', resolve, { once: true });
            channel.addEventListener('error', () => reject(new Error('data channel error')), { once: true });
          }),
          failAfter(timeout, 'data channel open timed out')
        ]);
      }

      function waitForEvent(predicate, timeout, label) {
        return Promise.race([
          new Promise((resolve, reject) => {
            const started = performance.now();
            const timer = setInterval(() => {
              if (predicate()) {
                clearInterval(timer);
                resolve(true);
              } else if (performance.now() - started > timeout) {
                clearInterval(timer);
                reject(new Error(`${label} timed out`));
              }
            }, 50);
          }),
          failAfter(timeout + 1000, `${label} timed out`)
        ]);
      }

      async function decodeAudio(dataUrl) {
        const response = await fetch(dataUrl);
        const arrayBuffer = await response.arrayBuffer();
        return audioContext.decodeAudioData(arrayBuffer);
      }

      function playAudioChunk(audioBuffer, destination, index) {
        return new Promise((resolve) => {
          const source = audioContext.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(destination);
          source.onended = resolve;
          source.start(audioContext.currentTime + 0.05, index * chunkSeconds, chunkSeconds);
        });
      }

      function sendSessionUpdate() {
        dc.send(JSON.stringify({
          type: 'session.update',
          session: {
            type: 'realtime',
            instructions: '日本語で短く自然に返答してください。長くても2文。',
            output_modalities: ['audio'],
            max_output_tokens: 'inf',
            audio: {
              input: {
                noise_reduction: { type: 'far_field' },
                format: { type: 'audio/pcm', rate: 24000 },
                transcription: {
                  model: transcriptionDeployment,
                  language: 'ja'
                },
                turn_detection: {
                  type: 'server_vad',
                  threshold: 0.5,
                  prefix_padding_ms: 300,
                  silence_duration_ms: 500,
                  create_response: false,
                  interrupt_response: false
                }
              },
              output: {
                voice,
                format: { type: 'audio/pcm', rate: 24000 }
              }
            }
          }
        }));
      }

      try {
        audioContext = new AudioContext({ sampleRate: 24000 });
        await audioContext.resume();
        const audioBuffer = await decodeAudio(audioDataUrl);
        const destination = audioContext.createMediaStreamDestination();

        pc = new RTCPeerConnection();
        pc.addTrack(destination.stream.getAudioTracks()[0], destination.stream);
        pc.ontrack = (event) => {
          const audio = document.createElement('audio');
          audio.autoplay = true;
          audio.srcObject = event.streams[0];
          document.body.appendChild(audio);
          audio.play().catch(() => {});
        };

        dc = pc.createDataChannel('realtime-channel');
        dc.addEventListener('message', (message) => {
          const event = JSON.parse(message.data);
          seen.push(event.type);
          if (seen.length <= 10 || event.type === 'error') window.nodeLog(`event: ${event.type}`);

          if (event.type === 'session.created') sendSessionUpdate();
          if (event.type === 'session.updated') configured = true;
          if (event.type === 'input_audio_buffer.speech_stopped' && activeTurn >= 0 && dc?.readyState === 'open') {
            dc.send(JSON.stringify({ type: 'response.create' }));
          }

          if ((event.type === 'conversation.item.input_audio_transcription.delta' || event.type === 'conversation.item.audio_transcription.delta') && activeTurn >= 0) {
            userTextByTurn[activeTurn] += event.delta || '';
          }
          if ((event.type === 'conversation.item.input_audio_transcription.completed' || event.type === 'conversation.item.audio_transcription.completed') && activeTurn >= 0) {
            userTextByTurn[activeTurn] = event.transcript || userTextByTurn[activeTurn] || '';
          }
          if (event.type === 'response.output_audio_transcript.delta' && activeTurn >= 0) {
            const key = responseContentKey(event);
            assistantDeltaByContent.set(key, `${assistantDeltaByContent.get(key) || ''}${event.delta || ''}`);
          }
          if (event.type === 'response.output_audio_transcript.done' && activeTurn >= 0) {
            const key = responseContentKey(event);
            const text = event.transcript || assistantDeltaByContent.get(key) || '';
            assistantDeltaByContent.delete(key);
            if (text) {
              assistantPartsByTurn[activeTurn].set(key, {
                outputIndex: Number(event.output_index) || 0,
                contentIndex: Number(event.content_index) || 0,
                itemId: event.item_id || '',
                text
              });
            }
          }
          if (event.type === 'response.done' && activeTurn >= 0) {
            responseDoneByTurn[activeTurn] = true;
            responseStatusByTurn[activeTurn] = event.response?.status || event.status || '';
            if (currentResponseDone) currentResponseDone();
          }
          if (event.type === 'error') {
            error = event.error?.message || JSON.stringify(event);
            if (currentResponseDone) currentResponseDone();
          }
        });

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const sdpResponse = await fetch(webrtcUrl, {
          method: 'POST',
          body: offer.sdp,
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/sdp'
          }
        });
        const answerSdp = await sdpResponse.text();
        if (!sdpResponse.ok) throw new Error(`SDP failed ${sdpResponse.status}: ${answerSdp.slice(0, 500)}`);
        await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
        window.nodeLog('Realtime WebRTC SDP exchange completed');

        await waitForDataChannelOpen(dc, 10000);
        window.nodeLog('Realtime data channel opened');

        await waitForEvent(() => configured, 10000, 'session.updated');
        window.nodeLog('Realtime session configured');

        for (let index = 0; index < maxChunks; index += 1) {
          activeTurn = index;
          responseDoneByTurn[index] = false;
          window.nodeLog(`Turn ${index + 1}: playing ${chunkSeconds}s audio into WebRTC track`);
          const responseDonePromise = new Promise((resolve) => {
            currentResponseDone = resolve;
          });
          await playAudioChunk(audioBuffer, destination, index);
          await Promise.race([
            responseDonePromise,
            failAfter(turnTimeoutMs, `turn ${index + 1} response timed out`)
          ]);
          currentResponseDone = null;
          await window.nodeTurnDone({
            index: index + 1,
            userTranscript: userTextByTurn[index] || '',
            assistantTranscript: assistantTranscriptForTurn(index)
          });
          if (error) break;
          await wait(250);
        }

        finished = !error && responseDoneByTurn.every(Boolean);
      } catch (caught) {
        error = caught.message || String(caught);
      } finally {
        try { dc?.close(); } catch {}
        try { pc?.close(); } catch {}
        try { await audioContext?.close(); } catch {}
      }

      const assistantTextByTurn = Array.from({ length: maxChunks }, (_, index) => assistantTranscriptForTurn(index));
      return {
        configured,
        finished,
        error,
        responsesOk: assistantTextByTurn.every((text) => Boolean(text)),
        turns: assistantTextByTurn.map((assistantTranscript, index) => ({
          index: index + 1,
          assistantTranscript,
          sawResponseDone: responseDoneByTurn[index],
          responseStatus: responseStatusByTurn[index]
        })),
        seen: Array.from(new Set(seen))
      };
    }, { token, webrtcUrl, audioDataUrl, voice, chunkSeconds, maxChunks, timeoutMs, turnTimeoutMs, transcriptionDeployment });

    const advisorOk = turns.every((turn) => turn.advisor?.ok);
    const responsesOk = browserResult.turns.every((turn) => turn.assistantTranscript);
    const result = {
      ok: Boolean(browserResult.configured && browserResult.finished && responsesOk && advisorOk && !browserResult.error),
      configured: browserResult.configured,
      finished: browserResult.finished,
      transport: 'webrtc',
      chunkSeconds,
      chunks: maxChunks,
      advisorInputSource: 'realtime_response_transcript',
      responsesOk,
      advisorOk,
      strictAdvisor,
      advisorIntervalMs,
      advisorRetryMs,
      advisorMaxRetries,
      advisorMaxTokens,
      error: browserResult.error,
      turns: turns.map((turn, index) => ({
        index: turn.index,
        assistantTranscript: browserResult.turns[index]?.assistantTranscript || turn.assistantTranscript,
        advisor: turn.advisor,
        sawResponseDone: browserResult.turns[index]?.sawResponseDone || turn.sawResponseDone,
        responseStatus: browserResult.turns[index]?.responseStatus || turn.responseStatus
      })),
      seen: browserResult.seen
    };

    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    if (strictAdvisor && !advisorOk) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
