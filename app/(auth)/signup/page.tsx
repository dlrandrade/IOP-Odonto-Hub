import Link from "next/link";
import { redirect } from "next/navigation";
import { AuthFrame } from "@/components/brand";
import { ActionForm } from "@/components/client";
import { Button, Field, Input } from "@/components/ui";
import { missingEnv } from "@/lib/env";
import { signupAction } from "../actions";

export const metadata = { title: "Criar conta" };
export const dynamic = "force-dynamic";

export default function SignupPage() {
  if (missingEnv().length > 0) redirect("/setup");
  return (
    <AuthFrame title="Comece em" highlight="5 minutos" subtitle="Crie a conta, diga quantas cadeiras e dentistas você tem e a central já nasce com agenda, catálogo e automações prontos para revisar.">
      <h2 className="text-2xl font-bold">Criar conta</h2>
      <p className="mb-6 mt-1 text-sm text-bone-mute">Você será o administrador da clínica.</p>
      <ActionForm action={signupAction} className="space-y-4" resetOnDone={false}>
        <Field label="E-mail"><Input name="email" type="email" autoComplete="email" required /></Field>
        <Field label="Senha" hint="Mínimo de 8 caracteres."><Input name="password" type="password" autoComplete="new-password" minLength={8} required /></Field>
        <Button type="submit" variant="accent" className="w-full">Criar conta</Button>
      </ActionForm>
      <p className="mt-6 text-sm text-bone-mute">Já tem conta? <Link href="/login" className="font-semibold text-bone underline">Entrar</Link></p>
    </AuthFrame>
  );
}
