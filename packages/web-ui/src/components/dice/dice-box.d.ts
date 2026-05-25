// Type stub for @3d-dice/dice-box (no @types package published).
declare module '@3d-dice/dice-box' {
  export default class DiceBox {
    constructor(config: {
      assetPath?: string;
      container?: string;
      theme?: string;
      scale?: number;
      gravity?: number;
      mass?: number;
      friction?: number;
      restitution?: number;
      angularDamping?: number;
      linearDamping?: number;
      shadowTransparency?: number;
      [k: string]: unknown;
    });
    init(): Promise<unknown>;
    add(notation: string, options?: {themeColor?: string; [k: string]: unknown}): void;
    clear?(): void;
    destroy?(): void;
  }
}
