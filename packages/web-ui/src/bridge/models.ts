// U-2 / UI-8 — local web copy of the desktop-shaped model namespaces.
//
// Mirrors the desktop binding's generated model file shape-for-shape so
// the web build owns its model layer outright. `bridge/platform.ts` is
// the only module that imports from here directly; all other consumers
// must go through the platform facade.
//
// Behavior is identical to the generated file: plain class instances with
// `createFrom(source)` factories. A future desktop target can rebind
// `bridge/platform.ts` to the real desktop models without touching any
// consumer file.

/* eslint-disable @typescript-eslint/no-explicit-any */

export namespace engine {

	export class DiceCheck {
	    dc: number;
	    description: string;

	    static createFrom(source: any = {}) {
	        return new DiceCheck(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.dc = source["dc"];
	        this.description = source["description"];
	    }
	}
	export class Action {
	    id: string;
	    label: string;
	    message: string;
	    primary: boolean;
	    dice_check?: DiceCheck;

	    static createFrom(source: any = {}) {
	        return new Action(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.label = source["label"];
	        this.message = source["message"];
	        this.primary = source["primary"];
	        this.dice_check = this.convertValues(source["dice_check"], DiceCheck);
	    }

		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}
	export class ChatMessage {
	    id: number;
	    authorId: number;
	    author: string;
	    tone: string;
	    text: string;
	    turn: number;

	    static createFrom(source: any = {}) {
	        return new ChatMessage(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.authorId = source["authorId"];
	        this.author = source["author"];
	        this.tone = source["tone"];
	        this.text = source["text"];
	        this.turn = source["turn"];
	    }
	}

	export class DiceRollResult {
	    action_id: string;
	    description: string;
	    roll: number;
	    dc: number;
	    outcome: string;

	    static createFrom(source: any = {}) {
	        return new DiceRollResult(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.action_id = source["action_id"];
	        this.description = source["description"];
	        this.roll = source["roll"];
	        this.dc = source["dc"];
	        this.outcome = source["outcome"];
	    }
	}
	export class EntityCard {
	    id: number;
	    type: string;
	    name: string;
	    summary: string;
	    status: string[];
	    state: string[];
	    tags: string[];

	    static createFrom(source: any = {}) {
	        return new EntityCard(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.type = source["type"];
	        this.name = source["name"];
	        this.summary = source["summary"];
	        this.status = source["status"];
	        this.state = source["state"];
	        this.tags = source["tags"];
	    }
	}
	export class ProviderStatus {
	    mode: string;
	    model: string;
	    online: boolean;
	    lastError?: string;

	    static createFrom(source: any = {}) {
	        return new ProviderStatus(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.mode = source["mode"];
	        this.model = source["model"];
	        this.online = source["online"];
	        this.lastError = source["lastError"];
	    }
	}
	export class RuntimeSlot {
	    fieldId: number;
	    name: string;
	    value: any;

	    static createFrom(source: any = {}) {
	        return new RuntimeSlot(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.fieldId = source["fieldId"];
	        this.name = source["name"];
	        this.value = source["value"];
	    }
	}
	export class MemorySummary {
	    id: number;
	    text: string;
	    tags: string[];
	    importance: number;

	    static createFrom(source: any = {}) {
	        return new MemorySummary(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.text = source["text"];
	        this.tags = source["tags"];
	        this.importance = source["importance"];
	    }
	}
	export class QuestCard {
	    id: number;
	    name: string;
	    status: string;
	    phase: number;
	    summary: string;

	    static createFrom(source: any = {}) {
	        return new QuestCard(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.status = source["status"];
	        this.phase = source["phase"];
	        this.summary = source["summary"];
	    }
	}
	export class InventoryItemCard {
	    entityId: number;
	    name: string;
	    type: string;
	    count: number;
	    holderNote: string;
	    summary: string;

	    static createFrom(source: any = {}) {
	        return new InventoryItemCard(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.entityId = source["entityId"];
	        this.name = source["name"];
	        this.type = source["type"];
	        this.count = source["count"];
	        this.holderNote = source["holderNote"];
	        this.summary = source["summary"];
	    }
	}
	export class HeroSummary {
	    id: number;
	    name: string;
	    statuses: string[];
	    states: string[];

