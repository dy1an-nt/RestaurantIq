/**
 * RestaurantIQ brand mark — a calm monogram plate.
 *
 * Placeholder until the client supplies a real logo; swap the SVG here when
 * delivered (the rest of the app just renders <Logo />).
 *
 *   on="navy"  → navy plate, white mark (default — use on light surfaces)
 *   on="light" → translucent plate, white mark (use on the navy brand panel)
 */
interface LogoProps {
  size?: number;
  on?: 'navy' | 'light';
}

export function Logo({ size = 30, on = 'navy' }: LogoProps) {
  const onLight = on === 'light';
  const bg = onLight ? 'rgba(255,255,255,0.12)' : '#1e3a5f';
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <rect
        x="0.5"
        y="0.5"
        width="31"
        height="31"
        rx="8"
        fill={bg}
        stroke={onLight ? 'rgba(255,255,255,0.22)' : 'none'}
      />
      <path
        d="M9 22V10h5.2c2.3 0 3.8 1.3 3.8 3.4 0 1.6-.9 2.7-2.4 3.1L19 22h-2.8l-2.1-4.2H11.6V22H9Zm2.6-6.3h2.3c1.1 0 1.8-.6 1.8-1.6s-.7-1.6-1.8-1.6h-2.3v3.2Z"
        fill="#fff"
      />
      <circle cx="21.5" cy="11" r="2" fill="#fff" opacity="0.92" />
    </svg>
  );
}

export default Logo;
