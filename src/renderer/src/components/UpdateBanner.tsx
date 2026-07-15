import { useEffect, useState } from 'react';
import type { UpdateStatus } from '@shared/update';

/**
 * A quiet update banner. Downloads happen silently in the background; the user only ever
 * sees this once an update is fully downloaded and ready ("Restart to update"), or a faint
 * progress line while it's coming down. Every other state — checking, up-to-date, offline,
 * error — shows nothing, because an assistant that nags about updates isn't simple to use.
 */
export function UpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus>({ state: 'idle' });

  useEffect(() => {
    void window.geepus.updates.getStatus().then(setStatus);
    return window.geepus.updates.onStatus(setStatus);
  }, []);

  if (status.state === 'ready') {
    return (
      <div className="update-banner ready">
        <span>A new version of Geepus is ready.</span>
        <button className="primary" onClick={() => void window.geepus.updates.installNow()}>
          Restart to update
        </button>
      </div>
    );
  }

  if (status.state === 'downloading' && status.percent > 0) {
    return (
      <div className="update-banner">
        <span className="spinner" /> Downloading a small update… {status.percent}%
      </div>
    );
  }

  return null;
}
