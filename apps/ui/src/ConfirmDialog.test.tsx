import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ConfirmDialog } from "./ConfirmDialog.js";

const BASE = {
  title: "Clear browsing history?",
  body: "This removes all browsing history. It cannot be undone.",
  confirmLabel: "Clear History",
  destructive: true,
  testId: "settings-history-clear-dialog",
  confirmTestId: "settings-history-clear-confirm",
  cancelTestId: "settings-history-clear-cancel",
  onConfirm: () => {},
  onCancel: () => {},
} as const;

describe("ConfirmDialog", () => {
  test("confirmDisabled defaults to false: the confirm button is enabled and has no disabled attribute", () => {
    const html = renderToStaticMarkup(<ConfirmDialog {...BASE} />);
    const confirm = /<button[^>]*data-testid="settings-history-clear-confirm"[^>]*>/.exec(html)?.[0];
    expect(confirm).toBeDefined();
    expect(confirm).not.toContain("disabled");
  });

  test("confirmDisabled disables the confirm button", () => {
    const html = renderToStaticMarkup(<ConfirmDialog {...BASE} confirmDisabled />);
    const confirm = /<button[^>]*data-testid="settings-history-clear-confirm"[^>]*>/.exec(html)?.[0];
    expect(confirm).toContain('disabled=""');
  });

  test("no error prop renders no alert", () => {
    const html = renderToStaticMarkup(<ConfirmDialog {...BASE} />);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("settings-history-clear-dialog-error");
  });

  test("error renders an alert with a testid derived from testId", () => {
    const html = renderToStaticMarkup(
      <ConfirmDialog {...BASE} error="Couldn't clear history. Try again." />,
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('data-testid="settings-history-clear-dialog-error"');
    expect(html).toContain("Try again.");
  });

  test("error=null renders no alert", () => {
    const html = renderToStaticMarkup(<ConfirmDialog {...BASE} error={null} />);
    expect(html).not.toContain('role="alert"');
  });
});
