/**
 * @license
 * Copyright 2026 Greenhaven contributors
 * SPDX-License-Identifier: Apache-2.0
 */

// Cartridge media script runtime.
//
// Obsidian notes can declare small media commands such as:
//   play_music("music_port_theme", label="Port", loop=true, volume=0.7)
//   switch_music("music_combat")
//   pause_music()
//   resume_music()
//   stop_music()
//   show_media("media_ledger_closeup", title="Ledger", caption="Wax seal.")
//
// The compiler stores those commands in entities.profile.media_script.
// This service resolves command asset roles against the same
// profile.visual_asset_urls map populated by the cartridge asset
// manifest, then emits a durable side-effect event for the UI music
// controller. It never reads arbitrary paths at runtime.

import {query} from '../db.js';
import {emitGuiEvent, type EmitGuiEventOptions} from '../guiEventOutbox.js';
import {
  ASSET_MANIFEST_META_KEY,
  parseScopedManifestPayload,
  type CartridgeAssetEntry,
} from './CartridgeAssetManifestService.js';
import type {ToolContext} from '../tools/base.js';

export interface MediaCommand {
  action: 'play' | 'switch' | 'pause' | 'resume' | 'stop' | 'show';
  asset_role?: string;
  label?: string;
  title?: string;
  caption?: string;
  alt?: string;
  loop?: boolean;
  volume?: number;
}

export interface EmitEntityMediaScriptOptions {
  /** Replay only music-control commands. Used on session bootstrap so
   *  location/NPC themes resume without re-sending chat media cards. */
  musicOnly?: boolean;
  eventOptions?: EmitGuiEventOptions;
}

interface EntityMediaRow {
  display_name: string;
  profile: Record<string, unknown> | null;
}

export async function emitEntityMediaScript(
  ctx: Pick<ToolContext, 'sessionId' | 'playerId' | 'turnId'>,
  entityId: number,
  sourceKind: 'location' | 'scene' | 'person' | 'item',
  options: EmitEntityMediaScriptOptions = {},
): Promise<void> {
  const row = await query<EntityMediaRow>(
    `SELECT display_name, profile FROM entities WHERE id = $1`,
    [entityId],
  );
  const found = row.rows[0];
  if (!found) return;
  const commands = readMediaScript(found.profile);
  if (commands.length === 0) return;
  const assetUrls = readAssetUrls(found.profile);
  for (const command of commands) {
    const emission = await commandToEmission(command, assetUrls);
    if (!emission) continue;
    if (options.musicOnly && emission.type !== 'media:music') continue;
    await emitGuiEvent(
      ctx,
      emission.type,
      {
        ...emission.payload,
        sourceKind,
        sourceEntityId: entityId,
        sourceName: found.display_name,
      },
      {...emission.options, ...options.eventOptions},
    );
  }
}

function readMediaScript(
  profile: Record<string, unknown> | null,
): MediaCommand[] {
  const raw = profile?.['media_script'];
  if (!Array.isArray(raw)) return [];
  return raw
    .map(parseCommand)
    .filter((command): command is MediaCommand => command != null);
}

function parseCommand(raw: unknown): MediaCommand | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const actionRaw =
    typeof row['action'] === 'string'
      ? row['action'].trim().toLowerCase()
      : '';
  if (
    actionRaw !== 'play' &&
    actionRaw !== 'switch' &&
    actionRaw !== 'pause' &&
    actionRaw !== 'resume' &&
    actionRaw !== 'stop' &&
    actionRaw !== 'show'
  ) {
    return null;
  }
  const command: MediaCommand = {action: actionRaw};
  if (typeof row['asset_role'] === 'string' && row['asset_role'].trim()) {
    command.asset_role = row['asset_role'].trim().toLowerCase();
  }
  if (typeof row['label'] === 'string' && row['label'].trim()) {
    command.label = row['label'].trim();
  }
  if (typeof row['title'] === 'string' && row['title'].trim()) {
    command.title = row['title'].trim();
  }
  if (typeof row['caption'] === 'string' && row['caption'].trim()) {
    command.caption = row['caption'].trim();
  }
  if (typeof row['alt'] === 'string' && row['alt'].trim()) {
    command.alt = row['alt'].trim();
  }
  if (typeof row['loop'] === 'boolean') command.loop = row['loop'];
  if (typeof row['volume'] === 'number' && Number.isFinite(row['volume'])) {
    command.volume = Math.max(0, Math.min(1, row['volume']));
  }
  return command;
}

function readAssetUrls(
  profile: Record<string, unknown> | null,
): Record<string, string> {
  const raw = profile?.['visual_asset_urls'];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' && key.trim() && value.trim()) {
      out[key.trim().toLowerCase()] = value.trim();
    }
  }
  return out;
}

