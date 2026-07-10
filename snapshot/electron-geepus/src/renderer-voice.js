/**
 * renderer-voice.js — Voice input/output controls with conservative defaults.
 *
 * Goals:
 * - Optional push-to-talk voice input (speech recognition)
 * - Optional concise spoken replies (speech synthesis)
 * - Persisted settings + safe fallbacks when voice APIs are unavailable
 */

const VOICE_DEFAULTS = {
  enabled: false,
  autoSpeak: true,
  autoSend: false,
  realtimeDictation: true,
  openaiApiKey: '',
  transcriptionModel: '',
  voiceName: '',
  inputDeviceId: '',
  replyStyle: 'concise',
  rate: 0.95,
  pitch: 1,
  volume: 0.9,
  maxReplyChars: 220,
};

const DEFAULT_TRANSCRIPTION_MODELS = [
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe-latest',
  'gpt-4o-transcribe',
  'whisper-1',
];

const REALTIME_PCM_RATE = 24000;

let _voiceRecognition = null;
let _voiceFinalText = '';
let _voiceInterimText = '';
let _voiceManualStop = false;
let _voiceLastSpokenSignature = '';
let _voiceLastSpokenAt = 0;
let _voiceVoices = [];
let _voiceTranscribing = false;
let _voiceRecorder = null;
let _voiceRecorderStream = null;
let _voiceRecorderChunks = [];
let _voiceSuppressEmptyNotice = false;
let _voiceInputDevices = [];
let _voiceLastCaptureMode = 'none';
let _voiceTranscriptionBlocked = false;
let _voiceRealtimeSessionId = '';
let _voiceRealtimeConnected = false;
let _voiceRealtimePartialText = '';
let _voiceRealtimeFinalText = '';
let _voiceRealtimeUnsubscribe = null;
let _voiceRealtimeLastChunkAt = 0;

function clampVoiceNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function normalizeVoiceSettings(raw, fallback = VOICE_DEFAULTS) {
  const next = raw && typeof raw === 'object' ? raw : {};
  const base = fallback && typeof fallback === 'object' ? fallback : VOICE_DEFAULTS;
  const styleRaw = String(next.replyStyle ?? base.replyStyle ?? VOICE_DEFAULTS.replyStyle).trim().toLowerCase();
  const replyStyle = styleRaw === 'balanced' ? 'balanced' : 'concise';
  return {
    enabled: Boolean(next.enabled ?? base.enabled ?? VOICE_DEFAULTS.enabled),
    autoSpeak: Boolean(next.autoSpeak ?? base.autoSpeak ?? VOICE_DEFAULTS.autoSpeak),
    autoSend: Boolean(next.autoSend ?? base.autoSend ?? VOICE_DEFAULTS.autoSend),
    realtimeDictation: Boolean(next.realtimeDictation ?? base.realtimeDictation ?? VOICE_DEFAULTS.realtimeDictation),
    openaiApiKey: String(next.openaiApiKey ?? base.openaiApiKey ?? VOICE_DEFAULTS.openaiApiKey).trim(),
    transcriptionModel: String(next.transcriptionModel ?? base.transcriptionModel ?? VOICE_DEFAULTS.transcriptionModel).trim(),
    voiceName: String(next.voiceName ?? base.voiceName ?? VOICE_DEFAULTS.voiceName).trim(),
    inputDeviceId: String(next.inputDeviceId ?? base.inputDeviceId ?? VOICE_DEFAULTS.inputDeviceId).trim(),
    replyStyle,
    rate: clampVoiceNumber(next.rate ?? base.rate ?? VOICE_DEFAULTS.rate, 0.75, 1.35, VOICE_DEFAULTS.rate),
    pitch: clampVoiceNumber(next.pitch ?? base.pitch ?? VOICE_DEFAULTS.pitch, 0.8, 1.2, VOICE_DEFAULTS.pitch),
    volume: clampVoiceNumber(next.volume ?? base.volume ?? VOICE_DEFAULTS.volume, 0.1, 1, VOICE_DEFAULTS.volume),
    maxReplyChars: Math.floor(clampVoiceNumber(next.maxReplyChars ?? base.maxReplyChars ?? VOICE_DEFAULTS.maxReplyChars, 80, 900, VOICE_DEFAULTS.maxReplyChars)),
  };
}

function voiceRecognitionCtor() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function supportsVoiceInput() {
  return Boolean(voiceRecognitionCtor());
}

function supportsRecorderInput() {
  return Boolean(
    navigator?.mediaDevices?.getUserMedia
    && window.MediaRecorder
    && window.geepus
    && typeof window.geepus.transcribeAudio === 'function',
  );
}

function supportsRealtimeDictation() {
  return Boolean(
    window.geepus
    && typeof window.geepus.audioRealtimeStart === 'function'
    && typeof window.geepus.audioRealtimeAppend === 'function'
    && typeof window.geepus.audioRealtimeCommit === 'function'
    && typeof window.geepus.audioRealtimeStop === 'function',
  );
}

function supportsVoiceOutput() {
  return Boolean(window.speechSynthesis && window.SpeechSynthesisUtterance);
}

/**
 * Returns true when an OpenAI API key is available for voice transcription.
 * Uses the dedicated voice key when provider isn't OpenAI; otherwise the main key.
 */
function hasTranscriptionKey() {
  const cfg = getVoiceSettings();
  if (cfg.openaiApiKey) return true;
  return state.provider === 'openai' && state.apiKeyPresent;
}

function resetRealtimeDictationState() {
  _voiceRealtimeSessionId = '';
  _voiceRealtimeConnected = false;
  _voiceRealtimePartialText = '';
  _voiceRealtimeFinalText = '';
  _voiceRealtimeLastChunkAt = 0;
}

function resampleFloat32Pcm(sourceSamples, sourceRate, targetRate = REALTIME_PCM_RATE) {
  const source = sourceSamples instanceof Float32Array ? sourceSamples : new Float32Array(0);
  const from = Number(sourceRate) || targetRate;
  const to = Number(targetRate) || REALTIME_PCM_RATE;
  if (!source.length) return new Float32Array(0);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from <= 0 || to <= 0 || from === to) {
    return source;
  }

  const ratio = from / to;
  const targetLength = Math.max(1, Math.round(source.length / ratio));
  const out = new Float32Array(targetLength);
  for (let i = 0; i < targetLength; i += 1) {
    const index = i * ratio;
    const left = Math.floor(index);
    const right = Math.min(source.length - 1, left + 1);
    const blend = index - left;
    out[i] = (source[left] || 0) * (1 - blend) + (source[right] || 0) * blend;
  }
  return out;
}

function float32ToPcm16Base64(float32Samples, sampleRate = REALTIME_PCM_RATE) {
  const source = resampleFloat32Pcm(float32Samples, sampleRate, REALTIME_PCM_RATE);
  if (!source.length) return '';
  const pcm16 = new Int16Array(source.length);
  for (let i = 0; i < source.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, Number(source[i] || 0)));
    pcm16[i] = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
  }
  return arrayBufferToBase64(pcm16.buffer);
}

