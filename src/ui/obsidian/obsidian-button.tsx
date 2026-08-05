import { useLayoutEffect, useRef } from 'preact/hooks';
import { ButtonComponent } from './obsidian-api';

export type ObsidianButtonTone = 'default' | 'cta' | 'destructive';

export interface ObsidianButtonProps {
  ariaLabel?: string;
  ariaPressed?: boolean;
  busy?: boolean;
  busyLabel?: string;
  className?: string;
  disabled?: boolean;
  icon?: string;
  label: string;
  onClick: () => void | Promise<void>;
  tone?: ObsidianButtonTone;
  tooltip?: string;
}

export function ObsidianButton(props: ObsidianButtonProps) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const componentRef = useRef<ButtonComponent>();
  const onClickRef = useRef(props.onClick);
  onClickRef.current = props.onClick;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const component = new ButtonComponent(host).onClick(() => onClickRef.current());
    componentRef.current = component;
    return () => {
      componentRef.current = undefined;
      host.replaceChildren();
    };
  }, []);

  useLayoutEffect(() => {
    const component = componentRef.current;
    if (!component) return;
    const label = props.busy ? (props.busyLabel ?? props.label) : props.label;
    component.buttonEl.replaceChildren();
    component.setButtonText(label);
    if (props.icon) {
      component.setIcon(props.icon);
      if (label) component.buttonEl.append(document.createTextNode(label));
    }
    component.setDisabled(Boolean(props.disabled || props.busy));
    if (props.tooltip || props.ariaLabel) {
      component.setTooltip(props.tooltip ?? props.ariaLabel ?? props.label);
    } else {
      component.buttonEl.removeAttribute('title');
    }

    const button = component.buttonEl;
    button.classList.remove('mod-cta', 'mod-warning');
    if (props.tone === 'cta') component.setCta();
    if (props.tone === 'destructive') component.setDestructive();
    button.classList.toggle('is-busy', Boolean(props.busy));
    button.toggleAttribute('aria-busy', Boolean(props.busy));
    button.setAttribute('aria-label', props.ariaLabel ?? props.label);
    if (props.ariaPressed === undefined) button.removeAttribute('aria-pressed');
    else button.setAttribute('aria-pressed', String(props.ariaPressed));
    const classes = props.className?.split(/\s+/).filter(Boolean) ?? [];
    if (classes.length > 0) button.classList.add(...classes);
    return () => {
      if (classes.length > 0) button.classList.remove(...classes);
    };
  }, [
    props.ariaLabel,
    props.ariaPressed,
    props.busy,
    props.busyLabel,
    props.className,
    props.disabled,
    props.icon,
    props.label,
    props.tone,
    props.tooltip,
  ]);

  return <span class="pp-obsidian-component" ref={hostRef} />;
}
