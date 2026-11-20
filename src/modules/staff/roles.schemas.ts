import { z } from 'zod';
import { DATA_ZONES } from '../../db/schema/values.js';
import { permissionSchema, startingRoleSchema } from './staff.schemas.js';

export const startingRole = z.object({
  key: startingRoleSchema,
  /** A clinical role uses its clinical permissions without break-glass (ADM3). */
  clinical: z.boolean(),
  permissions: z.array(permissionSchema),
  memberCount: z.number().int(),
});

export const customRole = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string(),
  basedOn: startingRoleSchema,
  clinical: z.boolean(),
  permissions: z.array(permissionSchema),
  memberCount: z.number().int(),
  updatedAt: z.iso.datetime(),
});
export type CustomRole = z.infer<typeof customRole>;

export const rolesReply = z.object({
  startingRoles: z.array(startingRole),
  customRoles: z.array(customRole),
  /** Every permission there is, with the data zone it opens. */
  permissions: z.array(z.object({ key: permissionSchema, zone: z.enum(DATA_ZONES) })),
});
export type RolesReply = z.infer<typeof rolesReply>;

const name = z.string().trim().min(1).max(60);
const description = z.string().trim().max(300);

export const roleInput = z
  .object({ basedOn: startingRoleSchema, name, description: description.optional(), permissions: z.array(permissionSchema).max(500) })
  .strict();
export type RoleInput = z.infer<typeof roleInput>;

export const roleUpdate = z
  .object({ name: name.optional(), description: description.optional(), permissions: z.array(permissionSchema).max(500).optional() })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Send a name, a description or permissions' });
export type RoleUpdate = z.infer<typeof roleUpdate>;

export const roleParams = z.object({ roleId: z.uuid() });
export const roleDeletedReply = z.object({ roleId: z.uuid() });