async function startRealtimeDictationSession(transcriptionModel) {
  if (!supportsRealtimeDictation() || !hasTranscriptionKey()) return '';
  const preferredModel = String(transcriptionModel || '').trim();
  try {
    const result = await window.geepus.audioRealtimeStart({
      transcriptionModel: preferredModel,
      chatModel: String(state.model || '').trim(),
    });
    const sessionId = String(result?.sessionId || '').trim();
    if (!sessionId) return '';
    _voiceRealtimeSessionId = sessionId;
    _voiceRealtimeConnected = false;
    _voiceRealtimePartialText = '';
    _voiceRealtimeFinalText = '';
    _voiceRealtimeLastChunkAt = 0;
    return sessionId;
  } catch {
    return '';
  }
}

function appendRealtimeDictationChunk(samples, sampleRate) {
  const sessionId = String(_voiceRealtimeSessionId || '').trim();
  if (!sessionId) return;
  const now = Date.now();
  if (now - _voiceRealtimeLastChunkAt < 90) return;
  _voiceRealtimeLastChunkAt = now;
  const audioBase64 = float32ToPcm16Base64(samples, sampleRate);
  if (!audioBase64) return;
  window.geepus.audioRealtimeAppend({ sessionId, audioBase64 }).catch(() => {});
}

