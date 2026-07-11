import { useEffect, useState } from 'react';
import type { OllamaPullProgress } from '@shared/model';
import type { DiscoveryReport, MachineProfile, Recommendation, SetupPlan } from '@shared/setup';
import { askOnce } from '../lib/askOnce';

type Stage = 'probing' | 'path' | 'busy' | 'permissions';

function formatPct(done: number, total: number): number {
  return total > 0 ? Math.round((done / total) * 100) : 0;
}

export function Onboarding({ onComplete }: { onComplete: () => void }) {
  const [stage, setStage] = useState<Stage>('probing');
  const [profile, setProfile] = useState<MachineProfile | null>(null);
  const [discovery, setDiscovery] = useState<DiscoveryReport | null>(null);
  const [recommendation, setRecommendation] = useState<Recommendation | null>(null);
  const [plan, setPlan] = useState<SetupPlan | null>(null);
  const [busyLabel, setBusyLabel] = useState('');
  const [busyPct, setBusyPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [voiceMessage, setVoiceMessage] = useState<string | null>(null);
  const [notificationStatus, setNotificationStatus] = useState<'idle' | 'sent'>('idle');

  useEffect(() => {
    (async () => {
      const [p, d] = await Promise.all([window.geepus.setup.probeHardware(), window.geepus.setup.discover()]);
      setProfile(p);
      setDiscovery(d);
      const [r, plan] = await Promise.all([window.geepus.setup.recommend(p), window.geepus.setup.determinePath(p, d)]);
      setRecommendation(r);
      setPlan(plan);
      setStage('path');
    })();
  }, []);

  const ollamaRuntime = discovery?.runtimes.find((r) => r.id === 'ollama');
  const suitableModel = ollamaRuntime?.models.find(
    (m) => m.chatCapable && m.sizeGb > 0 && profile && m.sizeGb <= profile.ramGb * 0.6,
  );

  async function speakWelcome(summary: string) {
    if (!profile || !plan) return;
    try {
      const text = await askOnce(
        `In two short, friendly sentences, welcome the user to Geepus and briefly explain what just happened during setup. Context: ${summary}`,
        'You are Geepus, a friendly local-only digital assistant. Keep it warm, brief, and concrete — no fluff.',
      );
      setVoiceMessage(text.trim());
    } catch {
      setVoiceMessage(summary);
    }
  }

  async function runPathA() {
    if (!suitableModel) return;
    setStage('busy');
    setBusyLabel(`Using ${suitableModel.name}…`);
    try {
      await window.geepus.setup.adoptOllamaModel(suitableModel.name);
      void speakWelcome(`Adopted the already-installed Ollama model ${suitableModel.name}.`);
      setStage('permissions');
    } catch (err) {
      setError((err as Error).message);
      setStage('path');
    }
  }

  async function runPathB() {
    const tag = recommendation?.chatModel?.ollamaTag;
    if (!tag) return;
    setStage('busy');
    setBusyLabel(`Downloading ${tag}…`);
    setBusyPct(0);
    const unsubscribe = window.geepus.setup.pullModel(tag, (progress: OllamaPullProgress) => {
      setBusyLabel(progress.status);
      if (progress.totalBytes) setBusyPct(formatPct(progress.completedBytes ?? 0, progress.totalBytes));
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the subscription attach first
      await window.geepus.setup.adoptOllamaModel(tag);
      void speakWelcome(`Downloaded and started using ${tag}.`);
      setStage('permissions');
    } catch (err) {
      setError((err as Error).message);
      setStage('path');
    } finally {
      unsubscribe();
      setBusyPct(null);
    }
  }

  async function runUseBundled() {
    setStage('busy');
    setBusyLabel('Switching to the built-in brain…');
    try {
      await window.geepus.setup.useBundled();
      void speakWelcome('Switched to the built-in tiny local model — no extra downloads needed right now.');
      setStage('permissions');
    } catch (err) {
      setError((err as Error).message);
      setStage('path');
    }
  }

  async function runInstallOllama() {
    setStage('busy');
    setError(null);
    try {
      setBusyLabel('Downloading Ollama…');
      setBusyPct(0);
      await window.geepus.setup.installOllama((progress) => setBusyPct(formatPct(progress.downloadedBytes, progress.totalBytes)));

      setBusyLabel('Starting Ollama…');
      setBusyPct(null);
      const launched = await window.geepus.setup.launchOllama();
      if (!launched) throw new Error('Ollama installed, but its server did not start in time.');

      const tag = recommendation?.chatModel?.ollamaTag;
      if (tag) {
        setBusyLabel(`Downloading ${tag}…`);
        setBusyPct(0);
        const unsubscribe = window.geepus.setup.pullModel(tag, (progress) => {
          setBusyLabel(progress.status);
          if (progress.totalBytes) setBusyPct(formatPct(progress.completedBytes ?? 0, progress.totalBytes));
        });
        try {
          await window.geepus.setup.adoptOllamaModel(tag);
        } finally {
          unsubscribe();
        }
      }
      void speakWelcome('Installed Ollama and downloaded a model that fits this machine.');
      setStage('permissions');
    } catch (err) {
      setError((err as Error).message);
      setStage('path');
    } finally {
      setBusyPct(null);
    }
  }

  async function finish() {
    await window.geepus.setup.completeOnboarding();
    onComplete();
  }

  async function sendTestNotification() {
    await window.geepus.setup.requestNotificationPermission();
    setNotificationStatus('sent');
  }

  if (stage === 'probing') {
    return (
      <div className="onboarding">
        <p className="hint">Looking at your machine…</p>
      </div>
    );
  }

  if (stage === 'busy') {
    return (
      <div className="onboarding">
        <p>{busyLabel}</p>
        {busyPct !== null && <div className="download-bar">{busyPct}%</div>}
      </div>
    );
  }

  if (stage === 'permissions') {
    return (
      <div className="onboarding">
        {voiceMessage && (
          <div className="message assistant">
            <strong>geepus</strong>
            <p>{voiceMessage}</p>
          </div>
        )}
        <h2>One quick thing</h2>
        <p>
          Geepus will ask for anything else (email, browser, folders) only the first time it's actually needed. For
          now, it'd like permission to notify you about your daily brief and anything urgent.
        </p>
        <button onClick={() => void sendTestNotification()}>
          {notificationStatus === 'sent' ? 'Notification sent ✓' : 'Allow notifications'}
        </button>
        <button onClick={() => void finish()}>Start using Geepus</button>
      </div>
    );
  }

  // stage === 'path'
  return (
    <div className="onboarding">
      <h1>Welcome to Geepus</h1>
      {profile && (
        <p className="hint">
          {profile.chip} · {profile.ramGb}GB RAM · {profile.osVersion}
        </p>
      )}
      {error && <p className="error">⚠️ {error}</p>}

      {plan?.path === 'A' && suitableModel && (
        <div className="path-card">
          <p>I found Ollama already running with <strong>{suitableModel.name}</strong> installed — that's a great fit for this machine.</p>
          <button onClick={() => void runPathA()}>Use {suitableModel.name}</button>
        </div>
      )}

      {plan?.path === 'B' && (
        <div className="path-card">
          <p>
            I found Ollama, but no model that fits yet. I'd recommend{' '}
            <strong>{recommendation?.chatModel?.ollamaTag}</strong> (~{recommendation?.chatModel?.sizeGb}GB).
          </p>
          <button onClick={() => void runPathB()}>Download it</button>
          <button onClick={() => void runUseBundled()}>Use the built-in brain instead</button>
        </div>
      )}

      {plan?.path === 'C' && (
        <div className="path-card">
          <p>I didn't find a local LLM runtime on this machine yet. You've got two easy options:</p>
          <button onClick={() => void runInstallOllama()}>Install Ollama for me</button>
          <button onClick={() => void runUseBundled()}>Just use the built-in brain</button>
        </div>
      )}

      {plan?.path === 'D' && (
        <div className="path-card">
          <p>
            This machine has {profile?.ramGb}GB of RAM, below what's needed to run bigger local models comfortably.
            Geepus will use its built-in tiny brain — it's small, fast, and works offline right away.
          </p>
          <button onClick={() => void runUseBundled()}>Continue</button>
        </div>
      )}
    </div>
  );
}
