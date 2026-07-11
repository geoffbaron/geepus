/** The Geepus face — same orb as the app icon (resources/icon.svg), minus the background. */
export function Orb({ size = 56 }: { size?: number }) {
  return (
    <svg className="welcome-orb" width={size} height={size} viewBox="0 0 512 512" aria-hidden>
      <defs>
        <radialGradient id="orb-fill" cx="0.34" cy="0.28" r="0.95">
          <stop offset="0" stopColor="#cdb4ff" />
          <stop offset="0.35" stopColor="#9b7bf7" />
          <stop offset="0.75" stopColor="#5f63ee" />
          <stop offset="1" stopColor="#3f4bd8" />
        </radialGradient>
        <radialGradient id="orb-spec" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.85" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="256" cy="256" r="238" fill="url(#orb-fill)" />
      <ellipse cx="164" cy="146" rx="155" ry="125" fill="url(#orb-spec)" opacity="0.5" />
      <rect x="168" y="172" width="50" height="98" rx="25" fill="#ffffff" opacity="0.96" />
      <rect x="294" y="172" width="50" height="98" rx="25" fill="#ffffff" opacity="0.96" />
      <path d="M 186 338 Q 256 396 326 338" fill="none" stroke="#ffffff" strokeOpacity="0.94" strokeWidth="30" strokeLinecap="round" />
    </svg>
  );
}
