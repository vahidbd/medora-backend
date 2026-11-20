import { and, eq } from 'drizzle-orm';
import { programs, protocols } from '../../db/schema/index.js';
import type { MeasurementKind, ProgramStatus } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { getBrand } from '../brands/index.js';
import { liveVersionOf } from './protocols.service.js';

/**
 * Programs (docs/decisions/intake.md INT9): what a brand sells, on one
 * protocol. A program can be live only while its protocol has a live
 * version. Billing puts prices on programs (getProgram from the front door).
 */

const RECORD = 'operational.programs' as const;

export interface Program {
  programId: string;
  brandId: string;
  protocolId: string;
  /** The protocol's condition: a program inherits it (INT9). */
  condition: string;
  name: string;
  status: ProgramStatus;
  measurements: MeasurementKind[];
  checkInEveryDays: number | null;
}

const columns = {
  programId: programs.id,
  brandId: programs.brandId,
  protocolId: programs.protocolId,
  condition: protocols.condition,
  name: programs.name,
  status: programs.status,
  measurements: programs.measurements,
  checkInEveryDays: programs.checkInEveryDays,
};

type Row = { programId: string; brandId: string; protocolId: string; condition: string; name: string; status: string; measurements: string[]; checkInEveryDays: number | null };
const toProgram = (row: Row): Program => ({ ...row, status: row.status as ProgramStatus, measurements: row.measurements as MeasurementKind[] });

function select(tx: TenantTx) {
  return tx.db
    .select(columns)
    .from(programs)
    .innerJoin(protocols, and(eq(protocols.tenantId, programs.tenantId), eq(protocols.id, programs.protocolId)));
}

export async function listPrograms(tx: TenantTx): Promise<Program[]> {
  return (await select(tx).where(eq(programs.tenantId, tx.context.tenantId)).orderBy(programs.name)).map(toProgram);
}

/** One program; NotFoundError outside the tenant. */
export async function getProgram(tx: TenantTx, programId: string): Promise<Program> {
  const [row] = await select(tx).where(and(eq(programs.tenantId, tx.context.tenantId), eq(programs.id, programId)));
  if (!row) throw new NotFoundError('Program');
  return toProgram(row);
}

export interface ProgramInput {
  brandId: string;
  protocolId: string;
  name: string;
  measurements: MeasurementKind[];
  checkInEveryDays: number | null;
}

export async function createProgram(tx: TenantTx, input: ProgramInput): Promise<Program> {
  const tenantId = tx.context.tenantId;
  await getBrand(tx, input.brandId);
  const [protocol] = await tx.db.select({ id: protocols.id }).from(protocols).where(and(eq(protocols.tenantId, tenantId), eq(protocols.id, input.protocolId)));
  if (!protocol) throw new NotFoundError('Protocol');
  const [row] = await tx.db.insert(programs).values({ tenantId, ...input, measurements: [...new Set(input.measurements)] }).returning({ id: programs.id });
  await audit(tx, { action: 'program.created', zone: 'operational', recordTable: RECORD, recordId: row!.id });
  return getProgram(tx, row!.id);
}

export type ProgramChange = Partial<Omit<ProgramInput, 'brandId' | 'protocolId'>> & { status?: ProgramStatus };

const MOVES: Record<ProgramStatus, readonly ProgramStatus[]> = {
  draft: ['live', 'retired'],
  live: ['paused', 'retired'],
  paused: ['live', 'retired'],
  retired: [],
};

/** Change a program's details or status. Going live needs the protocol's live version; retired is final. */
export async function changeProgram(tx: TenantTx, programId: string, change: ProgramChange): Promise<Program> {
  const tenantId = tx.context.tenantId;
  const [current] = await tx.db
    .select({ status: programs.status, protocolId: programs.protocolId })
    .from(programs)
    .where(and(eq(programs.tenantId, tenantId), eq(programs.id, programId)))
    .for('update');
  if (!current) throw new NotFoundError('Program');
  const from = current.status as ProgramStatus;
  if (from === 'retired') throw new BusinessRuleError('A retired program can’t be changed', 'program_retired');
  if (change.status && change.status !== from) {
    if (!MOVES[from].includes(change.status)) throw new BusinessRuleError(`A ${from} program can’t become ${change.status}`, 'program_status');
    if (change.status === 'live' && !(await liveVersionOf(tx, current.protocolId))) {
      throw new BusinessRuleError('The protocol needs a signed-off live version before the program can go live', 'protocol_not_live');
    }
  }
  const set: Partial<typeof programs.$inferInsert> = { updatedAt: new Date() };
  if (change.name !== undefined) set.name = change.name;
  if (change.measurements !== undefined) set.measurements = [...new Set(change.measurements)];
  if (change.checkInEveryDays !== undefined) set.checkInEveryDays = change.checkInEveryDays;
  if (change.status !== undefined) set.status = change.status;
  await tx.db.update(programs).set(set).where(and(eq(programs.tenantId, tenantId), eq(programs.id, programId)));
  const fields = Object.keys(change).filter((field) => change[field as keyof ProgramChange] !== undefined);
  await audit(tx, { action: 'program.updated', zone: 'operational', recordTable: RECORD, recordId: programId, details: { fields: fields.join(',') } });
  if (change.status && change.status !== from) {
    await emitEvent(tx, { type: 'program.status_changed', recordTable: RECORD, recordId: programId, payload: { from, to: change.status } });
  }
  return getProgram(tx, programId);
}
