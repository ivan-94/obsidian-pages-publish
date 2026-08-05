import { useEffect, useRef } from 'preact/hooks';
import { setIcon } from './obsidian-api';

export interface ObsidianIconProps {
  className?: string;
  icon: string;
  label?: string;
}

export function ObsidianIcon({ className, icon, label }: ObsidianIconProps) {
  const elementRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    element.replaceChildren();
    setIcon(element, icon);
    return () => element.replaceChildren();
  }, [icon]);

  return (
    <span
      aria-hidden={label ? undefined : 'true'}
      aria-label={label}
      class={['pp-icon', className].filter(Boolean).join(' ')}
      ref={elementRef}
      role={label ? 'img' : undefined}
    />
  );
}
