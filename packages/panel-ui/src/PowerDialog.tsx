import { useEffect, useRef } from 'react';
import type { Translate } from './i18n';

/**
 * "Power off system?" Confirm turns the room off. Cancel, Escape, or a touch outside the dialog
 * all go back without doing anything. Cancel has focus first so a stray Enter is harmless.
 */
export function PowerDialog({
  t,
  onConfirm,
  onCancel,
}: {
  t: Translate;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => cancel.current?.focus(), []);

  return (
    <div
      className="kp-dialog-backdrop"
      onClick={onCancel}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
    >
      <div
        className="kp-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="kp-power-title"
        aria-describedby="kp-power-body"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="kp-power-title">{t('power.title')}</h2>
        <p id="kp-power-body">{t('power.body')}</p>
        <div className="kp-dialog-actions">
          <button ref={cancel} type="button" className="kp-btn" onClick={onCancel}>
            {t('power.cancel')}
          </button>
          <button type="button" className="kp-btn kp-btn-danger" onClick={onConfirm}>
            {t('power.confirm')}
          </button>
        </div>
      </div>
    </div>
  );
}
