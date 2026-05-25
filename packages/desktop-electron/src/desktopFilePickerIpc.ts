import {BrowserWindow, dialog, ipcMain} from 'electron';
import type {OpenDialogOptions} from 'electron';

type SelectDirectoryOptions = {
  title?: unknown;
  defaultPath?: unknown;
};

function stringOption(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function installFilePickerIpc(): void {
  ipcMain.handle(
    'greenhaven:file-picker:select-directory',
    async (event, options: SelectDirectoryOptions = {}) => {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const dialogOptions: OpenDialogOptions = {
        title: stringOption(options.title) ?? 'Select cartridge folder',
        defaultPath: stringOption(options.defaultPath),
        properties: ['openDirectory'],
      };
      const result = owner
        ? await dialog.showOpenDialog(owner, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions);

      return {
        canceled: result.canceled,
        path: result.canceled ? null : result.filePaths[0] ?? null,
      };
    },
  );
}
