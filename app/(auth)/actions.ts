"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { signIn, signOut, signUp } from "@/auth/provider";
import { getIdentity } from "@/auth/session";
import { db } from "@/db/client";
import type { ActionState } from "@/components/client";
import { createClinic } from "@/services/clinic-setup";
import { seedDemoClinic } from "@/services/demo";

const credentials = z.object({
  email: z.string().trim().toLowerCase().email("Informe um e-mail válido."),
  password: z.string().min(8, "A senha precisa ter ao menos 8 caracteres."),
});

export async function loginAction(_: ActionState, form: FormData): Promise<ActionState> {
  const parsed = credentials.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const r = await signIn(parsed.data.email, parsed.data.password);
  if (!r.ok) return { error: r.error };
  redirect("/");
}

export async function signupAction(_: ActionState, form: FormData): Promise<ActionState> {
  if (process.env.ALLOW_SIGNUP === "false") return { error: "O cadastro está fechado. Fale com o suporte." };
  const parsed = credentials.safeParse({ email: form.get("email"), password: form.get("password") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const r = await signUp(parsed.data.email, parsed.data.password);
  if (!r.ok) return { error: r.error };
  if ("pendingConfirmation" in r) return { ok: true, message: "Quase lá: enviamos um link para o seu e-mail. Clique nele para ativar a conta e continuar o cadastro da clínica." };
  redirect("/onboarding");
}

export async function logoutAction(): Promise<void> {
  await signOut();
  redirect("/login");
}

const onboarding = z.object({
  clinicName: z.string().trim().min(2, "Informe o nome da clínica."),
  ownerName: z.string().trim().min(2, "Informe seu nome."),
  chairs: z.coerce.number().int().min(1).max(30),
  professionals: z.string().trim().min(2, "Cadastre ao menos um dentista."),
  demo: z.boolean(),
});

/** Onboarding em um passo: cria a clínica já configurada (ou uma clínica de demonstração). */
export async function onboardingAction(_: ActionState, form: FormData): Promise<ActionState> {
  const me = await getIdentity();
  if (!me) redirect("/login");
  if (me.appUser) redirect("/");
  const parsed = onboarding.safeParse({
    clinicName: form.get("clinicName"), ownerName: form.get("ownerName"), chairs: form.get("chairs"),
    professionals: form.get("professionals"), demo: form.get("demo") === "on",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message };
  const owner = { authUserId: me.authUserId, email: me.email, name: parsed.data.ownerName };
  if (parsed.data.demo) {
    await seedDemoClinic(db(), owner, `${parsed.data.clinicName} (demo)`);
  } else {
    const professionals = parsed.data.professionals.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 30).map((line) => {
      const [name, specialty] = line.split(/[;,–-]\s*/, 2);
      return { name: (name ?? line).trim(), specialty: specialty?.trim() || null };
    });
    await createClinic(db(), { clinicName: parsed.data.clinicName, owner, chairs: parsed.data.chairs, professionals });
  }
  redirect("/");
}
