import { cx } from "../constants";

// Shared GROVE brand mark. SVG scales crisply; PNG is the browser fallback.
export function GroveMark(props: { size?: number; className?: string }) {
  const { size = 22, className } = props;
  return (
    <picture
      className={cx("dr-mark", className)}
      aria-hidden="true"
      style={{ width: size, height: size }}
    >
      <source srcSet="../assets/grove-icon.svg" type="image/svg+xml" />
      <img
        className="dr-mark__img"
        src="../assets/grove-icon.png"
        width={size}
        height={size}
        alt=""
        draggable={false}
      />
    </picture>
  );
}
