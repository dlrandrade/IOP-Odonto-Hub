/** Matriz de permissões (PRD seção 3). Verificada no servidor em toda ação; espelhada em RLS. */
export const ROLES = ["admin", "gestor", "recepcao", "dentista", "comercial", "financeiro"] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  admin: "Administrador", gestor: "Gestor", recepcao: "Recepção",
  dentista: "Dentista", comercial: "Comercial", financeiro: "Financeiro",
};

const MATRIX = {
  "settings.manage": ["admin"],
  "users.manage": ["admin"],
  "integrations.manage": ["admin"],
  "ai.configure": ["admin"],
  "ai.kill_switch": ["admin", "gestor"],
  "catalog.publish": ["admin", "gestor"],
  "agenda.structure": ["admin", "gestor"],
  "conversations.view": ["admin", "gestor", "recepcao", "dentista", "comercial"],
  "conversations.reply": ["admin", "gestor", "recepcao", "dentista", "comercial"],
  "conversations.reassign": ["admin", "gestor"],
  "agenda.view": ["admin", "gestor", "recepcao", "dentista", "comercial"],
  "agenda.write": ["admin", "gestor", "recepcao"],
  "patients.view": ["admin", "gestor", "recepcao", "dentista", "comercial", "financeiro"],
  "patients.write": ["admin", "gestor", "recepcao", "comercial", "financeiro"],
  "patients.merge": ["admin", "gestor"],
  "crm.view": ["admin", "gestor", "recepcao", "dentista", "comercial"],
  "crm.write": ["admin", "gestor", "recepcao", "comercial"],
  "automations.manage": ["admin", "gestor"],
  "dashboard.view": ["admin", "gestor", "recepcao", "dentista", "comercial", "financeiro"],
  "audit.view": ["admin", "gestor"],
  "simulator.use": ["admin", "gestor", "recepcao", "comercial"],
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof MATRIX;

export function can(role: Role | null | undefined, permission: Permission): boolean {
  return !!role && (MATRIX[permission] as readonly Role[]).includes(role);
}

/** Dentista vê apenas conversas, agenda e pacientes vinculados a ele. */
export function isScopedToOwn(role: Role): boolean {
  return role === "dentista";
}

export class ForbiddenError extends Error {
  constructor(permission: string) {
    super(`Sem permissão para: ${permission}`);
    this.name = "ForbiddenError";
  }
}

export function assertCan(role: Role | null | undefined, permission: Permission): void {
  if (!can(role, permission)) throw new ForbiddenError(permission);
}
