import { useEffect, useId, useRef } from 'react';
import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import './modal.css';

export interface ModalProps {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}

/** Keep this in the reader DOM so dialogs also work in element fullscreen. */
export function Modal({ title, children, onClose, wide = false }: ModalProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const element = dialog.current;
    const previousFocus = document.activeElement;
    if (element && !element.open) element.showModal();
    return () => {
      element?.close();
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className={`yue-modal${wide ? ' yue-modal-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
      }}
    >
      <header className="yue-modal-header">
        <h2 id={titleId}>{title}</h2>
        <button type="button" className="yue-modal-close" onClick={onClose} aria-label="关闭弹窗" title="关闭"><X size={20} /></button>
      </header>
      <div className="yue-modal-body">{children}</div>
    </dialog>
  );
}
