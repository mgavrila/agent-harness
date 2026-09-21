import { CLIENT_ID_PATTERN } from '@harness/config-api';
import { badRequest } from './errors.js';

export const SLUG_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;

export function clientIdFor(orgSlug: string, agentSlug: string): string {
  const id = `${orgSlug}-${agentSlug}`;
  if (id.length > 64) throw badRequest(`"${id}" is longer than 64 characters; shorten the organisation or agent slug`);
  if (!CLIENT_ID_PATTERN.test(id)) throw badRequest(`"${id}" is not a valid client id`);
  return id;
}
