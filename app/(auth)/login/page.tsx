import Link from "next/link";
import { redirect } from "next/navigation";
import { getIdentity } from "@/auth/session";
import { AuthFrame } from "@/components/brand";
import { ActionForm } from "@/components/client";
import { Button, Field, Input, Notice } from "@/components/ui";
import { missingEnv } from "@/lib/env";
import { loginAction } from "../actions";

export const metadata = { title: "Entrar" };

const ERRORS: Record<string, string> = {
  desativado: "Seu acesso foi desativado. Fale com o administrador da clínica.",
  suspensa: "A conta desta clínica está suspensa. Fale com o suporte.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ erro?: string }> }) {
  if (missingEnv().length > 0) redirect("/setup");
  const { erro } = await searchParams;
  if (!erro && (await getIdentity())) redirect("/");
  return (
    <AuthFrame title="Sua clínica em uma central só." subtitle="WhatsApp, agenda, pacientes e CRM no mesmo lugar, com uma assistente virtual que agenda sozinha e sabe a hora de chamar a equipe.">
      <h2 className="display text-[30px] leading-tight">Entrar</h2>
      <p className="mb-6 mt-1 text-sm text-bone-mute">Acesse a central da sua clínica.</p>
      {erro && ERRORS[erro] && <div className="mb-4"><Notice tone="danger">{ERRORS[erro]}</Notice></div>}
      <ActionForm action={loginAction} className="space-y-4" resetOnDone={false}>
        <Field label="E-mail"><Input name="email" type="email" autoComplete="email" required /></Field>
        <Field label="Senha"><Input name="password" type="password" autoComplete="current-password" required /></Field>
        <Button type="submit" className="w-full">Entrar</Button>
      </ActionForm>
      <p className="mt-6 text-sm text-bone-mute">
        Ainda não tem conta? <Link href="/signup" className="font-semibold text-bone underline">Cadastre sua clínica</Link>
      </p>
    </AuthFrame>
  );
}
