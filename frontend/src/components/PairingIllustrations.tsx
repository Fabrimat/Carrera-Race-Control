// Simple inline SVG illustrations for the pairing wizard. Decorative: the step text carries the meaning.
const common = {
  viewBox: '0 0 120 72',
  width: 120,
  height: 72,
  'aria-hidden': true,
  focusable: false,
} as const

/** Step 1: the Control Unit with its CODE LED blinking. */
export function CuCodeLed() {
  return (
    <svg {...common} data-testid="pair-art-code">
      <rect x="10" y="14" width="100" height="46" rx="6" fill="#1b2128" stroke="#2a323b" strokeWidth="2" />
      <rect x="18" y="22" width="40" height="10" rx="2" fill="#0b0d10" />
      <circle cx="90" cy="27" r="7" fill="#ff3b30" className="animate-pulse motion-reduce:animate-none" />
      <circle cx="90" cy="27" r="11" fill="none" stroke="#ff3b30" strokeWidth="1.5" opacity="0.5" />
      <rect x="18" y="40" width="26" height="12" rx="3" fill="#2a323b" />
      <text x="31" y="49" textAnchor="middle" fontSize="8" fill="#e8ecef" fontFamily="monospace">
        CODE
      </text>
      <rect x="52" y="40" width="26" height="12" rx="3" fill="#2a323b" />
    </svg>
  )
}

/** Step 2: the car on the track. */
export function CarOnTrack() {
  return (
    <svg {...common} data-testid="pair-art-car">
      <rect x="4" y="26" width="112" height="26" rx="4" fill="#1b2128" stroke="#2a323b" strokeWidth="2" />
      <line x1="8" y1="39" x2="112" y2="39" stroke="#2a323b" strokeWidth="2" strokeDasharray="6 5" />
      <g>
        <rect x="40" y="31" width="36" height="14" rx="4" fill="#e53935" />
        <rect x="52" y="34" width="12" height="8" rx="2" fill="#0b0d10" opacity="0.7" />
        <rect x="44" y="28" width="7" height="4" rx="1" fill="#e8ecef" />
        <rect x="44" y="44" width="7" height="4" rx="1" fill="#e8ecef" />
        <rect x="66" y="28" width="7" height="4" rx="1" fill="#e8ecef" />
        <rect x="66" y="44" width="7" height="4" rx="1" fill="#e8ecef" />
      </g>
    </svg>
  )
}

/** Step 3: the controller with the lane-change button highlighted. */
export function ControllerButton() {
  return (
    <svg {...common} data-testid="pair-art-button">
      <path d="M30 10 h42 a10 10 0 0 1 10 10 v34 a12 12 0 0 1 -12 12 h-28 a12 12 0 0 1 -12 -12 z" fill="#1b2128" stroke="#2a323b" strokeWidth="2" />
      <rect x="40" y="18" width="22" height="8" rx="2" fill="#0b0d10" />
      <circle cx="51" cy="44" r="9" fill="#ffb000" className="animate-pulse motion-reduce:animate-none" />
      <circle cx="51" cy="44" r="13" fill="none" stroke="#ffb000" strokeWidth="1.5" opacity="0.5" />
      <path d="M92 30 l-12 10" stroke="#ffb000" strokeWidth="2" strokeLinecap="round" />
      <path d="M80 40 l1 -7 M80 40 l7 0" stroke="#ffb000" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

/** Step 4: drive across the start / finish line. */
export function CrossTheLine() {
  return (
    <svg {...common} data-testid="pair-art-line">
      <rect x="4" y="26" width="112" height="26" rx="4" fill="#1b2128" stroke="#2a323b" strokeWidth="2" />
      {[0, 1, 2, 3].map((i) => (
        <g key={i}>
          <rect x="60" y={28 + i * 6} width="5" height="6" fill={i % 2 ? '#e8ecef' : '#0b0d10'} />
          <rect x="65" y={28 + i * 6} width="5" height="6" fill={i % 2 ? '#0b0d10' : '#e8ecef'} />
        </g>
      ))}
      <rect x="14" y="33" width="26" height="12" rx="4" fill="#e53935" />
      <path d="M46 39 h10 m-4 -4 l4 4 l-4 4" stroke="#30d158" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
