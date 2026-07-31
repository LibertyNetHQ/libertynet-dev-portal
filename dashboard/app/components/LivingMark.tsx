"use client";

import { useMemo } from "react";

/**
 * The LivingMark, genuinely generated rather than a fixed asset.
 *
 * Three arcs orbit at 43s, 61s and 79s — pairwise coprime, so the figure does not
 * repeat for ~2.4 days of continuous display. On top of that, each mount picks a
 * random starting phase, so no two page loads show the same arrangement. That is
 * the "different every time" property the static SVG in the docs can only
 * approximate.
 *
 * Motion stays inside the 95%-silence budget: the fastest arc moves under a pixel
 * per frame at this size and reads as still. It stops entirely under
 * prefers-reduced-motion.
 */
export function LivingMark({ size = 26 }: { size?: number }) {
  // Random once per mount, never re-rolled on re-render — a mark that jumped on
  // every state change would be noise, which is exactly what silence forbids.
  const phase = useMemo(
    () => [Math.random() * -43, Math.random() * -61, Math.random() * -79],
    [],
  );

  return (
    <svg
      className="mark"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      role="img"
      aria-label="LibertyNet"
    >
      <style>{`
        .lm-ring { fill: none; stroke: var(--cyan); stroke-linecap: round; transform-origin: 16px 16px; }
        @keyframes lm-spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .lm-ring { animation: none !important; } }
      `}</style>

      <path
        className="lm-ring"
        strokeWidth="2"
        d="M16 5.5 A10.5 10.5 0 0 1 25.7 12"
        style={{ animation: `lm-spin 43s linear infinite`, animationDelay: `${phase[0]}s` }}
      />
      <path
        className="lm-ring"
        strokeWidth="1.5"
        opacity="0.62"
        d="M16 26.5 A10.5 10.5 0 0 1 6.3 20"
        style={{ animation: `lm-spin 61s linear infinite reverse`, animationDelay: `${phase[1]}s` }}
      />
      <path
        className="lm-ring"
        strokeWidth="1.1"
        opacity="0.38"
        d="M23.4 8.6 A10.5 10.5 0 0 1 22 23.9"
        style={{ animation: `lm-spin 79s linear infinite`, animationDelay: `${phase[2]}s` }}
      />
      <circle cx="16" cy="16" r="3" fill="var(--cyan)" />
    </svg>
  );
}
