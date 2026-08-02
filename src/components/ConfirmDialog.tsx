import { Show, createEffect, createUniqueId, type JSX } from 'solid-js';
import { Dialog } from './Dialog';
import { theme } from '../lib/theme';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string | JSX.Element;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmLoading?: boolean;
  danger?: boolean;
  confirmDisabled?: boolean;
  cancelDisabled?: boolean;
  autoFocusCancel?: boolean;
  width?: string;
  zIndex?: number;
  error?: string | JSX.Element;
  /** When set, takes precedence over the auto-generated title id. */
  labelledBy?: string;
  describedBy?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog(props: ConfirmDialogProps) {
  let cancelRef: HTMLButtonElement | undefined;
  const generatedTitleId = createUniqueId();
  const useGeneratedId = () => props.labelledBy === undefined;
  const actionsDisabled = () => Boolean(props.confirmLoading || props.cancelDisabled);
  const confirmDisabled = () => Boolean(props.confirmDisabled || actionsDisabled());

  function cancel(): void {
    if (actionsDisabled()) return;
    props.onCancel();
  }

  function confirm(): void {
    if (confirmDisabled()) return;
    props.onConfirm();
  }

  // Auto-focus the cancel button (or let Dialog's panel get focus)
  createEffect(() => {
    if (!props.open) return;
    const focusCancelBtn = props.autoFocusCancel ?? true;

    // Blur whatever is focused outside the dialog (e.g. the button that
    // triggered this dialog) so our programmatic focus call sticks.
    (document.activeElement as HTMLElement)?.blur?.();

    // Focus the cancel button after the Dialog panel renders.
    requestAnimationFrame(() => {
      if (focusCancelBtn) cancelRef?.focus();
    });
  });

  return (
    <Dialog
      open={props.open}
      onClose={cancel}
      width={props.width}
      zIndex={props.zIndex}
      labelledBy={props.labelledBy ?? generatedTitleId}
      describedBy={props.describedBy}
    >
      <h2
        id={useGeneratedId() ? generatedTitleId : undefined}
        style={{
          margin: '0',
          'font-size': '17px',
          color: theme.fg,
          'font-weight': '600',
        }}
      >
        {props.title}
      </h2>

      <div style={{ 'font-size': '14px', color: theme.fgMuted, 'line-height': '1.5' }}>
        {props.message}
      </div>

      <Show when={props.error}>
        {(error) => (
          <div
            role="alert"
            style={{ color: theme.error, 'font-size': '12px', 'line-height': '1.4' }}
          >
            {error()}
          </div>
        )}
      </Show>

      <div
        style={{
          display: 'flex',
          gap: '8px',
          'justify-content': 'flex-end',
          'padding-top': '4px',
        }}
      >
        <button
          ref={cancelRef}
          type="button"
          class="btn-secondary"
          disabled={actionsDisabled()}
          onClick={cancel}
          style={{
            padding: '9px 18px',
            background: theme.bgInput,
            border: `1px solid ${theme.border}`,
            'border-radius': '8px',
            color: theme.fgMuted,
            cursor: actionsDisabled() ? 'not-allowed' : 'pointer',
            'font-size': '14px',
            opacity: actionsDisabled() ? '0.5' : '1',
          }}
        >
          {props.cancelLabel ?? 'Cancel'}
        </button>
        <button
          type="button"
          class={props.danger ? 'btn-danger' : 'btn-primary'}
          disabled={props.confirmDisabled || actionsDisabled()}
          onClick={confirm}
          style={{
            padding: '9px 20px',
            background: props.danger ? theme.error : theme.accent,
            border: 'none',
            'border-radius': '8px',
            color: props.danger ? '#fff' : theme.accentText,
            cursor: confirmDisabled() ? 'not-allowed' : 'pointer',
            'font-size': '14px',
            'font-weight': '600',
            opacity: confirmDisabled() ? '0.5' : '1',
            display: 'inline-flex',
            'align-items': 'center',
            gap: '8px',
          }}
        >
          <Show when={props.confirmLoading}>
            <span class="inline-spinner" aria-hidden="true" />
          </Show>
          {props.confirmLabel ?? 'Confirm'}
        </button>
      </div>
    </Dialog>
  );
}
