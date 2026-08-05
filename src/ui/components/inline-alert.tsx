import type { ComponentChildren } from 'preact';
import type { UiTone } from './status-label';
import { ObsidianIcon } from '../obsidian/obsidian-icon';

export interface InlineAlertProps {
  action?: ComponentChildren;
  children: ComponentChildren;
  icon?: string;
  title: string;
  tone?: UiTone;
}

export function InlineAlert({
  action,
  children,
  icon,
  title,
  tone = 'neutral',
}: InlineAlertProps) {
  return (
    <section class={`pp-inline-alert is-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {icon ? <ObsidianIcon className="pp-inline-alert__icon" icon={icon} /> : null}
      <div class="pp-inline-alert__copy">
        <strong>{title}</strong>
        <div class="pp-inline-alert__detail">{children}</div>
      </div>
      {action ? <div class="pp-inline-alert__action">{action}</div> : null}
    </section>
  );
}
