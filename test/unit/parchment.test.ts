import { describe, expect, it } from 'vitest';
import { patientBody } from '../../src/modules/prescribing/parchment/client.js';
import { australianMobile, streetParts, toParchmentPatient } from '../../src/modules/prescribing/parchment/patient.js';
import type { PrescribingPatient } from '../../src/modules/prescribing/ports.js';

/** A made-up patient. */
const patient: PrescribingPatient = {
  patientId: '00000000-0000-4000-8000-0000000000aa',
  givenName: ' Robin ',
  familyName: 'Example',
  dateOfBirth: '1980-02-29',
  sex: 'not_stated',
  email: 'Robin@Example.test',
  mobile: '+61 400 000 000',
  address: { line1: '3 / 12A Test Street', line2: 'Rear entrance', suburb: 'Sampleton', state: 'VIC', postcode: '3000' },
  medicare: { number: '0000 00000 0', irn: '1', validTo: '2030-01' },
};

describe("the patient's details for Parchment (RX2)", () => {
  it('sends identity and contact only, tidied the way Parchment takes them', () => {
    const mapped = toParchmentPatient(patient);
    expect(mapped).toEqual({
      details: {
        partnerPatientId: patient.patientId,
        givenName: 'Robin',
        familyName: 'Example',
        dateOfBirth: '1980-02-29',
        sex: 'N',
        email: 'robin@example.test',
        mobile: '0400000000',
        address: { streetNumber: '3/12A', streetName: 'Test Street, Rear entrance', suburb: 'Sampleton', state: 'VIC', postcode: '3000' },
        medicare: { number: '0000000000', irn: '1', validTo: '2030-01' },
      },
    });
  });

  it("names, in plain words, what's missing", () => {
    expect(toParchmentPatient({ ...patient, givenName: ' ', mobile: '02 9999 0000', address: null })).toEqual({
      missing: ['given name', 'an Australian mobile number', 'home address'],
    });
  });

  it('reads Australian mobiles, and a street line without a number', () => {
    expect(australianMobile('0412 345 678')).toBe('0412345678');
    expect(australianMobile('61412345678')).toBe('0412345678');
    expect(australianMobile('(02) 9999 0000')).toBeNull();
    expect(streetParts('Lot Road')).toEqual({ streetNumber: '-', streetName: 'Lot Road' });
  });

  it('leaves Medicare and the mobile out of the body when there are none', () => {
    const mapped = toParchmentPatient({ ...patient, medicare: null });
    if (!('details' in mapped)) throw new Error('expected details');
    const body = patientBody(mapped.details);
    expect(body).not.toHaveProperty('medicare_card_number');
    expect(body).toMatchObject({ partner_patient_id: patient.patientId, mobile_phone: '0400000000' });
  });
});
