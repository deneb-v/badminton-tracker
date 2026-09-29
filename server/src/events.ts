import type { Response } from 'express';

/** In-process fan-out of "session changed" notifications to SSE clients. */
const subscribers = new Map<number, Set<Response>>();

export function subscribe(sessionId: number, res: Response): () => void {
  let set = subscribers.get(sessionId);
  if (!set) subscribers.set(sessionId, (set = new Set()));
  set.add(res);
  return () => {
    set.delete(res);
    if (set.size === 0) subscribers.delete(sessionId);
  };
}

export function publish(sessionId: number, version: number): void {
  for (const res of subscribers.get(sessionId) ?? []) {
    res.write(`event: changed\ndata: ${JSON.stringify({ version })}\n\n`);
  }
}
