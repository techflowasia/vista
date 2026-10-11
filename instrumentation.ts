/**
 * Process-scoped startup work.
 *
 * Next calls `register` once per server instance, before it serves a request.
 * That makes it the only place in this app where a background schedule can
 * live: a route module has no such guarantee — it can be instantiated more than
 * once and gets no shutdown hook — so anything periodic started from one is
 * really started per instantiation.
 *
 * `register` must return before the server is ready, so nothing here may block
 * on I/O. Starting a timer does not.
 */
export async function register(): Promise<void> {
  // Only invoke and statically import Node.js logic when running under the Node.js runtime.
  // This ensures Next.js Edge bundle for instrumentation does not bundle Node.js built-ins.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { registerNode } = await import('@/lib/server/instrumentation-node');
    await registerNode();
  }
}