async function collectRealtimeDictationTranscript(timeoutMs = 1400) {
  const sessionId = String(_voiceRealtimeSessionId || '').trim();
  if (!sessionId) return '';
  try {
    await window.geepus.audioRealtimeCommit({ sessionId });
  } catch {
    // continue and wait for whatever transcript already exists
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const finalText = String(_voiceRealtimeFinalText || '').trim();
    if (finalText) return finalText;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return String(_voiceRealtimeFinalText || _voiceRealtimePartialText || '').trim();
}

async function stopRealtimeDictationSession() {
  const sessionId = String(_voiceRealtimeSessionId || '').trim();
  resetRealtimeDictationState();
  if (!sessionId || !window.geepus || typeof window.geepus.audioRealtimeStop !== 'function') return;
  try {
    await window.geepus.audioRealtimeStop({ sessionId });
  } catch {
    // no-op
  }
}

function isVoiceAccessError(message) {
  const lowered = String(message || '').toLowerCase();
  return lowered.includes('does not have access to model')
    || lowered.includes('permission denied for model')
    || lowered.includes('model not found')
    || lowered.includes('insufficient permissions');
}

function isVoiceNoSpeechError(message) {
  const lowered = String(message || '').toLowerCase();
  return lowered.includes('no transcribed speech')
    || lowered.includes('no speech')
    || lowered.includes('[no_speech]')
    || lowered.includes('empty transcript');
}

function isVoiceFormatError(message) {
  const lowered = String(message || '').toLowerCase();
  return lowered.includes('unsupported audio')
    || lowered.includes('audio format')
    || lowered.includes('supported values are')
    || lowered.includes('unrecognized file format')
    || lowered.includes('could not decode')
    || lowered.includes('invalid audio')
    || (lowered.includes('invalid value') && (
      lowered.includes('webm')
      || lowered.includes('wav')
      || lowered.includes('mp3')
      || lowered.includes('ogg')
      || lowered.includes('flac')
      || lowered.includes('format')
    ));
}

function summarizeVoiceError(raw, { maxParts = 3, maxChars = 220 } = {}) {
  const parts = String(raw || '')
    .split('|')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (parts.length === 0) return '';
  const unique = [];
  for (const part of parts) {
    const normalized = part.toLowerCase();
    if (unique.some((existing) => existing.toLowerCase() === normalized)) continue;
    unique.push(part);
    if (unique.length >= maxParts) break;
  }
  const joined = unique.join(' | ');
  return joined.length > maxChars ? `${joined.slice(0, Math.max(1, maxChars - 1)).trim()}…` : joined;
}

function isVoiceTranscriptionModelId(model) {
  const id = String(model || '').toLowerCase();
  if (!id) return false;
  if (id.includes('tts')) return false;
  return id.includes('transcribe') || id.includes('whisper');
}

function getVoiceSettings() {
  state.voice = normalizeVoiceSettings(state.voice || VOICE_DEFAULTS);
  return state.voice;
}

function rankVoice(voice) {
  if (!voice) return -1;
  const name = String(voice.name || '').toLowerCase();
  const lang = String(voice.lang || '').toLowerCase();
  const uri = String(voice.voiceURI || '').toLowerCase();
  let score = 0;

  if (lang.startsWith('en-us')) score += 20;
  else if (lang.startsWith('en-')) score += 12;

  // Prefer modern natural/neural voices over legacy robotic system voices.
  if (name.includes('siri')) score += 130;
  if (name.includes('premium') || name.includes('enhanced') || name.includes('natural')) score += 70;
  if (name.includes('neural') || uri.includes('neural')) score += 65;
  if (name.includes('google us english')) score += 55;
  if (name.includes('microsoft')) score += 45;

  // Strong human-sounding macOS voices.
  if (name.includes('daniel')) score += 95;
  if (name.includes('aaron')) score += 88;
  if (name.includes('alex')) score += 80;
  if (name.includes('samantha')) score += 74;
  if (name.includes('ava') || name.includes('allison')) score += 62;
  if (name.includes('karen') || name.includes('moira')) score += 54;

  // De-prioritize famously robotic voices.
  if (name.includes('fred')) score -= 40;
  if (name.includes('compact')) score -= 14;
  if (name.includes('novelty')) score -= 20;

  if (voice.localService) score += 8;
  if (voice.default) score += 4;

  return score;
}

function findPreferredVoice(voices, preferredName = '') {
  const list = Array.isArray(voices) ? voices : [];
  if (list.length === 0) return null;
  if (preferredName) {
    const byExact = list.find((voice) => String(voice.name || '') === preferredName);
    if (byExact) return byExact;
  }
  let best = list[0];
  let bestScore = rankVoice(best);
  for (let i = 1; i < list.length; i += 1) {
    const score = rankVoice(list[i]);
    if (score > bestScore) {
      best = list[i];
      bestScore = score;
    }
  }
  return best;
}

function setVoiceSupportHint(message) {
  if (!el.voiceSupportHint) return;
  el.voiceSupportHint.textContent = message;
}

function setVoiceInputLevelHint(message) {
  if (el.voiceInputLevelHint) {
    el.voiceInputLevelHint.textContent = message;
  }
  if (el.voiceInputLevelInline) {
    el.voiceInputLevelInline.textContent = message;
  }
}

function updateVoiceMicButton() {
  if (!el.voiceMicButton) return;
  const cfg = getVoiceSettings();
  const recognitionReady = supportsVoiceInput();
  const recorderReady = supportsRecorderInput();
  const canUseInput = recognitionReady || recorderReady;
  const canUse = cfg.enabled && canUseInput;
  el.voiceMicButton.disabled = !canUse || state.working || _voiceTranscribing;
  el.voiceMicButton.classList.toggle('listening', Boolean(state.voiceListening));
  if (!cfg.enabled) {
    el.voiceMicButton.textContent = '🎙 Voice Off';
  } else if (_voiceTranscribing) {
    el.voiceMicButton.textContent = '⏳ Transcribing...';
  } else if (!canUseInput) {
    el.voiceMicButton.textContent = '🎙 Unavailable';
  } else if (state.voiceListening) {
    el.voiceMicButton.textContent = '⏹ Stop';
  } else {
    el.voiceMicButton.textContent = '🎙 Talk';
  }
}

function applyVoiceSettingsToUi() {
  const cfg = getVoiceSettings();
  if (el.voiceEnabledToggle) el.voiceEnabledToggle.checked = cfg.enabled;
  if (el.voiceAutoSpeakToggle) el.voiceAutoSpeakToggle.checked = cfg.autoSpeak;
  if (el.voiceAutoSendToggle) el.voiceAutoSendToggle.checked = cfg.autoSend;
  if (el.voiceRealtimeToggle) el.voiceRealtimeToggle.checked = cfg.realtimeDictation;

  // Show/hide the dedicated OpenAI key row depending on provider
  const needsSeparateKey = state.provider !== 'openai';
  if (el.voiceOpenaiKeyRow) {
    el.voiceOpenaiKeyRow.style.display = cfg.enabled && needsSeparateKey ? '' : 'none';
  }
  if (el.voiceOpenaiKeyInput) {
    // Only set the value if the input isn't focused (avoid overwriting mid-type)
    if (document.activeElement !== el.voiceOpenaiKeyInput) {
      el.voiceOpenaiKeyInput.value = cfg.openaiApiKey ? '••••••••' : '';
    }
    el.voiceOpenaiKeyInput.disabled = !cfg.enabled;
  }

  refreshVoiceTranscriptionModelOptions();
  if (el.voiceTranscriptionModelSelect && el.voiceTranscriptionModelSelect.value !== cfg.transcriptionModel) {
    el.voiceTranscriptionModelSelect.value = cfg.transcriptionModel;
  }
  if (el.voiceReplyStyleSelect) el.voiceReplyStyleSelect.value = cfg.replyStyle;
  if (el.voiceRateInput) el.voiceRateInput.value = String(cfg.rate);
  if (el.voiceRateValue) el.voiceRateValue.textContent = `${cfg.rate.toFixed(2)}x`;
  if (el.voiceNameSelect && el.voiceNameSelect.value !== cfg.voiceName) {
    el.voiceNameSelect.value = cfg.voiceName;
  }
  if (el.voiceInputDeviceSelect && el.voiceInputDeviceSelect.value !== cfg.inputDeviceId) {
    el.voiceInputDeviceSelect.value = cfg.inputDeviceId;
  }

  const controls = [
    el.voiceAutoSpeakToggle,
    el.voiceAutoSendToggle,
    el.voiceRealtimeToggle,
    el.voiceTranscriptionModelSelect,
    el.voiceNameSelect,
    el.voiceInputDeviceSelect,
    el.voiceRefreshDevicesButton,
    el.voiceReplyStyleSelect,
    el.voiceRateInput,
  ];
  controls.forEach((node) => {
    if (!node) return;
    node.disabled = !cfg.enabled;
  });

  const inputReady = supportsVoiceInput() || supportsRecorderInput();
  const outputReady = supportsVoiceOutput();
  const keyReady = hasTranscriptionKey();
  const realtimeReady = supportsRealtimeDictation();
  if (_voiceTranscriptionBlocked && supportsVoiceInput()) {
    setVoiceSupportHint('Cloud transcription unavailable for this key. Using local dictation fallback.');
  } else if (!inputReady && !outputReady) {
    setVoiceSupportHint('Voice APIs are unavailable in this environment.');
  } else if (!inputReady && outputReady) {
    setVoiceSupportHint('Speech input unavailable. Spoken replies still work.');
  } else if (inputReady && !outputReady) {
    setVoiceSupportHint('Speech output unavailable. Dictation still works.');
  } else if (inputReady && !keyReady) {
    if (state.provider !== 'openai') {
      setVoiceSupportHint('Add an OpenAI API key above for voice transcription.');
    } else {
      setVoiceSupportHint('Connect your OpenAI API key to enable voice dictation.');
    }
  } else if (!supportsVoiceInput() && supportsRecorderInput() && cfg.realtimeDictation && realtimeReady) {
    setVoiceSupportHint('Voice ready with realtime dictation. Click Talk, speak naturally, then Stop.');
  } else if (!supportsVoiceInput() && supportsRecorderInput()) {
    setVoiceSupportHint('Voice ready with recorder fallback. Click Talk, then Stop.');
  } else {
    const selected = cfg.voiceName || 'Auto';
    setVoiceSupportHint(`Voice ready (${selected}). Shortcut: Alt+Space.`);
  }

  updateVoiceMicButton();
}

function refreshVoiceTranscriptionModelOptions() {
  if (!el.voiceTranscriptionModelSelect) return;
  const cfg = getVoiceSettings();
  const select = el.voiceTranscriptionModelSelect;
  const selected = String(cfg.transcriptionModel || '').trim();
  const allModels = Array.isArray(state.models) ? state.models : [];
  const discovered = allModels.filter((model) => isVoiceTranscriptionModelId(model));
  const models = Array.from(new Set([
    ...DEFAULT_TRANSCRIPTION_MODELS,
    ...discovered,
  ]));

  select.innerHTML = '';
  const autoOption = document.createElement('option');
  autoOption.value = '';
  autoOption.textContent = 'Auto (Recommended)';
  select.appendChild(autoOption);

  models.forEach((model) => {
    const option = document.createElement('option');
    option.value = model;
    option.textContent = model;
    select.appendChild(option);
  });

  if (selected && !models.includes(selected)) {
    const saved = document.createElement('option');
    saved.value = selected;
    saved.textContent = `${selected} (saved)`;
    select.appendChild(saved);
  }

  select.value = selected;
}

async function refreshVoiceInputDevices({ requestPermission = false } = {}) {
  if (!el.voiceInputDeviceSelect || !navigator?.mediaDevices?.enumerateDevices) return;
  if (requestPermission && navigator?.mediaDevices?.getUserMedia) {
    try {
      const temp = await navigator.mediaDevices.getUserMedia({ audio: true });
      temp.getTracks().forEach((track) => {
        try { track.stop(); } catch { /* no-op */ }
      });
    } catch {
      // ignore permission errors; list may still show anonymous devices
    }
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    _voiceInputDevices = devices.filter((device) => device.kind === 'audioinput');
  } catch {
    _voiceInputDevices = [];
  }

  const cfg = getVoiceSettings();
  el.voiceInputDeviceSelect.innerHTML = '';
  const defaultOption = document.createElement('option');
  defaultOption.value = '';
  defaultOption.textContent = 'System default';
  el.voiceInputDeviceSelect.appendChild(defaultOption);

  _voiceInputDevices.forEach((device, index) => {
    const option = document.createElement('option');
    option.value = device.deviceId || '';
    option.textContent = device.label || `Microphone ${index + 1}`;
    el.voiceInputDeviceSelect.appendChild(option);
  });

  const selectedExists = cfg.inputDeviceId
    && _voiceInputDevices.some((device) => device.deviceId === cfg.inputDeviceId);
  if (!selectedExists && cfg.inputDeviceId) {
    setVoiceSettingsPatch({ inputDeviceId: '' }, { persist: true, silent: true });
  } else {
    el.voiceInputDeviceSelect.value = cfg.inputDeviceId;
  }

  if (_voiceInputDevices.length === 0) {
    setVoiceInputLevelHint('Mic level: no input devices found');
  } else {
    setVoiceInputLevelHint(`Mic level: idle (${_voiceInputDevices.length} mic${_voiceInputDevices.length === 1 ? '' : 's'} detected)`);
  }
}

function ensureVoiceOptions() {
  if (!el.voiceNameSelect) return;
  const synth = window.speechSynthesis;
  if (!synth || typeof synth.getVoices !== 'function') {
    _voiceVoices = [];
    el.voiceNameSelect.innerHTML = '<option value="">Auto (Recommended)</option>';
    applyVoiceSettingsToUi();
    return;
  }

  const voices = synth.getVoices() || [];
  _voiceVoices = voices;
  const cfg = getVoiceSettings();

  el.voiceNameSelect.innerHTML = '';
  const autoVoice = findPreferredVoice(voices, '');
  const autoName = autoVoice ? autoVoice.name : 'system default';
  const autoOption = document.createElement('option');
  autoOption.value = '';
  autoOption.textContent = `Auto (Recommended: ${autoName})`;
  el.voiceNameSelect.appendChild(autoOption);

  const englishFirst = [...voices].sort((left, right) => {
    const lLang = String(left.lang || '').toLowerCase().startsWith('en-') ? 0 : 1;
    const rLang = String(right.lang || '').toLowerCase().startsWith('en-') ? 0 : 1;
    if (lLang !== rLang) return lLang - rLang;
    const scoreDelta = rankVoice(right) - rankVoice(left);
    if (scoreDelta !== 0) return scoreDelta;
    return String(left.name || '').localeCompare(String(right.name || ''));
  });

  englishFirst.forEach((voice) => {
    const option = document.createElement('option');
    option.value = voice.name;
    option.textContent = `${voice.name} (${voice.lang || 'unknown'})`;
    el.voiceNameSelect.appendChild(option);
  });

  if (cfg.voiceName) {
    const valid = voices.some((voice) => voice.name === cfg.voiceName);
    if (!valid) {
      state.voice = normalizeVoiceSettings({ ...cfg, voiceName: '' });
      if (typeof saveSettingsPatch === 'function') {
        saveSettingsPatch({ voice: state.voice }).catch(() => {});
      }
    }
  }

  applyVoiceSettingsToUi();
}

async function persistVoiceSettings(silent = true) {
  if (typeof saveSettingsPatch !== 'function') return;
  try {
    await saveSettingsPatch({ voice: getVoiceSettings() });
    if (!silent) setStatus('Voice settings saved.');
  } catch (error) {
    setStatus(error.message || String(error));
  }
}

function updateVoiceDraft() {
  if (!el.promptInput) return;
  const prefix = String(state.voiceCapturePrefix || '');
  const transcript = `${_voiceFinalText} ${_voiceInterimText}`.replace(/\s+/g, ' ').trim();
  if (!prefix) {
    el.promptInput.value = transcript;
    return;
  }
  if (!transcript) {
    el.promptInput.value = prefix;
    return;
  }
  const sep = /\s$/.test(prefix) ? '' : ' ';
  el.promptInput.value = `${prefix}${sep}${transcript}`;
}

function finalizeVoiceCapture({ spokenText = '' } = {}) {
  state.voiceListening = false;
  updateVoiceMicButton();

  const interimFallback = (!spokenText && !_voiceFinalText) ? _voiceInterimText : '';
  const spoken = String(spokenText || _voiceFinalText || interimFallback || '').trim();
  // Recorder mode requires clicking Stop to finish capture, so manual stop should
  // not suppress auto-run there. Keep manual-stop suppression for browser
  // recognition mode to avoid accidental aborted sends.
  const manualStopSuppressesAutoSend = _voiceManualStop && _voiceLastCaptureMode === 'recognition';
  const shouldAutoRun = Boolean(
    spoken
    && state.voice?.enabled
    && (
      _voiceLastCaptureMode === 'recorder'
      || state.voice?.autoSend
    )
    && !manualStopSuppressesAutoSend,
  );
  _voiceFinalText = spoken;
  updateVoiceDraft();
  _voiceInterimText = '';

  if (!spoken) {
    if (_voiceSuppressEmptyNotice) {
      _voiceSuppressEmptyNotice = false;
    } else {
      if (_voiceLastCaptureMode === 'recorder') {
        setStatus('No transcript found from recorded audio. Try another microphone in Voice settings.');
      } else {
        setStatus('No speech detected.');
      }
    }
    _voiceFinalText = '';
    return;
  }

  setStatus('Voice input captured.');
  _voiceFinalText = '';
  if (shouldAutoRun && !state.working && typeof runPrimaryAction === 'function') {
    if (state.interactionMode !== 'auto' && typeof setInteractionMode === 'function') {
      try {
        setInteractionMode('auto');
      } catch {
        // keep going even if mode switch UI update fails
      }
    } else {
      state.interactionMode = 'auto';
    }
    setStatus('Voice input captured. Running in Auto Mode...');
    runPrimaryAction().catch((error) => {
      setStatus(error.message || String(error));
    });
  }
}

function ensureRecognition() {
  if (_voiceRecognition) return _voiceRecognition;
  const Ctor = voiceRecognitionCtor();
  if (!Ctor) return null;

  const recognition = new Ctor();
  recognition.lang = 'en-US';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onstart = () => {
    state.voiceListening = true;
    updateVoiceMicButton();
    setStatus('Listening...');
  };

  recognition.onresult = (event) => {
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      const text = String(result[0] && result[0].transcript ? result[0].transcript : '').trim();
      if (!text) continue;
      if (result.isFinal) {
        _voiceFinalText = `${_voiceFinalText} ${text}`.replace(/\s+/g, ' ').trim();
      } else {
        interim = `${interim} ${text}`.replace(/\s+/g, ' ').trim();
      }
    }
    _voiceInterimText = interim;
    updateVoiceDraft();
  };

  recognition.onerror = (event) => {
    state.voiceListening = false;
    updateVoiceMicButton();
    _voiceManualStop = true;
    const code = String(event.error || '').trim().toLowerCase();
    if (code === 'not-allowed' || code === 'service-not-allowed') {
      setStatus('Microphone permission denied. Enable it in macOS settings and retry.');
      return;
    }
    if (code === 'no-speech') {
      _voiceSuppressEmptyNotice = true;
      setStatus('I did not catch that. Try again.');
      return;
    }
    if (code === 'aborted') {
      setStatus('Voice input stopped.');
      return;
    }
    setStatus(`Voice input error: ${code || 'unknown error'}.`);
  };

  recognition.onend = () => {
    finalizeVoiceCapture();
  };

  _voiceRecognition = recognition;
  return _voiceRecognition;
}

