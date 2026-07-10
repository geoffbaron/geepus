import { useEffect, useRef, useState } from 'react';
import type { ChatMessage, ProviderId, ProviderStatus } from '@shared/model';

export function App() {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [activeProvider, setActiveProvider] = useState<ProviderId>('bundled');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ downloadedBytes: number; totalBytes: number } | null>(
    null,
  );
  const unsubscribeRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    window.geepus.models.listProviders().then(setProviders);
    window.geepus.settings.get().then((s) => setActiveProvider(s.activeProvider));
    return window.geepus.models.onBundledDownloadProgress(setDownloadProgress);
  }, []);

  async function refreshProviders() {
    setProviders(await window.geepus.models.listProviders());
  }

  async function handleProviderChange(next: ProviderId) {
    const settings = await window.geepus.settings.update({ activeProvider: next });
    setActiveProvider(settings.activeProvider);
  }

  function send() {
    const text = input.trim();
    if (!text || streaming) return;

    const nextMessages: ChatMessage[] = [...messages, { role: 'user', content: text }];
    setMessages([...nextMessages, { role: 'assistant', content: '' }]);
    setInput('');
    setStreaming(true);

    unsubscribeRef.current = window.geepus.models.chat({ messages: nextMessages }, (chunk) => {
      if (chunk.type === 'text') {
        setMessages((prev) => {
          const next = [...prev];
          const lastIndex = next.length - 1;
          const last = next[lastIndex];
          if (last?.role === 'assistant') next[lastIndex] = { ...last, content: last.content + chunk.delta };
          return next;
        });
      } else if (chunk.type === 'error') {
        setMessages((prev) => {
          const next = [...prev];
          const lastIndex = next.length - 1;
          const last = next[lastIndex];
          if (last?.role === 'assistant') next[lastIndex] = { ...last, content: `⚠️ ${chunk.message}` };
          return next;
        });
        setStreaming(false);
        unsubscribeRef.current?.();
        void refreshProviders();
      } else if (chunk.type === 'done') {
        setStreaming(false);
        unsubscribeRef.current?.();
      }
    });
  }

  return (
    <main className="shell">
      <header className="providers">
        {providers.map((p) => (
          <span key={p.id} className={`pill ${p.available ? 'available' : 'unavailable'}`}>
            {p.id}
          </span>
        ))}
        <select value={activeProvider} onChange={(e) => void handleProviderChange(e.target.value as ProviderId)}>
          <option value="bundled">bundled</option>
          <option value="ollama">ollama</option>
          <option value="openrouter">openrouter (dev)</option>
        </select>
      </header>

      {downloadProgress && downloadProgress.downloadedBytes < downloadProgress.totalBytes && (
        <div className="download-bar">
          Downloading starter model…{' '}
          {Math.round((downloadProgress.downloadedBytes / downloadProgress.totalBytes) * 100)}%
        </div>
      )}

      <div className="messages">
        {messages.length === 0 && <p className="hint">Ask Geepus something.</p>}
        {messages.map((m, i) => (
          <div key={i} className={`message ${m.role}`}>
            <strong>{m.role}</strong>
            <p>{m.content || (streaming && i === messages.length - 1 ? '…' : '')}</p>
          </div>
        ))}
      </div>

      <div className="composer">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Ask Geepus…"
          disabled={streaming}
        />
        <button onClick={send} disabled={streaming || !input.trim()}>
          Send
        </button>
      </div>
    </main>
  );
}
