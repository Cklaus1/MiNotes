import { iconParts, type IconName } from "../lib/icons";

/**
 * A UI icon from the app's set (lib/icons.ts). Decorative by default (the
 * button or label next to it names the action); pass `label` for an icon that
 * stands alone.
 */
export default function Icon({ name, size = 16, label, className }: {
  name: IconName; size?: number; label?: string; className?: string;
}) {
  return (
    <svg
      className={`ui-icon${className ? ` ${className}` : ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
      data-icon={name}
      // Trusted, static markup from lib/icons.ts (no user data).
      dangerouslySetInnerHTML={{ __html: iconParts(name) }}
    />
  );
}
