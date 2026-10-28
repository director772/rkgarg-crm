// Cloudflare Pages Function: every /api/<name> request goes to the router.
import { handle } from '../../src/api.js';

export async function onRequest(context) {
  const parts = context.params.path || [];
  const name = Array.isArray(parts) ? parts.join('/') : String(parts);
  return handle(context.request, context.env, name);
}
