import { describe, expect, it } from 'vitest';
import type { EvidenceMark } from '../../src/modules/consults/shared-time.js';
import { sharedTime } from '../../src/modules/consults/shared-time.js';

/** Time together from consult evidence (docs/decisions/consults.md CNS4 to CNS6). */
const t0 = Date.UTC(2026, 10, 20, 0, 0, 0);
const s = (seconds: number) => new Date(t0 + seconds * 1000);

function mark(party: EvidenceMark['party'], event: EvidenceMark['event'], seconds: number, channel: EvidenceMark['channel'] = 'video'): EvidenceMark {
  return { party, event, channel, at: s(seconds) };
}

/** Both join at `from` and both leave at `to`. */
const call = (from: number, to: number, channel: EvidenceMark['channel'] = 'video') => [
  mark('patient', 'connected', from, channel),
  mark('clinician', 'connected', from, channel),
  mark('patient', 'disconnected', to, channel),
  mark('clinician', 'disconnected', to, channel),
];

describe('time together', () => {
  it('needs 60 seconds: 59 is not enough, 60 is', () => {
    expect(sharedTime(call(0, 59), 60).qualifiedAt).toBeNull();
    const exact = sharedTime(call(0, 60), 60);
    expect(exact.qualifiedAt).toEqual(s(60));
    expect(exact.provenMs).toBe(60_000);
  });

  it('adds time across a dropped call, and qualifies at the disconnect that completes it', () => {
    const shared = sharedTime([...call(0, 30), ...call(100, 130)], 60);
    expect(shared.provenMs).toBe(60_000);
    expect(shared.qualifiedAt).toEqual(s(130));
    expect(shared.firstProvenAt).toEqual(s(0));
    expect(shared.lastTogetherAt).toEqual(s(130));
  });

  it('counts only the time both were there', () => {
    const shared = sharedTime(
      [mark('patient', 'connected', 0), mark('clinician', 'connected', 50), mark('patient', 'disconnected', 100), mark('clinician', 'disconnected', 200)],
      60,
    );
    expect(shared.provenMs).toBe(50_000);
    expect(shared.qualifiedAt).toBeNull();
  });

  it('counts nothing that no disconnect closed, however long, but still knows they met (CNS4)', () => {
    const open = sharedTime([mark('patient', 'connected', 0), mark('clinician', 'connected', 0)], 60);
    expect(open.provenMs).toBe(0);
    expect(open.qualifiedAt).toBeNull();
    expect(open.firstTogetherAt).toEqual(s(0));
  });

  it('closes shared time when either one leaves', () => {
    const shared = sharedTime([mark('patient', 'connected', 0), mark('clinician', 'connected', 0), mark('patient', 'disconnected', 90)], 60);
    expect(shared.provenMs).toBe(90_000);
    expect(shared.qualifiedAt).toEqual(s(90));
  });

  it('never counts a patient on the phone with a clinician in the video room as together', () => {
    const shared = sharedTime(
      [
        mark('patient', 'connected', 0, 'phone'),
        mark('clinician', 'connected', 0, 'video'),
        mark('patient', 'disconnected', 300, 'phone'),
        mark('clinician', 'disconnected', 300, 'video'),
      ],
      60,
    );
    expect(shared.provenMs).toBe(0);
    expect(shared.firstTogetherAt).toBeNull();
  });

  it('counts time on two channels at once only once, and adds a fallback from video to phone', () => {
    expect(sharedTime([...call(0, 40, 'video'), ...call(0, 40, 'phone')], 60).provenMs).toBe(40_000);
    const fallback = sharedTime([...call(0, 40, 'video'), ...call(50, 70, 'phone')], 60);
    expect(fallback.provenMs).toBe(60_000);
    expect(fallback.qualifiedAt).toEqual(s(70));
  });

  it('never doubles time for a second device or a repeated callback', () => {
    const shared = sharedTime([...call(0, 40), mark('patient', 'connected', 10), mark('patient', 'connected', 20), mark('clinician', 'disconnected', 40)], 60);
    expect(shared.provenMs).toBe(40_000);
  });

  it('works from provider times, whatever order the callbacks arrived in', () => {
    expect(sharedTime(call(0, 60).reverse(), 60).qualifiedAt).toEqual(s(60));
  });

  it('closes a connect and disconnect in the same second at once, so a blip never stays open', () => {
    const shared = sharedTime(
      [mark('patient', 'disconnected', 5), mark('patient', 'connected', 5), mark('clinician', 'connected', 0), mark('clinician', 'disconnected', 300), mark('patient', 'disconnected', 300)],
      60,
    );
    expect(shared.provenMs).toBe(0);
  });
});
