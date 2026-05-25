import {ipcMain} from 'electron';
import path from 'node:path';
import {getApiKeyStatus, writeLocalEnvValue} from './desktopConfig.js';

export function installConfigIpc(options: {getConfigDir: () => string}): void {
  ipcMain.handle('greenhaven:config:get-deepseek-key-status', () =>
    getApiKeyStatus(options.getConfigDir(), 'DEEPSEEK_API_KEY'),
  );
  ipcMain.handle(
    'greenhaven:config:save-deepseek-api-key',
    async (_event, value) => {
      const configDir = options.getConfigDir();
      await writeLocalEnvValue(configDir, 'DEEPSEEK_API_KEY', value);
      const status = await getApiKeyStatus(configDir, 'DEEPSEEK_API_KEY');
      console.log(
        `[greenhaven-desktop] DeepSeek API key ${status.source === 'local' ? 'saved locally' : 'cleared locally'}`,
      );
      return status;
    },
  );
}

export function configDirForDataRoot(dataRoot: string): string {
  return path.join(dataRoot, 'config');
}
