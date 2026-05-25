// U-1 — save-slot bridge. SaveSlotsPanel calls these helpers
// instead of `fetch(...)`'ing the REST endpoints directly so the
// bridge owns the `/api/player/:id/saves` surface and the panel
// stays platform-agnostic (web build + future Wails native build
// share the same call sites).

export interface SaveSlotRow {
  id: number;
  slot_name: string;
  is_auto: boolean;
  size_bytes: number;
  created_at: string;
}

interface SavesListResponse {
  slots?: SaveSlotRow[];
}

interface SavesMutationResponse {
  ok?: boolean;
  error?: string;
}

export async function listSaveSlots(args: {
  playerId: number;
  baseUrl?: string;
}): Promise<SaveSlotRow[]> {
  const r = await fetch(
    `${args.baseUrl ?? ''}/api/player/${args.playerId}/saves`,
    {credentials: 'include'},
  );
  const d = (await r.json()) as SavesListResponse;
  return Array.isArray(d.slots) ? d.slots : [];
}

export async function createSaveSlot(args: {
  playerId: number;
  slotName: string;
  baseUrl?: string;
}): Promise<SavesMutationResponse> {
  const r = await fetch(
    `${args.baseUrl ?? ''}/api/player/${args.playerId}/saves`,
    {
      method: 'POST',
      credentials: 'include',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({slot_name: args.slotName}),
    },
  );
  return (await r.json()) as SavesMutationResponse;
}

export async function restoreSaveSlot(args: {
  playerId: number;
  slotId: number;
  baseUrl?: string;
}): Promise<SavesMutationResponse> {
  const r = await fetch(
    `${args.baseUrl ?? ''}/api/player/${args.playerId}/saves/${args.slotId}/restore`,
    {
      method: 'POST',
      credentials: 'include',
    },
  );
  return (await r.json()) as SavesMutationResponse;
}

export async function deleteSaveSlot(args: {
  playerId: number;
  slotId: number;
  baseUrl?: string;
}): Promise<void> {
  await fetch(
    `${args.baseUrl ?? ''}/api/player/${args.playerId}/saves/${args.slotId}`,
    {
      method: 'DELETE',
      credentials: 'include',
    },
  );
}
