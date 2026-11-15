import { requireCtx } from "@/auth/session";
import { PageHeader } from "@/components/ui";
import { ROLE_LABELS } from "@/domain/permissions";
import { ProfileForm } from "../../perfil/profile-form";

export const metadata = { title: "Meu perfil" };

export default async function ProfilePage() {
  const ctx = await requireCtx();
  return (
    <>
      <PageHeader title="Meu perfil" subtitle="Seu nome, sua foto e sua senha. Cada pessoa da equipe altera os próprios dados aqui." />
      <ProfileForm name={ctx.name} email={ctx.email} avatar={ctx.avatar} roleLabel={ctx.actingAsPlatform ? "Operador da plataforma" : ROLE_LABELS[ctx.role]} />
    </>
  );
}