	    static createFrom(source: any = {}) {
	        return new HeroSummary(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.statuses = source["statuses"];
	        this.states = source["states"];
	    }
	}
	export class NPCSummary {
	    id: number;
	    name: string;
	    status: string;
	    // FEAT-PRESENCE-2 — preserve enriched fields from the server
	    // `LocationsViewNearby` DTO so the bridge bootstrap path does
	    // not strip them when it rehydrates `state.nearby` through
	    // `engine.GameState.createFrom()`. The rail / city-map / NPC
	    // profile surfaces read these directly via the `ChatListNearby`
	    // shape; the server is the only writer.
	    summary?: string | null;
	    portrait_set?: Record<string, string | null> | null;
	    relationship?: {band: string | null; count: number | null} | null;
	    statuses?: Array<{kind: string; value: string; intensity: number}>;

	    static createFrom(source: any = {}) {
	        return new NPCSummary(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.status = source["status"];
	        this.summary = source["summary"] ?? null;
	        this.portrait_set = source["portrait_set"] ?? null;
	        this.relationship = source["relationship"] ?? null;
	        this.statuses = Array.isArray(source["statuses"])
	            ? source["statuses"]
	            : [];
	    }
	}
	export class LocationSummary {
	    id: number;
	    name: string;
	    status: string;
	    unread: number;
	    visual_asset_urls: Record<string, string> | null;

	    static createFrom(source: any = {}) {
	        return new LocationSummary(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.name = source["name"];
	        this.status = source["status"];
	        this.unread = source["unread"];
	        this.visual_asset_urls = source["visual_asset_urls"] ?? null;
	    }
	}
	export class GameState {
	    dbPath: string;
	    currentLocation: LocationSummary;
	    currentScene: EntityCard;
	    focusEntity: EntityCard;
	    locations: LocationSummary[];
	    nearby: NPCSummary[];
	    hero: HeroSummary;
	    inventory: InventoryItemCard[];
	    worldEntities: EntityCard[];
	    quests: QuestCard[];
	    memories: MemorySummary[];
	    messages: ChatMessage[];
	    actions: Action[];
	    runtimeSlots: RuntimeSlot[];
	    provider: ProviderStatus;
	    diceRolls: Record<number, DiceRollResult>;

	    static createFrom(source: any = {}) {
	        return new GameState(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.dbPath = source["dbPath"];
	        this.currentLocation = this.convertValues(source["currentLocation"], LocationSummary);
	        this.currentScene = this.convertValues(source["currentScene"], EntityCard);
	        this.focusEntity = this.convertValues(source["focusEntity"], EntityCard);
	        this.locations = this.convertValues(source["locations"], LocationSummary);
	        this.nearby = this.convertValues(source["nearby"], NPCSummary);
	        this.hero = this.convertValues(source["hero"], HeroSummary);
	        this.inventory = this.convertValues(source["inventory"], InventoryItemCard);
	        this.worldEntities = this.convertValues(source["worldEntities"], EntityCard);
	        this.quests = this.convertValues(source["quests"], QuestCard);
	        this.memories = this.convertValues(source["memories"], MemorySummary);
	        this.messages = this.convertValues(source["messages"], ChatMessage);
	        this.actions = this.convertValues(source["actions"], Action);
	        this.runtimeSlots = this.convertValues(source["runtimeSlots"], RuntimeSlot);
	        this.provider = this.convertValues(source["provider"], ProviderStatus);
	        this.diceRolls = this.convertValues(source["diceRolls"], DiceRollResult, true);
	    }

		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}


	export class InventoryPatch {
	    holder_entity_id: number;
	    item_entity_id: number;
	    old_count: number;
	    new_count: number;
	    holder_note?: string;
	    reason?: string;

	    static createFrom(source: any = {}) {
	        return new InventoryPatch(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.holder_entity_id = source["holder_entity_id"];
	        this.item_entity_id = source["item_entity_id"];
	        this.old_count = source["old_count"];
	        this.new_count = source["new_count"];
	        this.holder_note = source["holder_note"];
	        this.reason = source["reason"];
	    }
	}

