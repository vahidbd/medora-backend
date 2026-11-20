import { describe, expect, it } from 'vitest';
import { abnValid, colourReadable, normaliseAbn, normaliseHost } from '../../src/modules/brands/checks.js';

/** The checks a tenant's details pass before they are saved (docs/decisions/admin.md ADM17, ADM19). */
describe('ABN', () => {
  it("passes the ATO's published example and fails a changed digit", () => {
    expect(abnValid(normaliseAbn('51 824 753 556'))).toBe(true);
    expect(abnValid('51824753557')).toBe(false);
    expect(abnValid('5182475355')).toBe(false);
    expect(abnValid('5182475355a')).toBe(false);
  });
});

describe('host', () => {
  it('takes a domain as typed down to its host name, and refuses what is not one', () => {
    expect(normaliseHost(' HTTPS://App.Example.com.au:443/start?x=1 ')).toBe('app.example.com.au');
    expect(normaliseHost('example.com.au.')).toBe('example.com.au');
    expect(normaliseHost('localhost')).toBeNull();
    expect(normaliseHost('bad_host.example.com')).toBeNull();
    expect(normaliseHost('-start.example.com')).toBeNull();
  });
});

describe('brand colour', () => {
  it('accepts a colour that white or near-black text can be read on, and refuses mid grey', () => {
    expect(colourReadable('#1f6feb')).toBe(true);
    expect(colourReadable('#ffd400')).toBe(true);
    expect(colourReadable('#777777')).toBe(false);
  });
});
