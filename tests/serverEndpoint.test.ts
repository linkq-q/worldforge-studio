import { describe, expect, it } from 'vitest';
import { serverHttpBase, type BrowserServerLocation } from '../src/client/serverEndpoint';

function location(origin: string): BrowserServerLocation {
  const url = new URL(origin);
  return { origin: url.origin, protocol: url.protocol, hostname: url.hostname };
}

describe('server endpoint selection', () => {
  it('uses the local API port during Vite development', () => {
    expect(serverHttpBase(location('http://192.168.1.20:5173'), true))
      .toBe('http://192.168.1.20:8797');
  });

  it('uses the current origin in a production build', () => {
    expect(serverHttpBase(location('https://studio.example.test'), false))
      .toBe('https://studio.example.test');
  });
});
