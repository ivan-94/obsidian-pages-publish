import { useLayoutEffect, useRef } from 'preact/hooks';
import { ToggleComponent } from './obsidian-api';

export interface ObsidianToggleProps {
  disabled?: boolean;
  label: string;
  onChange: (value: boolean) => void | Promise<void>;
  value: boolean;
}

export function ObsidianToggle({ disabled, label, onChange, value }: ObsidianToggleProps) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const componentRef = useRef<ToggleComponent>();
  const syncingRef = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const component = new ToggleComponent(host);
    component.setValue(value);
    component.setDisabled(Boolean(disabled));
    component.toggleEl.setAttribute('aria-label', label);
    component.onChange((next) => {
      if (!syncingRef.current) void onChangeRef.current(next);
    });
    componentRef.current = component;
    return () => {
      componentRef.current = undefined;
      host.replaceChildren();
    };
  }, []);

  useLayoutEffect(() => {
    const component = componentRef.current;
    if (!component) return;
    syncingRef.current = true;
    if (component.getValue() !== value) component.setValue(value);
    component.setDisabled(Boolean(disabled));
    component.toggleEl.setAttribute('aria-label', label);
    syncingRef.current = false;
  }, [disabled, label, value]);

  return <span class="pp-obsidian-component pp-obsidian-toggle" ref={hostRef} />;
}
