/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// FEAT-SHELL-1 — LitRPG player-surface shell.
//
// One Radix-Dialog-backed shell that hosts the four player-facing
// surfaces (Inventory, Quest Dashboard, Notice Journal, Character
// State). Radix gives us focus trap, Escape close, and restore-
// focus to the invoking element out of the box; the shell chrome
// (backdrop, panel, title, close button, body) is styled with the
// existing `.modal-backdrop` / `.modal` / `.modal-body` Greenhaven
// classes.
//
// Focus contract (FEAT-SHELL-1 follow-up):
//   * Open: Radix's default `onOpenAutoFocus` runs unmodified. It
//     focuses the first focusable child — the close button — so
//     keyboard users land inside the dialog and `Tab` stays
//     trapped.
//   * Close: `<Dialog.Close asChild>` triggers `onOpenChange(false)`
//     through the outer `Dialog.Root` handler, which calls
//     `onClose()`. No manual `event.preventDefault()` overrides
//     interfere with Radix's restore-focus path; menu-triggered
//     opens return focus to the menu button automatically.
//   * Hotkey-open fallback: hotkeys (`I` / `Q` / `J` / `P`) fire
//     while focus is on `body`, so Radix records `body` as the
//     trigger and has nowhere useful to restore focus on close.
//     The caller passes a `fallbackFocusRef` (the composer
//     textarea); when set, `onCloseAutoFocus` prevents Radix's
//     null-trigger restore and lands focus on that ref instead.
//     For menu-triggered opens the caller passes `undefined` and
//     Radix's natural restore wins.
//
// The shell does not own any data — surface bodies pass their content
// in as children. No leaf surface component calls `fetch` directly;
// data flows through bridge-backed surface components and through
// `systemEvents` already plumbed down to `GameScreen`.

import {X} from 'lucide-react';
import * as Dialog from '@radix-ui/react-dialog';
import type {ReactNode, RefObject} from 'react';

export type SurfaceKind =
  | 'inventory'
  | 'quests'
  | 'journal'
  | 'character'
  | 'bonds';

interface Props {
  surface: SurfaceKind;
  title: string;
  closeLabel: string;
  onClose: () => void;
  /**
   * Deterministic landing zone for keyboard focus when the shell
   * was opened via a hotkey and Radix has no useful trigger to
   * restore to. Pass `composerRef` from `GameScreen` for hotkey
   * opens, `undefined` for menu-triggered opens.
   */
  fallbackFocusRef?: RefObject<HTMLElement | HTMLTextAreaElement | null>;
  children: ReactNode;
}

export function PlayerSurfaceShell({
  surface,
  title,
  closeLabel,
  onClose,
  fallbackFocusRef,
  children,
}: Props) {
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content
          className={`modal player-surface player-surface-${surface}`}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            // Radix tries to restore focus to whatever element had
            // focus when the dialog opened. For menu-triggered
            // opens that is the menu button — Radix handles it.
            // For hotkey-triggered opens the recorded trigger is
            // `body` (the hotkey skips when typing), so Radix has
            // no usable restore target. When the caller passed a
            // fallback (the composer textarea), redirect focus
            // there so keyboard users always land on a usable
            // control.
            const fallback = fallbackFocusRef?.current;
            if (fallback) {
              event.preventDefault();
              fallback.focus();
            }
          }}
        >
          <header className="player-surface-header">
            <Dialog.Title className="player-surface-title">
              {title}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button
                type="button"
                className="modal-close player-surface-close"
                aria-label={closeLabel}
              >
                <X size={18} />
              </button>
            </Dialog.Close>
          </header>
          <div className="modal-body player-surface-body">{children}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
