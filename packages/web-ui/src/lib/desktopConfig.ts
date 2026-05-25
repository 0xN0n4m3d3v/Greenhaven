export type DeepSeekKeySource =
  | 'local'
  | 'environment'
  | 'none'
  | 'unavailable';

export interface DeepSeekKeyStatus {
  saved: boolean;
  source: DeepSeekKeySource;
}

export interface DesktopDirectorySelection {
  available: boolean;
  canceled: boolean;
  path: string | null;
  error?: string;
}

interface GreenhavenDesktopConfigApi {
  getDeepSeekKeyStatus(): Promise<unknown>;
  saveDeepSeekApiKey(apiKey: string): Promise<unknown>;
}

interface GreenhavenDesktopFilePickerApi {
  selectDirectory(options?: {
    title?: string;
    defaultPath?: string;
  }): Promise<unknown>;
}

interface GreenhavenDesktopApi {
  config?: GreenhavenDesktopConfigApi;
  filePicker?: GreenhavenDesktopFilePickerApi;
}

declare global {
  interface Window {
    greenhavenDesktop?: GreenhavenDesktopApi;
  }
}

const UNAVAILABLE_STATUS: DeepSeekKeyStatus = {
  saved: false,
  source: 'unavailable',
};

const UNAVAILABLE_DIRECTORY_SELECTION: DesktopDirectorySelection = {
  available: false,
  canceled: true,
  path: null,
};

function normalizeDeepSeekKeyStatus(value: unknown): DeepSeekKeyStatus {
  if (!value || typeof value !== 'object') return UNAVAILABLE_STATUS;
  const raw = value as {saved?: unknown; source?: unknown};
  if (
    raw.source === 'local' ||
    raw.source === 'environment' ||
    raw.source === 'none'
  ) {
    return {saved: raw.saved === true, source: raw.source};
  }
  return UNAVAILABLE_STATUS;
}

function normalizeDirectorySelection(
  value: unknown,
): DesktopDirectorySelection {
  if (!value || typeof value !== 'object') {
    return {
      available: true,
      canceled: true,
      path: null,
      error: 'invalid_selection_response',
    };
  }
  const raw = value as {canceled?: unknown; path?: unknown};
  const path = typeof raw.path === 'string' && raw.path.trim()
    ? raw.path
    : null;
  return {
    available: true,
    canceled: raw.canceled === true || path === null,
    path,
  };
}

export function hasDesktopDirectoryPicker(): boolean {
  return typeof window.greenhavenDesktop?.filePicker?.selectDirectory === 'function';
}

export async function selectDesktopDirectory(options?: {
  title?: string;
  defaultPath?: string;
}): Promise<DesktopDirectorySelection> {
  const api = window.greenhavenDesktop?.filePicker;
  if (!api) return UNAVAILABLE_DIRECTORY_SELECTION;
  try {
    return normalizeDirectorySelection(await api.selectDirectory(options));
  } catch (err) {
    return {
      available: true,
      canceled: true,
      path: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function getDeepSeekKeyStatus(): Promise<DeepSeekKeyStatus> {
  const api = window.greenhavenDesktop?.config;
  if (!api) return UNAVAILABLE_STATUS;
  try {
    return normalizeDeepSeekKeyStatus(await api.getDeepSeekKeyStatus());
  } catch {
    return UNAVAILABLE_STATUS;
  }
}

export async function saveDeepSeekApiKey(
  apiKey: string,
): Promise<DeepSeekKeyStatus> {
  const api = window.greenhavenDesktop?.config;
  if (!api) return UNAVAILABLE_STATUS;
  try {
    return normalizeDeepSeekKeyStatus(await api.saveDeepSeekApiKey(apiKey));
  } catch {
    return UNAVAILABLE_STATUS;
  }
}
