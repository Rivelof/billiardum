import { useEffect, useRef } from 'preact/hooks';
import { Icon } from './Icon.jsx';

/**
 * Модальное окно на <dialog>: фокус внутри, Esc закрывает, фон затемнён. На телефоне — лист снизу.
 * Возвращает фокус на кнопку, которая открыла окно.
 */
export function Dialog({ open, title, onClose, children, labelledBy = 'dialog-title' }) {
  const ref = useRef(null);
  const opener = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      opener.current = document.activeElement;
      el.showModal();
    } else if (!open && el.open) {
      el.close();
      opener.current?.focus?.();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      class="dialog"
      aria-labelledby={labelledBy}
      onCancel={(e) => {
        e.preventDefault();
        onClose?.();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose?.();
      }}
    >
      {open ? (
        <div class="dialog__inner">
          <div class="dialog__head">
            <h2 class="dialog__title" id={labelledBy}>
              {title}
            </h2>
            <button type="button" class="icon-btn" onClick={onClose} aria-label="Закрыть">
              <Icon name="close" />
            </button>
          </div>
          {children}
        </div>
      ) : null}
    </dialog>
  );
}
