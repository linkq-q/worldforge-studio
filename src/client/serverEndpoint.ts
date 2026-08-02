export interface BrowserServerLocation {
  protocol: string;
  hostname: string;
  origin: string;
}

export function serverHttpBase(location: BrowserServerLocation, development: boolean): string {
  if (!development) return location.origin;
  return `${location.protocol}//${location.hostname || 'localhost'}:${WORLD_FORGE_DEV_API_PORT}`;
}
import { WORLD_FORGE_DEV_API_PORT } from '../shared/network';