function stopRecorderTracks() {
  if (_voiceRecorderStream && Array.isArray(_voiceRecorderStream.getTracks?.())) {
    _voiceRecorderStream.getTracks().forEach((track) => {
      try { track.stop(); } catch { /* no-op */ }
    });
  }
  _voiceRecorderStream = null;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function writeAscii(view, offset, text) {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

function encodeAudioBufferToWav(audioBuffer) {
  const channelCount = Math.max(1, Math.min(2, Number(audioBuffer?.numberOfChannels || 1)));
  const sampleRate = Number(audioBuffer?.sampleRate || 44100);
  const frameCount = Number(audioBuffer?.length || 0);
  const bytesPerSample = 2;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  const channels = [];
  for (let ch = 0; ch < channelCount; ch += 1) {
    channels.push(audioBuffer.getChannelData(ch));
  }

  let offset = 44;
  for (let i = 0; i < frameCount; i += 1) {
    for (let ch = 0; ch < channelCount; ch += 1) {
      const sample = channels[ch][i] || 0;
      const clamped = Math.max(-1, Math.min(1, sample));
      const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      view.setInt16(offset, Math.round(int16), true);
      offset += 2;
    }
  }

  return buffer;
}

function encodeFloatSamplesToWav(samples, sampleRate = 44100) {
  const frameCount = Number(samples?.length || 0);
  const bytesPerSample = 2;
  const channelCount = 1;
  const blockAlign = channelCount * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, Number(sampleRate) || 44100, true);
  view.setUint32(28, (Number(sampleRate) || 44100) * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bytesPerSample * 8, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < frameCount; i += 1) {
    const clamped = Math.max(-1, Math.min(1, Number(samples[i] || 0)));
    const int16 = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    view.setInt16(offset, Math.round(int16), true);
    offset += 2;
  }
  return buffer;
}

function wavPayloadFromPcmChunks(chunks, sampleRate) {
  if (!Array.isArray(chunks) || chunks.length === 0) return null;
  const totalFrames = chunks.reduce((sum, chunk) => sum + Number(chunk?.length || 0), 0);
  if (!totalFrames) return null;
  const merged = new Float32Array(totalFrames);
  let offset = 0;
  for (const chunk of chunks) {
    if (!(chunk instanceof Float32Array) || chunk.length === 0) continue;
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  if (!offset) return null;
  const wavBuffer = encodeFloatSamplesToWav(offset === merged.length ? merged : merged.subarray(0, offset), sampleRate);
  return {
    dataBase64: arrayBufferToBase64(wavBuffer),
    mimeType: 'audio/wav',
    filename: `voice-${Date.now()}-pcm.wav`,
  };
}

async function transcodeBlobToWav(blob) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  const context = new Ctx();
  try {
    const input = await blob.arrayBuffer();
    const audioBuffer = await context.decodeAudioData(input.slice(0));
    const wavBuffer = encodeAudioBufferToWav(audioBuffer);
    return {
      dataBase64: arrayBufferToBase64(wavBuffer),
      mimeType: 'audio/wav',
      filename: `voice-${Date.now()}.wav`,
    };
  } finally {
    try { await context.close(); } catch { /* no-op */ }
  }
}

function startBrowserRecognitionFallback(reason = '') {
  const recognition = ensureRecognition();
  if (!recognition) return false;
  try {
    _voiceLastCaptureMode = 'recognition';
    _voiceSuppressEmptyNotice = false;
    _voiceManualStop = false;
    recognition.start();
    const why = String(reason || '').trim();
    setStatus(why
      ? `Cloud transcription unavailable (${why}). Falling back to local dictation...`
      : 'Falling back to local dictation...');
    return true;
  } catch {
    return false;
  }
}

async function startRecorderCapture() {
  if (!supportsRecorderInput()) {
    setStatus('Voice input is unavailable in this app build.');
    return;
  }
  if (!hasTranscriptionKey()) {
    if (state.provider === 'openai') {
      setStatus('Connect your OpenAI API key first.');
    } else {
      setStatus('Add an OpenAI API key in Voice settings for transcription.');
    }
    return;
  }
  if (state.voiceListening) return;

  _voiceManualStop = false;
  _voiceLastCaptureMode = 'recorder';
  try {
    const captureStartedAt = Date.now();
    const cfg = getVoiceSettings();
    const useRealtime = Boolean(cfg.realtimeDictation && supportsRealtimeDictation() && hasTranscriptionKey());
    const audioConstraints = {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    };
    if (cfg.inputDeviceId) {
      audioConstraints.deviceId = { exact: cfg.inputDeviceId };
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
    } catch (error) {
      const name = String(error?.name || '').toLowerCase();
      if (cfg.inputDeviceId && (name === 'overconstrainederror' || name === 'notfounderror')) {
        setVoiceSettingsPatch({ inputDeviceId: '' }, { persist: true, silent: true });
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } else {
        throw error;
      }
    }
    const recorder = new window.MediaRecorder(stream);
    _voiceRecorderStream = stream;
    _voiceRecorder = recorder;
    _voiceRecorderChunks = [];
    let maxRms = 0;
    let levelTimer = null;
    let audioContext = null;
    let analyser = null;
    let sourceNode = null;
    let scriptNode = null;
    let muteGainNode = null;
    let pcmChunks = [];
    let pcmSampleRate = 44100;

    recorder.onstart = () => {
      state.voiceListening = true;
      updateVoiceMicButton();
      setStatus('Listening on your microphone... speak now, then click Stop.');
      try {
        audioContext = new (window.AudioContext || window.webkitAudioContext)();
        pcmSampleRate = Number(audioContext.sampleRate || 44100);
        sourceNode = audioContext.createMediaStreamSource(stream);
        analyser = audioContext.createAnalyser();
        analyser.fftSize = 1024;
        sourceNode.connect(analyser);

        // Capture raw PCM frames so we can always upload a standards-compliant WAV,
        // even when containerized MediaRecorder blobs are rejected by the API.
        if (typeof audioContext.createScriptProcessor === 'function') {
          scriptNode = audioContext.createScriptProcessor(4096, 1, 1);
          muteGainNode = audioContext.createGain();
          muteGainNode.gain.value = 0;
          sourceNode.connect(scriptNode);
          scriptNode.connect(muteGainNode);
          muteGainNode.connect(audioContext.destination);
          scriptNode.onaudioprocess = (event) => {
            const chan = event?.inputBuffer?.getChannelData?.(0);
            if (!chan || !chan.length) return;
            const sampleChunk = new Float32Array(chan);
            pcmChunks.push(sampleChunk);
            if (pcmChunks.length > 1200) {
              pcmChunks = pcmChunks.slice(-1200);
            }
            if (useRealtime) {
              appendRealtimeDictationChunk(sampleChunk, pcmSampleRate);
            }
          };
        }

        if (useRealtime) {
          startRealtimeDictationSession(cfg.transcriptionModel).then((sessionId) => {
            if (sessionId) {
              setStatus('Listening (realtime)... speak naturally, then click Stop.');
            }
          }).catch(() => {});
        }

        const data = new Float32Array(analyser.fftSize);
        levelTimer = window.setInterval(() => {
          analyser.getFloatTimeDomainData(data);
          let sum = 0;
          for (let i = 0; i < data.length; i += 1) sum += data[i] * data[i];
          const rms = Math.sqrt(sum / data.length);
          maxRms = Math.max(maxRms, rms);
          const pct = Math.min(100, Math.round(rms * 2400));
          setVoiceInputLevelHint(`Mic level: ${pct}%`);
        }, 120);
      } catch {
        setVoiceInputLevelHint('Mic level: monitoring unavailable');
      }
    };

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        _voiceRecorderChunks.push(event.data);
      }
    };

    recorder.onstop = async () => {
      if (levelTimer) {
        window.clearInterval(levelTimer);
        levelTimer = null;
      }
      if (audioContext && typeof audioContext.close === 'function') {
        try { await audioContext.close(); } catch { /* no-op */ }
      }
      if (scriptNode) {
        try { scriptNode.disconnect(); } catch { /* no-op */ }
      }
      if (muteGainNode) {
        try { muteGainNode.disconnect(); } catch { /* no-op */ }
      }
      analyser = null;
      sourceNode = null;
      scriptNode = null;
      muteGainNode = null;
      state.voiceListening = false;
      updateVoiceMicButton();
      stopRecorderTracks();
      const elapsedMs = Date.now() - captureStartedAt;
      setVoiceInputLevelHint(`Mic level: peak ${Math.min(100, Math.round(maxRms * 2400))}%`);

      const blob = new Blob(_voiceRecorderChunks, { type: recorder.mimeType || 'audio/webm' });
      _voiceRecorderChunks = [];
      _voiceRecorder = null;
      if (elapsedMs < 700 || blob.size < 300) {
        setStatus('Recording was too short. Speak for 2-3 seconds, then click Stop.');
        return;
      }

      _voiceTranscribing = true;
      updateVoiceMicButton();
      try {
        let realtimeTranscript = '';
        if (useRealtime) {
          realtimeTranscript = await collectRealtimeDictationTranscript(2500);
          await stopRealtimeDictationSession();
          if (realtimeTranscript) {
            _voiceTranscriptionBlocked = false;
            finalizeVoiceCapture({ spokenText: realtimeTranscript });
            return;
          }
        }

        const payloadCandidates = [];
        const pcmWavPayload = wavPayloadFromPcmChunks(pcmChunks, pcmSampleRate);
        if (pcmWavPayload && pcmWavPayload.dataBase64) {
          payloadCandidates.push(pcmWavPayload);
        }

        // Audio-input fallbacks accept wav/mp3 reliably. Convert browser-recorded
        // webm/ogg/mp4 blobs to wav and retry if the original format fails.
        const typeLower = String(blob.type || '').toLowerCase();
        if (typeLower.includes('webm') || typeLower.includes('ogg') || typeLower.includes('mp4')) {
          const wavPayload = await transcodeBlobToWav(blob).catch(() => null);
          if (wavPayload && wavPayload.dataBase64) {
            payloadCandidates.push(wavPayload);
          }
        }
        // Only include raw recorder blob when we do not have any wav fallback.
        // This avoids false "unsupported format" failures from webm containers.
        if (payloadCandidates.length === 0) {
          payloadCandidates.push({
            dataBase64: arrayBufferToBase64(await blob.arrayBuffer()),
            mimeType: blob.type || 'audio/webm',
            filename: `voice-${Date.now()}.webm`,
          });
        }
        pcmChunks = [];

        let transcript = '';
        const attemptErrors = [];
        for (const payload of payloadCandidates) {
          try {
            const result = await window.geepus.transcribeAudio({
              dataBase64: payload.dataBase64,
              mimeType: payload.mimeType,
              filename: payload.filename,
              chatModel: String(state.model || '').trim(),
              transcriptionModel: String(cfg.transcriptionModel || '').trim(),
            });
            transcript = String(result?.text || '').trim();
            if (transcript) break;
            attemptErrors.push('No transcribed speech was found in the recorded audio.');
          } catch (error) {
            attemptErrors.push(String(error?.message || error || 'Unknown transcription error'));
          }
        }

        if (!transcript) {
          throw new Error(attemptErrors.filter(Boolean).join(' | ') || 'No transcribed speech was found in the recorded audio.');
        }

        _voiceTranscriptionBlocked = false;
        finalizeVoiceCapture({ spokenText: transcript });
      } catch (error) {
        await stopRealtimeDictationSession();
        const raw = String(error?.message || error || '');
        const parts = raw.split('|').map((part) => part.trim()).filter(Boolean);
        const signals = parts.length > 0 ? parts : [raw];
        const allAccessBlocked = signals.every((entry) => isVoiceAccessError(entry));
        const anyNoSpeech = signals.some((entry) => isVoiceNoSpeechError(entry));
        const anyFormat = signals.some((entry) => isVoiceFormatError(entry));

        if (allAccessBlocked) {
          _voiceTranscriptionBlocked = true;
          setStatus(`Voice transcription model access issue: ${summarizeVoiceError(raw) || raw}`);
          applyVoiceSettingsToUi();
        } else if (anyNoSpeech) {
          if (maxRms < 0.01) {
            setStatus('Mic signal is very low. Select another microphone in Voice settings, then try again.');
          } else {
            const sample = signals.find((entry) => entry && !isVoiceFormatError(entry)) || signals[0] || raw;
            setStatus(`Audio was captured, but transcription returned no words. ${summarizeVoiceError(sample, { maxParts: 1, maxChars: 180 })}`);
          }
        } else if (anyFormat) {
          const sample = signals.find((entry) => isVoiceFormatError(entry)) || signals[0] || raw;
          setStatus(`Audio format was rejected by transcription service: ${summarizeVoiceError(sample, { maxParts: 1, maxChars: 180 })}`);
        } else {
          setStatus(`Voice transcription failed: ${summarizeVoiceError(raw) || raw}`);
        }
      } finally {
        _voiceTranscribing = false;
        updateVoiceMicButton();
      }
    };

    recorder.onerror = (event) => {
      state.voiceListening = false;
      updateVoiceMicButton();
      _voiceManualStop = true;
      _voiceRecorder = null;
      stopRecorderTracks();
      stopRealtimeDictationSession().catch(() => {});
      const code = String(event?.error?.name || event?.name || 'unknown').toLowerCase();
      setStatus(`Voice input error: ${code}.`);
    };

    recorder.start();
  } catch (error) {
    stopRealtimeDictationSession().catch(() => {});
    const message = String(error?.message || error || '');
    if (message.toLowerCase().includes('permission')) {
      setStatus('Microphone permission denied. Enable it in macOS settings and retry.');
      return;
    }
    setStatus(`Voice input could not start: ${message || 'unknown error'}`);
  }
}

