import { cx } from "../constants";

// Shared GROVE brand mark — a small "grove/tree" glyph: a branching trunk with
// leaf nodes, rooted on a base line. Defined once and reused across the header
// brand, the org/tree view, and the onboarding wizard so the logo stays
// consistent everywhere. Inherits colour from `currentColor`; the `dr-mark`
// class supplies the amber tint + glow (callers may add a class for sizing).
export function GroveMark(props: { size?: number; className?: string }) {
  const { size = 22, className } = props;
  return (
    <svg
      className={cx("dr-mark", className)}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
    >
      <path
        d="M12 22V13M12 13L7 9M12 13l5-4M12 9V3"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.6}
        strokeLinecap="round"
      />
      <circle cx={12} cy={3} r={1.7} fill="currentColor" />
      <circle cx={7} cy={9} r={1.5} fill="currentColor" />
      <circle cx={17} cy={9} r={1.5} fill="currentColor" />
      <path d="M8 19h8" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
    </svg>
  );
}
