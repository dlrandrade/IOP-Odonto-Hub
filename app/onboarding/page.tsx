import { redirect } from "next/navigation";
import { getIdentity } from "@/auth/session";
import { AuthFrame } from "@/components/brand";
import { ActionForm } from "@/components/client";
import { Button, Checkbox, Field, Input, Textarea } from "@/components/ui";
import { missingEnv } from "@/lib/env";
import { logoutAction, onboardingAction } from "../(auth)/actions";

export const metadata = { title: "Configurar clínica" };

export default async function OnboardingPage() {
  if (missingEnv().length > 0) redirect("/setup");
  const me = await getIdentity();
  if (!me) redirect("/login");
  if (me.appUser) redirect("/");
  return (
    <AuthFrame title="Conte o básico. O resto já vem pronto." subtitle="Criamos a unidade, as cadeiras, a agenda de cada dentista, um catálogo de serviços em rascunho, os modelos de mensagem e o protocolo de urgência para você revisar.">
      <h2 className="display text-[30px] leading-tight">Configurar sua clínica</h2>
      <p className="mb-6 mt-1 text-sm text-bone-mute">Tudo pode ser ajustado depois em Configurações.</p>
      <ActionForm action={onboardingAction} className="space-y-4" resetOnDone={false}>
        <Field label="Nome da clínica"><Input name="clinicName" required placeholder="Ex.: Clínica Sorriso" /></Field>
        <Field label="Seu nome"><Input name="ownerName" required /></Field>
        <Field label="Quantas cadeiras?"><Input name="chairs" type="number" min={1} max={30} defaultValue={2} required /></Field>
        <Field label="Dentistas" hint="Um por linha, no formato: Nome; Especialidade. O expediente padrão é seg–sex 8h–18h e sáb 8h–12h.">
          <Textarea name="professionals" required placeholder={"Dra. Ana Lima; Clínica geral\nDr. Caio Reis; Ortodontia"} />
        </Field>
        <Checkbox name="demo" label="Quero uma clínica de demonstração" hint="Ignora os campos acima (exceto o nome) e cria dados fictícios para explorar: pacientes, consultas e funil." />
        <Button type="submit" variant="accent" className="w-full">Criar minha central</Button>
      </ActionForm>
      <form action={logoutAction} className="mt-6"><button className="text-sm text-bone-mute underline">Sair ({me.email})</button></form>
    </AuthFrame>
  );
}
