import { requireCtx } from "@/auth/session";
import { PageHeader } from "@/components/ui";
import { ROLE_LABELS } from "@/domain/permissions";
import { ProfileForm } from "../../perfil/profile-form";
import { VistaSwitch } from "@/components/vista";
import { InstallHint } from "@/components/pwa";

export const metadata = { title: "Meu perfil" };

export default async function ProfilePage() {
  const ctx = await requireCtx();
  return (
    <>
      <PageHeader title="Meu perfil" subtitle="Seu nome, sua foto e sua senha. Cada pessoa da equipe altera os próprios dados aqui." />
      <div className="space-y-6">
        <ProfileForm name={ctx.name} email={ctx.email} avatar={ctx.avatar} roleLabel={ctx.actingAsPlatform ? "Operador da plataforma" : ROLE_LABELS[ctx.role]} />
        <section aria-label="Visualização" className="max-w-xl">
          <VistaSwitch detailed={ctx.detailed} />
        </section>
        <section aria-label="Instalar o app" className="vidro max-w-xl rounded-lg p-5">
          <InstallHint always />
        </section>
      </div>
    </>
  );
}
