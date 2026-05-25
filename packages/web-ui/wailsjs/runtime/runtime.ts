// Shim: this file replaces the Wails-generated runtime bindings.
// It re-exports the in-process pub/sub from src/bridge/runtime.ts so
// the existing `import { EventsOn } from '../wailsjs/runtime/runtime'`
// in App.tsx works unchanged.
export {EventsOn, EventsEmit} from '../../src/bridge/runtime';
