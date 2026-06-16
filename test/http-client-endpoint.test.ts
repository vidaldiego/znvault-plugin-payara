// Path: test/http-client-endpoint.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildPluginUrl,
  setEndpointOverride,
  clearEndpointOverride,
  clearAllEndpointOverrides,
} from '../src/cli/http-client.js';

describe('endpoint overrides', () => {
  beforeEach(() => clearAllEndpointOverrides());

  it('uses the override host:port when one is registered', () => {
    setEndpointOverride('172.16.220.55', '127.0.0.1', 54321);
    expect(buildPluginUrl('172.16.220.55', 9100)).toBe('http://127.0.0.1:54321/plugins/payara');
  });

  it('falls back to the real host:port when no override exists', () => {
    expect(buildPluginUrl('172.16.220.56', 9100)).toBe('http://172.16.220.56:9100/plugins/payara');
  });

  it('clearEndpointOverride removes a single override', () => {
    setEndpointOverride('h', '127.0.0.1', 1);
    clearEndpointOverride('h');
    expect(buildPluginUrl('h', 9100)).toBe('http://h:9100/plugins/payara');
  });
});
