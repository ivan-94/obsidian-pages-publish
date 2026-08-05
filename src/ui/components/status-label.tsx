import type { ComponentChildren } from 'preact';
import { ObsidianIcon } from '../obsidian/obsidian-icon';

export type UiTone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger';

export interface StatusLabelProps {
  children: ComponentChildren;
  className?: string;
  icon?: string;
  tone?: UiTone;
}

export function StatusLabel({
  children,
  className,
  icon,
  tone = 'neutral',
}: StatusLabelProps) {
  const classes = ['pp-status-label', `is-${tone}`, className].filter(Boolean).join(' ');
  return (
    <span class={classes}>
      {icon ? <ObsidianIcon icon={icon} /> : null}
      <span>{children}</span>
    </span>
  );
}
