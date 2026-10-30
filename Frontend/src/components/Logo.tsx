/** Same mark as public/favicon.svg, so the header and browser tab always match. */
export default function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className="topbar__logo">
      <rect x="0.5" y="0.5" width="23" height="23" rx="5" fill="#0A0A0A" stroke="#262626" />
      <g stroke="#EDEDED" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <line x1="6" x2="6" y1="3" y2="15" />
        <circle cx="18" cy="6" r="3" fill="#0A0A0A" />
        <circle cx="6" cy="18" r="3" fill="#0A0A0A" />
        <path d="M18 9a9 9 0 0 1-9 9" />
      </g>
    </svg>
  );
}
