import { useEffect, useRef, useState } from 'react';
import type { PanelClient, PanelDivider, PanelLinking } from '@kestrel/model';
import { Icon } from './icons';
import type { Translate } from './i18n';

const together = (rooms: string[]) => rooms.join(' + ');

/** The rooms an option is about: what it would add while separate, what it joins while linked. */
const targets = (d: PanelDivider) => (d.open || d.adds.length === 0 ? d.rooms : d.adds);

/**
 * "Link rooms": combine this room's AV system with a neighbouring room's, or separate them again.
 * Each choice is one option per movable wall, worded for the people in the room ("Combine with
 * Room B"), not for the building. Linking changes what several rooms do, so it asks first. A choice
 * that cannot be made yet (its combined room is not set up here) says so instead of doing nothing.
 */
export function LinkingSheet({
  linking,
  t,
  dispatch,
  onClose,
}: {
  linking: PanelLinking;
  t: Translate;
  dispatch: PanelClient['dispatch'];
  onClose: () => void;
}) {
  const [asking, setAsking] = useState<PanelDivider | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (asking) cancel.current?.focus();
  }, [asking]);
  // A choice that changed (or vanished) while the question was up makes the question stale.
  const current = asking ? linking.dividers.find((d) => d.id === asking.id) : undefined;
  const question = asking && current && current.open === asking.open ? current : null;

  return (
    <div
      className="kp-sheet-backdrop"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        if (question) setAsking(null);
        else onClose();
      }}
    >
      <div
        className="kp-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={t('linking.title')}
        onClick={(e) => e.stopPropagation()}
      >
        <h2>{t('linking.title')}</h2>
        <p className="kp-muted">
          {linking.space.length > 1
            ? t('linking.space', { rooms: together(linking.space) })
            : t('linking.alone')}
        </p>

        {linking.dividers.length === 0 && <p className="kp-muted">{t('linking.none')}</p>}
        <ul className="kp-walls">
          {linking.dividers.map((d) => (
            <li key={d.id} className="kp-wall" data-open={d.open || undefined}>
              <div className="kp-wall-text">
                <strong>
                  {d.open
                    ? t('linking.linked', { rooms: together(targets(d)) })
                    : d.adds.length > 0
                      ? t('linking.option.combine', { rooms: together(targets(d)) })
                      : t('linking.option.link', { rooms: together(targets(d)) })}
                </strong>
                {!d.open && !d.available && (
                  <span className="kp-wall-hint">{t('linking.unavailable')}</span>
                )}
              </div>
              <span className="kp-wall-state">
                <Icon name={d.open ? 'check' : 'link'} />
              </span>
              <button
                type="button"
                className={`kp-btn ${d.open ? '' : 'kp-btn-primary'}`}
                disabled={!d.open && !d.available}
                onClick={() => setAsking(d)}
              >
                {d.open ? t('linking.separate') : t('linking.combine')}
              </button>
            </li>
          ))}
        </ul>

        <button type="button" className="kp-btn" onClick={onClose}>
          {t('sheet.close')}
        </button>
      </div>

      {question && (
        <div
          className="kp-dialog-backdrop"
          onClick={(e) => {
            e.stopPropagation();
            setAsking(null);
          }}
        >
          <div
            className="kp-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="kp-link-title"
            aria-describedby="kp-link-body"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="kp-link-title">
              {question.open
                ? t('linking.confirm.separate', { rooms: together(targets(question)) })
                : t('linking.confirm.combine', { rooms: together(targets(question)) })}
            </h2>
            <p id="kp-link-body">
              {question.open
                ? t('linking.confirm.separate.body')
                : t('linking.confirm.combine.body')}
            </p>
            <div className="kp-dialog-actions">
              <button ref={cancel} type="button" className="kp-btn" onClick={() => setAsking(null)}>
                {t('power.cancel')}
              </button>
              <button
                type="button"
                className="kp-btn kp-btn-primary"
                onClick={() => {
                  dispatch({ type: 'divider.set', dividerId: question.id, open: !question.open });
                  setAsking(null);
                }}
              >
                {question.open ? t('linking.separate') : t('linking.combine')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
