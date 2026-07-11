import { useEffect, useState } from 'react';
import { Onboarding } from './onboarding/Onboarding';
import { Chat } from './chat/Chat';
import { AgentRunner } from './agent/AgentRunner';
import { ApprovalsInbox } from './agent/ApprovalsInbox';
import { MemoryBrowser } from './memory/MemoryBrowser';
import { SchedulesPanel } from './schedule/SchedulesPanel';
import { BriefPanel } from './brief/BriefPanel';
import { PermissionsPanel } from './settings/PermissionsPanel';

type View = 'chat' | 'agent' | 'approvals' | 'memory' | 'schedules' | 'brief' | 'permissions';

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
    { id: 'agent', label: 'Agent' },
    { id: 'brief', label: 'Brief' },
    { id: 'schedules', label: 'Schedules' },
    { id: 'approvals', label: 'Approvals' },
    { id: 'memory', label: 'Memory' },
    { id: 'permissions', label: 'Permissions' },
  ];

  return (
    <main className="shell">
      <nav className="tabs">
        {views.map((v) => (
          <button key={v.id} className={view === v.id ? 'active' : ''} onClick={() => setView(v.id)}>
            {v.label}
          </button>
        ))}
      </nav>
      {view === 'chat' && <Chat />}
      {view === 'agent' && <AgentRunner />}
      {view === 'brief' && <BriefPanel />}
      {view === 'schedules' && <SchedulesPanel />}
      {view === 'approvals' && <ApprovalsInbox />}
      {view === 'memory' && <MemoryBrowser />}
      {view === 'permissions' && <PermissionsPanel />}
    </main>
  );
}
