import { db } from "@/db/client";
import { parseSettings } from "@/domain/settings";
import { runDueJobs } from "./jobs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Executa os jobs logo após o debounce, na mesma invocação (after()), para a resposta da IA
 * não depender do intervalo do cron. O cron continua sendo a rede de segurança.
 */
export async function runAfterDebounce(clinicIds: string[]): Promise<void> {
  for (const clinicId of clinicIds) {
    try {
      const [clinic] = await db()<{ settings: unknown }[]>`select settings from clinics where id = ${clinicId}`;
      const wait = parseSettings(clinic?.settings).debounceSeconds * 1000 + 300;
      await runDueJobs({ clinicId }); // transcrição e mídia não esperam o debounce
      await sleep(wait);
      await runDueJobs({ clinicId });
    } catch {
      // o cron reprocessa
    }
  }
}
