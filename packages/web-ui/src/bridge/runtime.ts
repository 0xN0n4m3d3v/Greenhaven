// runtime.ts — drop-in replacement for the desktop runtime's
// `EventsOn` / `EventsEmit`. In the Wails build these were a bridge
// to the Go-side event bus; here they are an in-process pub/sub.
//
// The Node-side Greenhaven bridge will eventually
// push events here via SSE / WebSocket and call `__emit` from a
// transport adapter. Until that lands, only the local UI emits into
// this bus (e.g. for optimistic updates).

type Listener = (...args: unknown[]) => void;

const listeners = new Map<string, Set<Listener>>();

export function EventsOn(eventName: string, callback: Listener): () => void {
  let bucket = listeners.get(eventName);
  if (!bucket) {
    bucket = new Set();
    listeners.set(eventName, bucket);
  }
  bucket.add(callback);
  return () => {
    bucket?.delete(callback);
  };
}

export function EventsEmit(eventName: string, ...args: unknown[]): void {
  const bucket = listeners.get(eventName);
  if (!bucket) return;
  for (const cb of bucket) {
    try {
      cb(...args);
    } catch (err) {
      // Swallow — listener errors must not stop event propagation.
      console.error(`[runtime] listener for "${eventName}" threw:`, err);
    }
  }
}

// __emit is the back door the future Node-bridge transport adapter
// will call when it receives an SSE/WS event. Public, but prefix
// signals "internal" intent.
export function __emit(eventName: string, ...args: unknown[]): void {
  EventsEmit(eventName, ...args);
}
