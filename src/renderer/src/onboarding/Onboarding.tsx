import { useEffect, useState } from 'react';
import type { OllamaPullProgress } from '@shared/model';
import type { DiscoveryReport, MachineProfile, Recommendation, SetupPlan } from '@shared/setup';
import { askOnce } from '../lib/askOnce';
import { Orb } from '../components/Orb';

/**
 * First-run setup, written for someone's dad: no "Ollama", no "LLM", no "runtime" in the
 * headline copy — Geepus talks about "brains" and does the technical work silently.
 * The actual model/runtime names stay available under a "curious?" disclosure.
 */
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
        `In two short, friendly sentences, welcome me to Geepus and briefly explain what just happened during setup. Address me directly as "you" — never say "the user". No technical jargon — say "brain", not "model" or "Ollama". Context: ${summary}`,
        'You are Geepus, a friendly personal assistant that lives on this person\'s own computer. Speak to them directly. Keep it warm, brief, and concrete — no fluff, no jargon.',
      );
      setVoiceMessage(text.trim());
    } catch {
      setVoiceMessage("You're all set up. Ask me anything!");
    }
  }

  async function runPathA() {
    if (!suitableModel) return;
    setStage('busy');
    setBusyLabel('Connecting things up…');
    try {
      await window.geepus.setup.adoptOllamaModel(suitableModel.name);
      void speakWelcome(`Found a capable brain already on this computer and connected to it.`);
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
    setBusyLabel('Downloading the smarter brain…');
    setBusyPct(0);
    const unsubscribe = window.geepus.setup.pullModel(tag, (progress: OllamaPullProgress) => {
      if (progress.totalBytes) setBusyPct(formatPct(progress.completedBytes ?? 0, progress.totalBytes));
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0)); // let the subscription attach first
      await window.geepus.setup.adoptOllamaModel(tag);
      void speakWelcome('Downloaded a brain that fits this computer nicely.');
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
    setBusyLabel('Almost there…');
    try {
      await window.geepus.setup.useBundled();
      void speakWelcome('Using the built-in brain — ready right away, nothing to download.');
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
      setBusyLabel('Setting things up — this takes a few minutes…');
      setBusyPct(0);
      await window.geepus.setup.installOllama((progress) => setBusyPct(formatPct(progress.downloadedBytes, progress.totalBytes)));

      setBusyLabel('Starting things up…');
      setBusyPct(null);
      const launched = await window.geepus.setup.launchOllama();
      if (!launched) throw new Error("Something didn't start in time. It's safe to just try again.");

      const tag = recommendation?.chatModel?.ollamaTag;
      if (tag) {
        setBusyLabel('Downloading the brain — the big part, almost done…');
        setBusyPct(0);
        const unsubscribe = window.geepus.setup.pullModel(tag, (progress) => {
          if (progress.totalBytes) setBusyPct(formatPct(progress.completedBytes ?? 0, progress.totalBytes));
        });
        try {
          await window.geepus.setup.adoptOllamaModel(tag);
        } finally {
          unsubscribe();
        }
      }
      void speakWelcome('Set everything up automatically, including a brain that fits this computer.');
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
      <div className="onboarding centered">
        <Orb size={72} />
        <h1>Hi, I'm Geepus.</h1>
        <p className="muted">
          <span className="spinner" /> Taking a quick look at your computer…
        </p>
      </div>
    );
  }

  if (stage === 'busy') {
    return (
      <div className="onboarding centered">
        <Orb size={72} />
        <p>{busyLabel}</p>
        {busyPct !== null && (
          <div className="progress">
            <div className="progress-fill" style={{ width: `${busyPct}%` }} />
          </div>
        )}
        {busyPct !== null && <p className="muted">{busyPct}%</p>}
      </div>
    );
  }

  if (stage === 'permissions') {
    return (
      <div className="onboarding">
        {voiceMessage && (
          <div className="bubble assistant standalone">
            <p>{voiceMessage}</p>
          </div>
        )}
        <h2>One last thing</h2>
        <p>
          Can Geepus send you a notification when your daily summary is ready, or when something looks urgent?
          That's the only permission it wants up front — anything else, it'll ask about when it comes up.
        </p>
        <button onClick={() => void sendTestNotification()}>
          {notificationStatus === 'sent' ? 'Notification sent ✓' : 'Yes, allow notifications'}
        </button>
        <button className="primary big" onClick={() => void finish()}>
          Start using Geepus
        </button>
      </div>
    );
  }

  // stage === 'path'
  return (
    <div className="onboarding">
      <Orb size={72} />
      <h1>Hi, I'm Geepus.</h1>
      <p>
        I'm a personal assistant that lives entirely on this Mac — private by design. Let's get you set up; it only
        takes a minute.
      </p>
      {error && <p className="problem">⚠️ {error}</p>}

      {plan?.path === 'A' && suitableModel && (
        <div className="card">
          <p>
            <strong>Good news:</strong> your computer already has everything I need. You're ready to go.
          </p>
          <button className="primary big" onClick={() => void runPathA()}>
            Sounds good — let's go
          </button>
          <details className="advanced">
            <summary>Curious what I found?</summary>
            <p className="muted">
              An Ollama server is already running with the model "{suitableModel.name}" (~{suitableModel.sizeGb}GB) —
              a good fit for your {profile?.ramGb}GB of memory.
            </p>
          </details>
        </div>
      )}

      {plan?.path === 'B' && (
        <div className="card">
          <p>
            Your computer can run a <strong>smarter brain</strong> than what's on it right now. I can download one
            (about {recommendation?.chatModel?.sizeGb}GB — a few minutes) — or you can start right away with my
            built-in one and upgrade later.
          </p>
          <button className="primary big" onClick={() => void runPathB()}>
            Download the smarter brain
          </button>
          <button onClick={() => void runUseBundled()}>Start right away instead</button>
          <details className="advanced">
            <summary>Curious about the details?</summary>
            <p className="muted">
              Ollama is installed but has no chat model that fits. The recommendation is{' '}
              {recommendation?.chatModel?.ollamaTag} for this machine's {profile?.ramGb}GB of memory.
            </p>
          </details>
        </div>
      )}

      {plan?.path === 'C' && (
        <div className="card">
          <p>
            Two ways to go, both easy: I can <strong>set everything up for you</strong> (takes a few minutes,
            gets you the smartest setup) — or you can <strong>start right now</strong> with my built-in brain.
          </p>
          <button className="primary big" onClick={() => void runInstallOllama()}>
            Set it up for me
          </button>
          <button onClick={() => void runUseBundled()}>Start right now</button>
          <details className="advanced">
            <summary>Curious what "set it up" means?</summary>
            <p className="muted">
              It installs Ollama (a free, private program for running AI on your own computer) and downloads{' '}
              {recommendation?.chatModel?.ollamaTag ?? 'a model'} sized for this machine. Nothing leaves your Mac.
            </p>
          </details>
        </div>
      )}

      {plan?.path === 'D' && (
        <div className="card">
          <p>
            I'll use my <strong>built-in brain</strong> on this computer — it's quick, works offline, and is ready
            right now.
          </p>
          <button className="primary big" onClick={() => void runUseBundled()}>
            Continue
          </button>
          <details className="advanced">
            <summary>Curious why?</summary>
            <p className="muted">
              This machine has {profile?.ramGb}GB of memory — below the comfortable minimum for larger local models,
              so the small bundled one is the reliable choice.
            </p>
          </details>
        </div>
      )}
    </div>
  );
}
