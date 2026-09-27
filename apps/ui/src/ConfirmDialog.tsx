import {
  useEffect,
  useId,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
} from "react";
import { nextFocusIndex } from "./dialog.js";

export interface ConfirmDialogProps {
  title: string;
  body: string;
  confirmLabel: string;
  /** Paints the confirm button in `--danger` instead of the accent. */
  destructive: boolean;
  /** `data-testid` of the dialog element. */
  testId: string;
  /** `data-testid` of the confirm button; defaults to `${testId}-confirm`. */
  confirmTestId?: string;
  /** `data-testid` of the cancel button; defaults to `${testId}-cancel`. */
  cancelTestId?: string;
  /** Disables the confirm button (e.g. while the confirmed action is in flight). */
  confirmDisabled?: boolean;
  /**
   * An inline error to show below the body, e.g. after the confirmed action
   * rejected. Rendered with `role="alert"` and `data-testid={testId}-error` so
   * it is announced and findable without keeping the dialog's own shape a
   * caller has to duplicate. `null`/`undefined`/omitted renders nothing.
   */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * The in-app confirmation dialog (PRD 10.6 §3): an `alertdialog` over a scrim
 * that fills its containing block, so rendered inside the settings sheet it
 * dims only the sheet and needs no native view of its own.
 *
 * Cancel takes focus on open (the macOS default for destructive dialogs); Tab
 * and Shift+Tab cycle between the two buttons; Escape cancels. Both keys are
 * handled by a capture-phase window listener, so they are consumed before any
 * other window listener (the settings view's Escape-to-close, its section
 * navigation) sees them, whatever element holds focus. On close, focus returns
 * to the element that was focused when the dialog opened.
 */
export function ConfirmDialog(props: ConfirmDialogProps): ReactElement {
  const {
    title,
    body,
    confirmLabel,
    destructive,
    testId,
    confirmTestId = `${testId}-confirm`,
    cancelTestId = `${testId}-cancel`,
    confirmDisabled = false,
    error = null,
    onConfirm,
    onCancel,
  } = props;
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Read by the key listener, which is bound once, so it always calls the
  // latest callback.
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  // The scrim closes only when the press also started on it (see onScrimClick).
  const pressedScrimRef = useRef(false);

  useEffect(() => {
    const previous = document.activeElement;
    cancelRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus();
      }
    };
  }, []);

  // A confirm that disables itself while in flight (e.g. Confirm, mid-click)
  // drops focus to the body once it becomes disabled; on a rejection, pull
  // focus back into the dialog rather than leave it stranded.
  useEffect(() => {
    if (error !== null) {
      cancelRef.current?.focus();
    }
  }, [error]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancelRef.current();
      } else if (event.key === "Tab") {
        event.preventDefault();
        event.stopPropagation();
        const buttons = [cancelRef.current, confirmRef.current].filter(
          (button): button is HTMLButtonElement => button !== null,
        );
        const current = buttons.findIndex((button) => button === document.activeElement);
        buttons[nextFocusIndex(current, buttons.length, event.shiftKey)]?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  const onScrimPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    pressedScrimRef.current = event.target === event.currentTarget;
  };

  // A selection dragged from inside the dialog onto the scrim ends in a click
  // on the scrim; only a press that also began there cancels.
  const onScrimClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const pressed = pressedScrimRef.current;
    pressedScrimRef.current = false;
    if (pressed && event.target === event.currentTarget) {
      onCancel();
    }
  };

  return (
    <div
      className="dialog-scrim"
      onPointerDown={onScrimPointerDown}
      onClick={onScrimClick}
    >
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-testid={testId}
        // Focusable by script only: a click on the dialog's text keeps focus
        // inside the dialog instead of dropping it to the body.
        tabIndex={-1}
      >
        <h2 className="dialog__title" id={titleId}>
          {title}
        </h2>
        <p className="dialog__body" id={bodyId}>
          {body}
        </p>
        {error !== null && (
          <p className="dialog__error" role="alert" data-testid={`${testId}-error`}>
            {error}
          </p>
        )}
        <div className="dialog__actions">
          <button
            ref={cancelRef}
            type="button"
            className="dialog__button"
            data-testid={cancelTestId}
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={`dialog__button ${destructive ? "dialog__button--danger" : "dialog__button--primary"}`}
            data-testid={confirmTestId}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
