"use client";

import { useRef, useState } from "react";
import { Camera, Trash2 } from "lucide-react";
import { ActionForm } from "@/components/client";
import { Avatar, Button, Field, Input } from "@/components/ui";
import { changePasswordAction, saveProfileAction } from "./actions";

/** Reduz a foto no navegador (quadrado de 160 px, JPEG) para não guardar imagens pesadas. */
async function shrink(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const size = 160;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const side = Math.min(bitmap.width, bitmap.height);
  canvas.getContext("2d")!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  return canvas.toDataURL("image/jpeg", 0.85);
}

export function ProfileForm({ name, email, avatar, roleLabel }: { name: string; email: string; avatar: string | null; roleLabel: string }) {
  const [photo, setPhoto] = useState<string | null>(avatar);
  const [changed, setChanged] = useState(false);
  const [preview, setPreview] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <section className="flex flex-col rounded-md border border-line p-6">
        <h2 className="t-h2">Seus dados</h2>
        <p className="t-small mt-1">Aparecem no menu, nas conversas que você assume e na auditoria.</p>
        <ActionForm action={saveProfileAction} resetOnDone={false} className="mt-6 flex flex-1 flex-col gap-5">
          <div className="flex items-center gap-5">
            <Avatar name={preview || "?"} src={photo} size={72} />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}><Camera aria-hidden /> {photo ? "Trocar foto" : "Enviar foto"}</Button>
              {photo && <Button type="button" variant="ghost" size="sm" onClick={() => { setPhoto(null); setChanged(true); }}><Trash2 aria-hidden /> Remover</Button>}
            </div>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setError(null);
              try { setPhoto(await shrink(f)); setChanged(true); } catch { setError("Não foi possível ler essa imagem. Tente um JPG ou PNG."); }
            }} />
          </div>
          {error && <p className="t-small text-danger">{error}</p>}
          <input type="hidden" name="avatar" value={changed ? photo ?? "" : "keep"} />
          <Field label="Nome"><Input name="name" defaultValue={name} required onChange={(e) => setPreview(e.target.value)} /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="E-mail de acesso" hint="Para trocar o e-mail, fale com o administrador."><Input value={email} readOnly disabled /></Field>
            <Field label="Papel"><Input value={roleLabel} readOnly disabled /></Field>
          </div>
          <div className="mt-auto flex justify-end border-t border-line pt-5"><Button type="submit">Salvar perfil</Button></div>
        </ActionForm>
      </section>
      <section className="flex flex-col rounded-md border border-line p-6">
        <h2 className="t-h2">Senha</h2>
        <p className="t-small mt-1">Use pelo menos 8 caracteres. Não reaproveite senhas de outros sites.</p>
        <ActionForm action={changePasswordAction} className="mt-6 flex flex-1 flex-col gap-5">
          <Field label="Senha atual"><Input type="password" name="current" autoComplete="current-password" required /></Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Nova senha"><Input type="password" name="next" autoComplete="new-password" minLength={8} required /></Field>
            <Field label="Repita a nova senha"><Input type="password" name="confirm" autoComplete="new-password" minLength={8} required /></Field>
          </div>
          <div className="mt-auto flex justify-end border-t border-line pt-5"><Button type="submit">Trocar senha</Button></div>
        </ActionForm>
      </section>
    </div>
  );
}
