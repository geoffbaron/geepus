import { useEffect, useState } from 'react';
import { Onboarding } from './onboarding/Onboarding';
import { Chat } from './chat/Chat';
import { BriefPanel } from './brief/BriefPanel';
import { SchedulesPanel } from './schedule/SchedulesPanel';
import { PermissionsPanel } from './settings/PermissionsPanel';
import { ApprovalRequests } from './components/ApprovalRequests';
import { UpdateBanner } from './components/UpdateBanner';

/**
 * Four places, no jargon: Chat (the assistant), Today (your summary), Routines
 * (what it does on its own), Settings. Permission requests pop up wherever you are —
 * there's no inbox to check.
 */
type View = 'chat' | 'today' | 'routines' | 'settings';

export function App() {
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);
  const [view, setView] = useState<View>('chat');

  useEffect(() => {
    window.geepus.settings.get().then((s) => setOnboardingComplete(s.onboardingComplete));
  }, []);

  if (onboardingComplete === null) return null;
  if (!onboardingComplete) return <Onboarding onComplete={() => setOnboardingComplete(true)} />;

  const views: Array<{ id: View; label: string }> = [
    { id: 'chat', label: 'Chat' },
    { id: 'today', label: 'Today' },
    { id: 'routines', label: 'Routines' },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <main className="shell">
      <nav className="tabs">
        <span className="wordmark">Geepus</span>
        {views.map((v) => (
          <button key={v.id} className={view === v.id ? 'active' : ''} onClick={() => setView(v.id)}>
            {v.label}
          </button>
        ))}
      </nav>
      <UpdateBanner />
      <ApprovalRequests />
      {view === 'chat' && <Chat />}
      {view === 'today' && <BriefPanel />}
      {view === 'routines' && <SchedulesPanel />}
      {view === 'settings' && <PermissionsPanel />}
    </main>
  );
}
