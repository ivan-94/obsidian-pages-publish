import { render, type ComponentChild } from 'preact';

export interface MountedPreactView<TInput> {
  update(input: TInput): void;
  unmount(): void;
}

/** Owns one Preact root inside an Obsidian-provided container. */
export function mountPreactView<TInput>(
  container: HTMLElement,
  createView: (input: TInput) => ComponentChild,
  initialInput: TInput,
): MountedPreactView<TInput> {
  container.replaceChildren();
  const root = container.createDiv({ cls: 'pages-publish-ui' });

  let mounted = true;
  let input = initialInput;
  const renderCurrent = (): void => {
    render(createView(input), root);
  };
  renderCurrent();

  return {
    update(nextInput): void {
      if (!mounted) return;
      input = nextInput;
      renderCurrent();
    },
    unmount(): void {
      if (!mounted) return;
      mounted = false;
      render(null, root);
      root.remove();
    },
  };
}