function startVoiceCapture() {
  const cfg = getVoiceSettings();
  if (!cfg.enabled) {
    setStatus('Enable voice mode in Settings first.');
    return;
  }
  if (state.working) {
    setStatus('Wait until the current task finishes before recording voice input.');
    return;
  }
  if (state.voiceListening) return;

  _voiceManualStop = false;
  _voiceLastCaptureMode = 'none';
  _voiceFinalText = '';
  _voiceInterimText = '';
  resetRealtimeDictationState();
  state.voiceCapturePrefix = String(el.promptInput?.value || '').trim();
  _voiceSuppressEmptyNotice = false;

  // Prefer recorder mode in Electron for reliability; browser SpeechRecognition
  // often terminates early with "no-speech" on desktop app runtimes.
  if (supportsRecorderInput() && hasTranscriptionKey()) {
    startRecorderCapture().catch((error) => {
      setStatus(error.message || String(error));
    });
    return;
  }

  const recognition = ensureRecognition();
  if (recognition) {
    _voiceLastCaptureMode = 'recognition';
    try {
      recognition.start();
      return;
    } catch {
      // Fall through to recorder-based dictation.
    }
  }
  startRecorderCapture().catch((error) => {
    setStatus(error.message || String(error));
  });
}

function stopVoiceCapture() {
  if (!state.voiceListening) return;
  _voiceManualStop = true;
  if (_voiceRecorder && _voiceRecorder.state !== 'inactive') {
    try {
      _voiceRecorder.stop();
      return;
    } catch {
      stopRecorderTracks();
      stopRealtimeDictationSession().catch(() => {});
      state.voiceListening = false;
      updateVoiceMicButton();
    }
  }
  if (_voiceRecognition) {
    try {
      _voiceRecognition.stop();
      return;
    } catch {
      // Fall through to recorder stop.
    }
  }
  stopRealtimeDictationSession().catch(() => {});
}

