import type { ConsultMode, EvidenceEvent, EvidenceParty } from '../../db/schema/values.js';

/**
 * Time the patient and clinician were connected together, worked out from
 * consult evidence alone (docs/decisions/consults.md CNS4 to CNS6). Pure, so
 * the rules are tested without a database.
 */

export interface EvidenceMark {
  party: EvidenceParty;
  event: EvidenceEvent;
  channel: ConsultMode;
  at: Date;
}

export interface SharedTime {
  /** The first moment both were connected, even if nobody has left yet. Only for the consult's status. */
  firstTogetherAt: Date | null;
  /** Time together closed at both ends by the provider's timestamps, merged across channels. */
  provenMs: number;
  /** The disconnect that brought proven time to the floor, or null if it hasn't. */
  qualifiedAt: Date | null;
  /** The end of the last proven time together. */
  lastTogetherAt: Date | null;
  /** The start of the first proven time together. */
  firstProvenAt: Date | null;
}

interface Span {
  from: number;
  /** Infinity while nobody has said the party left. */
  to: number;
}

/**
 * One party's spans in one channel. A connect opens a span and a disconnect
 * closes it; a repeat changes nothing, so two devices never double the time.
 * A connect and a disconnect in the same second sort connect first, so a
 * blip closes at once rather than staying open (CNS5).
 */
function spansOf(marks: EvidenceMark[]): Span[] {
  const sorted = [...marks].sort((a, b) => a.at.getTime() - b.at.getTime() || (a.event === b.event ? 0 : a.event === 'connected' ? -1 : 1));
  const spans: Span[] = [];
  let open: number | null = null;
  for (const mark of sorted) {
    const at = mark.at.getTime();
    if (mark.event === 'connected' && open === null) open = at;
    if (mark.event === 'disconnected' && open !== null) {
      spans.push({ from: open, to: at });
      open = null;
    }
  }
  if (open !== null) spans.push({ from: open, to: Infinity });
  return spans;
}

function overlaps(a: Span[], b: Span[]): Span[] {
  const shared: Span[] = [];
  for (const x of a) {
    for (const y of b) {
      const from = Math.max(x.from, y.from);
      const to = Math.min(x.to, y.to);
      if (to > from) shared.push({ from, to });
    }
  }
  return shared;
}

/** Merges spans that touch or overlap, so time in two channels at once counts once. */
function merged(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const span of [...spans].sort((a, b) => a.from - b.from)) {
    const last = out.at(-1);
    if (last && span.from <= last.to) last.to = Math.max(last.to, span.to);
    else out.push({ ...span });
  }
  return out;
}

/**
 * `marks` are the patient's rows and the one clinician's rows, already cut to
 * what was known at the moment asked about. Overlap is found within each
 * channel (a patient on the phone and a clinician in the video room are not
 * together), then merged.
 */
export function sharedTime(marks: EvidenceMark[], floorSeconds: number): SharedTime {
  const together: Span[] = [];
  for (const channel of ['phone', 'video'] as const) {
    const inChannel = marks.filter((mark) => mark.channel === channel);
    together.push(
      ...overlaps(
        spansOf(inChannel.filter((mark) => mark.party === 'patient')),
        spansOf(inChannel.filter((mark) => mark.party === 'clinician')),
      ),
    );
  }
  const firstTogether = together.length > 0 ? Math.min(...together.map((span) => span.from)) : null;
  // CNS4: time with no provider timestamp at its end counts for nothing.
  const proven = merged(together.filter((span) => Number.isFinite(span.to)));
  let provenMs = 0;
  let qualifiedAt: Date | null = null;
  for (const span of proven) {
    provenMs += span.to - span.from;
    if (!qualifiedAt && provenMs >= floorSeconds * 1000) qualifiedAt = new Date(span.to);
  }
  return {
    firstTogetherAt: firstTogether === null ? null : new Date(firstTogether),
    provenMs,
    qualifiedAt,
    lastTogetherAt: proven.length > 0 ? new Date(proven.at(-1)!.to) : null,
    firstProvenAt: proven.length > 0 ? new Date(proven[0]!.from) : null,
  };
}
