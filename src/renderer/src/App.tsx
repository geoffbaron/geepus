import { useEffect, useState } from 'react';
import { Onboarding } from './onboarding/Onboarding';
import { Chat } from './chat/Chat';
import { PermissionsPanel } from './settings/PermissionsPanel';

type View = 'chat' | 'permissions';

export function App() {
  const [onboardingComplete, setOnboardingComplete] = useState<boolean | null>(null);
  const [view, setView] = useState<View>('chat');

  useEffect(() => {
    window.geepus.settings.get().then((s) => setOnboardingComplete(s.onboardingComplete));
  }, []);

  if (onboardingComplete === null) return null;
  if (!onboardingComplete) return <Onboarding onComplete={() => setOnboardingComplete(true)} />;

  return (
    <main className="shell">
      <nav className="tabs">
        <button className={view === 'chat' ? 'active' : ''} onClick={() => setView('chat')}>
          Chat
        </button>
        <button className={view === 'permissions' ? 'active' : ''} onClick={() => setView('permissions')}>
          Permissions
        </button>
      </nav>
      {view === 'chat' ? <Chat /> : <PermissionsPanel />}
    </main>
  );
}