function toggleVoiceCapture() {
  if (state.voiceListening) {
    stopVoiceCapture();
  } else {
    startVoiceCapture();
  }
}

function setVoiceSettingsPatch(patch, { persist = true, silent = true } = {}) {
  state.voice = normalizeVoiceSettings({ ...(state.voice || VOICE_DEFAULTS), ...(patch || {}) });
  applyVoiceSettingsToUi();
  if (persist) {
    persistVoiceSettings(silent).catch(() => {});
  }
}

function hydrateVoiceSettings(raw, { persist = false } = {}) {
  state.voice = normalizeVoiceSettings(raw || VOICE_DEFAULTS);
  applyVoiceSettingsToUi();
  if (persist) {
    persistVoiceSettings(true).catch(() => {});
  }
}

function cleanSpeechText(input) {
  let text = String(input || '');
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/`([^`]+)`/g, '$1');
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  text = text.replace(/^#+\s+/gm, '');
  text = text.replace(/^[*-]\s+/gm, '');
  text = text.replace(/^\d+\.\s+/gm, '');
  text = text.replace(/\*\*/g, '');
  text = text.replace(/\*/g, '');
  text = text.replace(/_+/g, '');
  text = text.replace(/\s+/g, ' ').trim();
  return text;
}

function summarizeForSpeech(input) {
  const cfg = getVoiceSettings();
  const cleaned = cleanSpeechText(input);
  if (!cleaned) return '';

  const statusMatch = cleaned.match(/status:\s*([^\n.]+)/i);
  const progressMatch = cleaned.match(/progress:\s*([^\n]+)/i);
  const reasonMatch = cleaned.match(/reason:\s*([^\n]+)/i);
  if (statusMatch || progressMatch || reasonMatch) {
    const parts = [];
    if (statusMatch) parts.push(`Status ${statusMatch[1].trim()}.`);
    if (progressMatch) parts.push(progressMatch[1].trim().replace(/\*+/g, '') + '.');
    if (reasonMatch) parts.push(reasonMatch[1].trim().replace(/\*+/g, '') + '.');
    const maxChars = cfg.replyStyle === 'balanced'
      ? Math.max(cfg.maxReplyChars, 360)
      : cfg.maxReplyChars;
    let summary = parts.join(' ').replace(/\s+/g, ' ').trim();
    if (summary.length > maxChars) {
      summary = `${summary.slice(0, Math.max(1, maxChars - 1)).trim()}…`;
    }
    return summary;
  }

  const sentenceSplit = cleaned.split(/(?<=[.!?])\s+/).filter(Boolean);
  const maxChars = cfg.replyStyle === 'balanced'
    ? Math.max(cfg.maxReplyChars, 360)
    : cfg.maxReplyChars;
  let out = '';
  for (let i = 0; i < sentenceSplit.length; i += 1) {
    const next = sentenceSplit[i];
    if (!next) continue;
    if (!out) {
      out = next;
      continue;
    }
    if ((out.length + 1 + next.length) > maxChars) break;
    if (i >= 2 && cfg.replyStyle === 'concise') break;
    out += ` ${next}`;
  }
  if (!out) out = cleaned.slice(0, maxChars);
  if (out.length > maxChars) out = `${out.slice(0, Math.max(1, maxChars - 1)).trim()}…`;
  return out;
}

function maybeSpeakAssistantResponse(content, { technical = false } = {}) {
  const cfg = getVoiceSettings();
  if (!cfg.enabled || !cfg.autoSpeak) return;
  if (technical) return;
  if (!supportsVoiceOutput()) return;
  if (state.voiceListening) return;

  const spoken = summarizeForSpeech(content);
  if (!spoken) return;

  const signature = spoken.toLowerCase();
  const now = Date.now();
  if (signature === _voiceLastSpokenSignature && now - _voiceLastSpokenAt < 4000) {
    return;
  }
  _voiceLastSpokenSignature = signature;
  _voiceLastSpokenAt = now;

  const synth = window.speechSynthesis;
  const utterance = new window.SpeechSynthesisUtterance(spoken);
  const selected = findPreferredVoice(_voiceVoices, cfg.voiceName || '');
  if (selected) utterance.voice = selected;
  utterance.rate = cfg.rate;
  utterance.pitch = cfg.pitch;
  utterance.volume = cfg.volume;

  synth.cancel();
  synth.speak(utterance);
}

function installVoiceEvents() {
  state.voice = normalizeVoiceSettings(state.voice || VOICE_DEFAULTS);
  state.voiceSupported = supportsVoiceInput() || supportsRecorderInput() || supportsVoiceOutput();

  if (window.speechSynthesis && typeof window.speechSynthesis.addEventListener === 'function') {
    window.speechSynthesis.addEventListener('voiceschanged', ensureVoiceOptions);
  }

  ensureVoiceOptions();
  refreshVoiceInputDevices({ requestPermission: false }).catch(() => {});
  applyVoiceSettingsToUi();

  if (!_voiceRealtimeUnsubscribe && window.geepus && typeof window.geepus.onAudioRealtimeEvent === 'function') {
    _voiceRealtimeUnsubscribe = window.geepus.onAudioRealtimeEvent((payload) => {
      const sessionId = String(payload?.sessionId || '').trim();
      if (!sessionId || sessionId !== String(_voiceRealtimeSessionId || '').trim()) return;
      const type = String(payload?.type || '').trim();
      if (type === 'ready') {
        _voiceRealtimeConnected = true;
        return;
      }
      if (type === 'transcript_delta') {
        const text = String(payload?.text || '').trim();
        if (!text) return;
        _voiceRealtimePartialText = _voiceRealtimePartialText && text.startsWith(_voiceRealtimePartialText)
          ? text
          : `${String(_voiceRealtimePartialText || '')} ${text}`.replace(/\s+/g, ' ').trim();
        _voiceInterimText = _voiceRealtimePartialText;
        updateVoiceDraft();
        return;
      }
      if (type === 'transcript_final') {
        const text = String(payload?.text || '').trim();
        if (!text) return;
        _voiceRealtimeFinalText = _voiceRealtimePartialText && !text.startsWith(_voiceRealtimePartialText)
          ? `${_voiceRealtimePartialText} ${text}`.replace(/\s+/g, ' ').trim()
          : text;
        _voiceRealtimePartialText = '';
        _voiceFinalText = _voiceRealtimeFinalText;
        _voiceInterimText = '';
        updateVoiceDraft();
        return;
      }
      if (type === 'error') {
        const message = String(payload?.message || '').trim();
        if (message) {
          setStatus(`Realtime dictation error: ${message}`);
        }
        return;
      }
      if (type === 'closed') {
        _voiceRealtimeConnected = false;
      }
    });
  }

  if (el.voiceMicButton) {
    el.voiceMicButton.addEventListener('click', () => {
      toggleVoiceCapture();
    });
  }

  if (el.voiceEnabledToggle) {
    el.voiceEnabledToggle.addEventListener('change', () => {
      const enabled = Boolean(el.voiceEnabledToggle.checked);
      setVoiceSettingsPatch({ enabled }, { persist: true, silent: false });
      if (!enabled && state.voiceListening) stopVoiceCapture();
      if (enabled) {
        refreshVoiceInputDevices({ requestPermission: true }).catch(() => {});
      }
    });
  }

  if (el.voiceAutoSpeakToggle) {
    el.voiceAutoSpeakToggle.addEventListener('change', () => {
      setVoiceSettingsPatch({ autoSpeak: Boolean(el.voiceAutoSpeakToggle.checked) }, { persist: true, silent: true });
    });
  }

  if (el.voiceAutoSendToggle) {
    el.voiceAutoSendToggle.addEventListener('change', () => {
      setVoiceSettingsPatch({ autoSend: Boolean(el.voiceAutoSendToggle.checked) }, { persist: true, silent: true });
    });
  }

  if (el.voiceRealtimeToggle) {
    el.voiceRealtimeToggle.addEventListener('change', () => {
      setVoiceSettingsPatch({ realtimeDictation: Boolean(el.voiceRealtimeToggle.checked) }, { persist: true, silent: true });
      setStatus(el.voiceRealtimeToggle.checked
        ? 'Realtime dictation enabled.'
        : 'Realtime dictation disabled. Falling back to standard transcription.');
    });
  }

  if (el.voiceOpenaiKeyInput) {
    el.voiceOpenaiKeyInput.addEventListener('change', () => {
      const raw = String(el.voiceOpenaiKeyInput.value || '').trim();
      // Don't overwrite with the masked placeholder
      if (raw && !raw.startsWith('••')) {
        setVoiceSettingsPatch({ openaiApiKey: raw }, { persist: true, silent: true });
        setStatus('OpenAI voice key saved.');
      }
    });
    // Clear the mask on focus so the user can type a new key
    el.voiceOpenaiKeyInput.addEventListener('focus', () => {
      if (el.voiceOpenaiKeyInput.value.startsWith('••')) {
        el.voiceOpenaiKeyInput.value = '';
      }
    });
    // Restore mask if they blur without typing anything
    el.voiceOpenaiKeyInput.addEventListener('blur', () => {
      const cfg = getVoiceSettings();
      if (!el.voiceOpenaiKeyInput.value && cfg.openaiApiKey) {
        el.voiceOpenaiKeyInput.value = '••••••••';
      }
    });
  }

  if (el.voiceTranscriptionModelSelect) {
    el.voiceTranscriptionModelSelect.addEventListener('change', () => {
      setVoiceSettingsPatch(
        { transcriptionModel: String(el.voiceTranscriptionModelSelect.value || '').trim() },
        { persist: true, silent: true },
      );
      setStatus('Voice transcription model saved.');
    });
  }

  if (el.voiceNameSelect) {
    el.voiceNameSelect.addEventListener('change', () => {
      setVoiceSettingsPatch({ voiceName: String(el.voiceNameSelect.value || '').trim() }, { persist: true, silent: true });
    });
  }

  if (el.voiceInputDeviceSelect) {
    el.voiceInputDeviceSelect.addEventListener('change', () => {
      setVoiceSettingsPatch({ inputDeviceId: String(el.voiceInputDeviceSelect.value || '').trim() }, { persist: true, silent: true });
      setStatus('Microphone selection saved.');
    });
  }

  if (el.voiceRefreshDevicesButton) {
    el.voiceRefreshDevicesButton.addEventListener('click', () => {
      refreshVoiceInputDevices({ requestPermission: true }).catch(() => {
        setStatus('Could not refresh microphone list.');
      });
    });
  }

  if (el.voiceReplyStyleSelect) {
    el.voiceReplyStyleSelect.addEventListener('change', () => {
      const value = el.voiceReplyStyleSelect.value === 'balanced' ? 'balanced' : 'concise';
      setVoiceSettingsPatch({ replyStyle: value }, { persist: true, silent: true });
    });
  }

  if (el.voiceRateInput) {
    el.voiceRateInput.addEventListener('input', () => {
      const rate = clampVoiceNumber(el.voiceRateInput.value, 0.75, 1.35, VOICE_DEFAULTS.rate);
      state.voice = normalizeVoiceSettings({ ...(state.voice || VOICE_DEFAULTS), rate });
      applyVoiceSettingsToUi();
    });
    el.voiceRateInput.addEventListener('change', () => {
      const rate = clampVoiceNumber(el.voiceRateInput.value, 0.75, 1.35, VOICE_DEFAULTS.rate);
      setVoiceSettingsPatch({ rate }, { persist: true, silent: true });
    });
  }

  document.addEventListener('keydown', (event) => {
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && event.code === 'Space') {
      event.preventDefault();
      toggleVoiceCapture();
    }
  });
}
