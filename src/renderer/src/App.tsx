import { useEffect, useState } from 'react';

export function App() {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    window.geepus.app.getVersion().then(setVersion);
  }, []);

  return (
    <main className="shell">
      <h1>Geepus</h1>
      <p>Local-only digital assistant — M0 scaffold.</p>
      <p className="version">
        {version ? `app v${version}` : 'reaching main process…'}
      </p>
    </main>
  );
}