	export class MemorySignal {
	    remember: boolean;
	    importance: number;
	    reason: string;
	    summary: string;
	    tags: string[];

	    static createFrom(source: any = {}) {
	        return new MemorySignal(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.remember = source["remember"];
	        this.importance = source["importance"];
	        this.reason = source["reason"];
	        this.summary = source["summary"];
	        this.tags = source["tags"];
	    }
	}


	export class PatchReport {
	    inventory: string[];
	    fields: string[];
	    transitions: string[];
	    memory: string[];
	    skipped: string[];

	    static createFrom(source: any = {}) {
	        return new PatchReport(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.inventory = source["inventory"];
	        this.fields = source["fields"];
	        this.transitions = source["transitions"];
	        this.memory = source["memory"];
	        this.skipped = source["skipped"];
	    }
	}


	export class RuntimeFieldPatch {
	    field_id: number;
	    value: any;
	    source?: string;
	    reason?: string;

	    static createFrom(source: any = {}) {
	        return new RuntimeFieldPatch(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.field_id = source["field_id"];
	        this.value = source["value"];
	        this.source = source["source"];
	        this.reason = source["reason"];
	    }
	}
	export class RuntimePatch {
	    accepted: boolean;
	    reason: string;
	    inventory_patches: InventoryPatch[];
	    runtime_field_patches: RuntimeFieldPatch[];
	    memory_signal: MemorySignal;

	    static createFrom(source: any = {}) {
	        return new RuntimePatch(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.accepted = source["accepted"];
	        this.reason = source["reason"];
	        this.inventory_patches = this.convertValues(source["inventory_patches"], InventoryPatch);
	        this.runtime_field_patches = this.convertValues(source["runtime_field_patches"], RuntimeFieldPatch);
	        this.memory_signal = this.convertValues(source["memory_signal"], MemorySignal);
	    }

		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

	export class TurnResult {
	    state: GameState;
	    visible: string;
	    patch: RuntimePatch;
	    patchReport: PatchReport;
	    usedProvider: string;
	    diceRoll?: DiceRollResult;

	    static createFrom(source: any = {}) {
	        return new TurnResult(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.state = this.convertValues(source["state"], GameState);
	        this.visible = source["visible"];
	        this.patch = this.convertValues(source["patch"], RuntimePatch);
	        this.patchReport = this.convertValues(source["patchReport"], PatchReport);
	        this.usedProvider = source["usedProvider"];
	        this.diceRoll = this.convertValues(source["diceRoll"], DiceRollResult);
	    }

		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}

export namespace i18n {

	export class Language {
	    code: string;
	    native: string;
	    flag: string;

	    static createFrom(source: any = {}) {
	        return new Language(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.code = source["code"];
	        this.native = source["native"];
	        this.flag = source["flag"];
	    }
	}

}

export namespace main {

	export class TurnJobSnapshot {
	    id: string;
	    status: string;
	    actionId: string;
	    text: string;
	    kind?: string;
	    error?: string;
	    result?: engine.TurnResult;
	    createdAt: number;
	    startedAt?: number;
	    finishedAt?: number;

	    static createFrom(source: any = {}) {
	        return new TurnJobSnapshot(source);
	    }

	    constructor(source: any = {}) {
	        if ('string' === typeof source) source = JSON.parse(source);
	        this.id = source["id"];
	        this.status = source["status"];
	        this.actionId = source["actionId"];
	        this.text = source["text"];
	        this.kind = source["kind"];
	        this.error = source["error"];
	        this.result = this.convertValues(source["result"], engine.TurnResult);
	        this.createdAt = source["createdAt"];
	        this.startedAt = source["startedAt"];
	        this.finishedAt = source["finishedAt"];
	    }

		convertValues(a: any, classs: any, asMap: boolean = false): any {
		    if (!a) {
		        return a;
		    }
		    if (a.slice && a.map) {
		        return (a as any[]).map(elem => this.convertValues(elem, classs));
		    } else if ("object" === typeof a) {
		        if (asMap) {
		            for (const key of Object.keys(a)) {
		                a[key] = new classs(a[key]);
		            }
		            return a;
		        }
		        return new classs(a);
		    }
		    return a;
		}
	}

}
