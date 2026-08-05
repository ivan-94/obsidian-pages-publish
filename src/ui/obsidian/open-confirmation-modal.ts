import { ButtonComponent, Modal, type App } from './obsidian-api';

export interface ConfirmationFact {
  label: string;
  value: string;
  tone?: 'default' | 'success' | 'warning' | 'danger';
}

export interface ConfirmationModalOptions {
  cancelLabel?: string;
  confirmLabel: string;
  confirmTone?: 'cta' | 'destructive';
  description: string;
  eyebrow?: string;
  facts?: readonly ConfirmationFact[];
  title: string;
}

/** Opens a native Obsidian Modal and resolves once for every close path. */
export function openConfirmationModal(
  app: App,
  options: ConfirmationModalOptions,
): Promise<boolean> {
  return new Promise((resolve) => {
    class ConfirmationModal extends Modal {
      private settled = false;

      onOpen(): void {
        this.modalEl.addClass('pp-confirmation-modal');
        const content = this.contentEl;
        content.empty();
        if (options.eyebrow) {
          content.createDiv({ cls: 'pp-confirmation-modal__eyebrow', text: options.eyebrow });
        }
        content.createEl('h2', { text: options.title });
        content.createEl('p', {
          cls: 'pp-confirmation-modal__description',
          text: options.description,
        });

        if (options.facts?.length) {
          const facts = content.createEl('dl', { cls: 'pp-confirmation-modal__facts' });
          for (const fact of options.facts) {
            const row = facts.createDiv({ cls: 'pp-confirmation-modal__fact' });
            row.setAttr('data-tone', fact.tone ?? 'default');
            row.createEl('dt', { text: fact.label });
            row.createEl('dd', { text: fact.value });
          }
        }

        const actions = content.createDiv({ cls: 'pp-confirmation-modal__actions' });
        new ButtonComponent(actions)
          .setButtonText(options.cancelLabel ?? '取消')
          .onClick(() => this.finish(false));
        const confirm = new ButtonComponent(actions)
          .setButtonText(options.confirmLabel)
          .onClick(() => this.finish(true));
        if (options.confirmTone === 'cta') confirm.setCta();
        if (options.confirmTone === 'destructive') confirm.setDestructive();
      }

      onClose(): void {
        this.finish(false, false);
        this.contentEl.empty();
      }

      private finish(confirmed: boolean, close = true): void {
        if (this.settled) return;
        this.settled = true;
        resolve(confirmed);
        if (close) this.close();
      }
    }

    new ConfirmationModal(app).open();
  });
}