interface MediaEmission {
  type: 'media:music' | 'media:shown';
  payload: Record<string, unknown>;
  options: Parameters<typeof emitGuiEvent>[3];
}

async function commandToEmission(
  command: MediaCommand,
  assetUrls: Record<string, string>,
): Promise<MediaEmission | null> {
  if (command.action === 'play' || command.action === 'switch') {
    const role = command.asset_role?.trim().toLowerCase();
    if (!role) return null;
    const url = assetUrls[role];
    if (!url) return null;
    const media = await resolveMediaDescriptor(url);
    return {
      type: 'media:music',
      payload: {
        action: command.action,
        role,
        url,
        ...(media.format ? {format: media.format} : {}),
        ...(media.contentType ? {contentType: media.contentType} : {}),
        label: command.label ?? role,
        loop: command.loop ?? true,
        volume: command.volume ?? 1,
      },
      options: {
        lane: 'rail',
        phase: 'mutation',
        displayPolicy: {lane: 'rail_only', anchor: 'none'},
      },
    };
  }
  if (command.action === 'show') {
    const role = command.asset_role?.trim().toLowerCase();
    if (!role) return null;
    const url = assetUrls[role];
    if (!url) return null;
    const media = await resolveMediaDescriptor(url);
    return {
      type: 'media:shown',
      payload: {
        action: command.action,
        role,
        url,
        ...(media.format ? {format: media.format} : {}),
        ...(media.contentType ? {contentType: media.contentType} : {}),
        title: command.title ?? command.label ?? role,
        ...(command.caption ? {caption: command.caption} : {}),
        ...(command.alt ? {alt: command.alt} : {}),
      },
      options: {
        lane: 'chat',
        phase: 'mutation',
        displayPolicy: {lane: 'chat', anchor: 'turn_id'},
      },
    };
  }
  return {
    type: 'media:music',
    payload: {
      action: command.action,
      label: command.label ?? null,
    },
    options: {
      lane: 'rail',
      phase: 'mutation',
      displayPolicy: {lane: 'rail_only', anchor: 'none'},
    },
  };
}

interface MediaDescriptor {
  format: string | null;
  contentType: string | null;
}

const FORMAT_BY_EXTENSION: Record<string, string> = {
  '.mp3': 'mp3',
  '.ogg': 'ogg',
  '.m4a': 'm4a',
  '.wav': 'wav',
  '.mp4': 'mp4',
  '.webm': 'webm',
  '.png': 'png',
  '.jpg': 'jpg',
  '.jpeg': 'jpeg',
  '.gif': 'gif',
  '.webp': 'webp',
  '.svg': 'svg',
};

function formatFromEntry(entry: CartridgeAssetEntry): string | null {
  const ext = entry.extension.trim().toLowerCase();
  return FORMAT_BY_EXTENSION[ext] ?? null;
}

interface AssetUrlParts {
  cartridgeId: string;
  kind: string;
  slug: string;
  role: string;
}

function parseCartridgeAssetUrl(url: string): AssetUrlParts | null {
  let pathname = '';
  try {
    pathname = new URL(url, 'http://greenhaven.local').pathname;
  } catch {
    return null;
  }
  const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
  // /api/assets/cartridges/:cartridgeId/world/:kind/:slug/:role
  if (
    parts.length !== 8 ||
    parts[0] !== 'api' ||
    parts[1] !== 'assets' ||
    parts[2] !== 'cartridges' ||
    parts[4] !== 'world'
  ) {
    return null;
  }
  const [cartridgeId, kind, slug, role] = [
    parts[3],
    parts[5],
    parts[6],
    parts[7],
  ];
  if (!cartridgeId || !kind || !slug || !role) return null;
  return {
    cartridgeId,
    kind: kind.trim().toLowerCase(),
    slug: slug.trim().toLowerCase(),
    role: role.trim().toLowerCase(),
  };
}

async function resolveMediaDescriptor(url: string): Promise<MediaDescriptor> {
  const parts = parseCartridgeAssetUrl(url);
  if (!parts) return {format: null, contentType: null};
  try {
    const row = await query<{value: unknown}>(
      `SELECT value FROM cartridge_meta_scoped
        WHERE cartridge_id = $1 AND key = $2`,
      [parts.cartridgeId, ASSET_MANIFEST_META_KEY],
    );
    const manifest = parseScopedManifestPayload(row.rows[0]?.value);
    const entry = manifest?.rows.find(
      (candidate) =>
        candidate.status === 'available' &&
        candidate.kind === parts.kind &&
        candidate.slug === parts.slug &&
        candidate.role === parts.role,
    );
    if (!entry) return {format: null, contentType: null};
    return {
      format: formatFromEntry(entry),
      contentType: entry.content_type || null,
    };
  } catch {
    return {format: null, contentType: null};
  }
}
