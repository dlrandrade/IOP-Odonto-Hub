-- CRM ligado à agenda: paciente agendado sem telefone (cadastrado direto na agenda) também tem oportunidade.
alter table opportunities alter column contact_id drop not null;
alter table opportunities add constraint opportunities_contact_or_patient check (contact_id is not null or patient_id is not null);
create index opportunities_patient on opportunities (patient_id) where patient_id is not null;

-- Correção retroativa: pacientes com consulta (não cancelada, dos últimos 30 dias em diante) de avaliação ou procedimento e sem oportunidade.
-- Avaliação → "Avaliação agendada" (ou "Avaliação realizada" se já concluída); procedimento → "Aceito" (o agendamento é a evidência).
with pending as (
  select distinct on (a.patient_id, s.id)
         a.clinic_id, a.patient_id, a.contact_id, s.id as service_id, s.name as service, s.kind, a.status, a.starts_at
  from appointments a
  join services s on s.id = a.service_id
  where a.status <> 'cancelled' and s.kind in ('evaluation', 'procedure') and a.starts_at > now() - interval '30 days'
    and not exists (
      select 1 from opportunities o
      where o.clinic_id = a.clinic_id
        and (o.patient_id = a.patient_id
             or o.contact_id in (select l.contact_id from contact_patient_links l where l.patient_id = a.patient_id))
    )
  order by a.patient_id, s.id, a.starts_at desc
), created as (
  insert into opportunities (clinic_id, contact_id, patient_id, service_id, service_interest, stage, source)
  select clinic_id, contact_id, patient_id, service_id, service,
         case when kind = 'evaluation' and status = 'completed' then 'evaluation_done'
              when kind = 'evaluation' then 'evaluation_scheduled'
              else 'accepted' end,
         'agenda'
  from pending
  returning id, clinic_id, stage
)
insert into opportunity_events (clinic_id, opportunity_id, from_stage, to_stage, actor, note)
select clinic_id, id, null, stage, 'system', 'Criada a partir de consulta já agendada'
from created;
