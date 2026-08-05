import type { ComponentChildren } from 'preact';
import { ObsidianIcon } from '../obsidian/obsidian-icon';

export interface EmptyStateProps {
  action?: ComponentChildren;
  description: ComponentChildren;
  icon?: string;
  title: string;
}

export function EmptyState({ action, description, icon, title }: EmptyStateProps) {
  return (
    <section class="pp-empty-state">
      {icon ? <ObsidianIcon className="pp-empty-state__icon" icon={icon} /> : null}
      <h2>{title}</h2>
      <div class="pp-empty-state__description">{description}</div>
      {action ? <div class="pp-empty-state__action">{action}</div> : null}
    </section>
  );
}
