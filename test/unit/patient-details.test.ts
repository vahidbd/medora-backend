import { describe, expect, it } from 'vitest';
import { ageOn, dateOfBirthProblem, isMedicareNumber, normaliseEmail, normaliseMobile } from '../../src/modules/patients/patient-details.js';

/** What patients type about themselves (docs/decisions/patients.md IDN5, IDN8). Made-up values. */
describe('date of birth and age (IDN-03)', () => {
  it('counts whole years, with a 29 February birthday turning over on 1 March', () => {
    expect(ageOn('2000-06-15', '2018-06-14')).toBe(17);
    expect(ageOn('2000-06-15', '2018-06-15')).toBe(18);
    expect(ageOn('2004-02-29', '2022-02-28')).toBe(17);
    expect(ageOn('2004-02-29', '2022-03-01')).toBe(18);
  });

  it('turns 18 on the tenant’s calendar day, not UTC’s', () => {
    // 14:30 UTC on 14 June is already 15 June in Sydney (UTC+10), still 14 June in Perth (UTC+8).
    const instant = new Date('2026-06-14T14:30:00Z');
    expect(dateOfBirthProblem('2008-06-15', instant, 'Australia/Sydney')).toBeNull();
    expect(dateOfBirthProblem('2008-06-15', instant, 'Australia/Perth')).toBe('under_age');
  });

  it('refuses dates that are not real, in the future or implausibly old', () => {
    const now = new Date('2026-11-20T00:00:00Z');
    expect(dateOfBirthProblem('1990-02-30', now, 'Australia/Sydney')).toBe('not_a_date');
    expect(dateOfBirthProblem('2027-01-01', now, 'Australia/Sydney')).toBe('in_the_future');
    expect(dateOfBirthProblem('1890-01-01', now, 'Australia/Sydney')).toBe('too_long_ago');
    expect(dateOfBirthProblem('1990-02-28', now, 'Australia/Sydney')).toBeNull();
  });
});

describe('contact details', () => {
  it('stores Australian mobiles as E.164', () => {
    expect(normaliseMobile('0412 345 678')).toBe('+61412345678');
    expect(normaliseMobile('+61 412-345-678')).toBe('+61412345678');
    expect(normaliseMobile('02 9999 9999')).toBeNull();
    expect(normaliseMobile('0412 345 67')).toBeNull();
  });

  it('lowercases emails and refuses what is not one', () => {
    expect(normaliseEmail(' Someone@Example.TEST ')).toBe('someone@example.test');
    expect(normaliseEmail('not an email')).toBeNull();
  });
});

describe('Medicare numbers (IDN5)', () => {
  it('checks the check digit', () => {
    expect(isMedicareNumber('2123456701')).toBe(true);
    expect(isMedicareNumber('2123456711')).toBe(false);
    expect(isMedicareNumber('7123456701')).toBe(false);
    expect(isMedicareNumber('212345670')).toBe(false);
  });
});
