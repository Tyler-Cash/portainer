import type { Readable } from 'node:stream';

// Wraps a Node Readable as a Web ReadableStream without relying on
// Readable.toWeb(), which has a race condition where its internal 'end'/'data'
// handlers can call controller.close()/enqueue() after the consumer already
// canceled it (e.g. a client aborting mid-request), throwing an uncaught
// "Invalid state: Controller is already closed" TypeError. Every controller
// call here is individually guarded instead.
export function nodeStreamToResponseStream(
  nodeStream: Readable,
  onCancel?: () => void,
): ReadableStream {
  return new ReadableStream({
    start(controller) {
      nodeStream.on('data', (chunk) => {
        try {
          controller.enqueue(chunk);
        } catch {
          // Consumer already canceled — drop it.
        }
      });
      nodeStream.on('end', () => {
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });
      nodeStream.on('error', (err) => {
        try {
          controller.error(err);
        } catch {
          // Already closed/errored.
        }
      });
    },
    cancel() {
      nodeStream.destroy();
      onCancel?.();
    },
  });
}
