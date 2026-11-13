-- Indicadores (PRD seção 10): sempre por SQL, nunca pela IA.
-- security_invoker = true → as views respeitam a RLS de quem consulta.

-- Coorte de contatos novos e conversão em avaliação agendada em até 30 dias.
create view v_contact_cohort with (security_invoker = true) as
select c.id as contact_id, c.clinic_id, c.created_at as first_seen_at, c.source,
       exists (
         select 1 from appointments a join services s on s.id = a.service_id
         where a.contact_id = c.id and s.kind = 'evaluation' and a.created_at <= c.created_at + interval '30 days'
       ) as converted,
       (c.created_at + interval '30 days' > now()) as cohort_partial
from contacts c
where not c.is_test and not c.excluded_from_metrics;

-- Fatos de consulta, já com horário local da clínica. Exclui contatos de teste.
create view v_appointment_facts with (security_invoker = true) as
select a.id as appointment_id, a.clinic_id, a.starts_at, a.ends_at, a.created_at, a.status, a.created_by_type, a.rescheduled_from_id,
       a.professional_id, p.name as professional, s.id as service_id, s.name as service, s.kind as service_kind, s.specialty,
       ct.source, (a.starts_at at time zone cl.timezone) as local_start,
       extract(epoch from (a.ends_at - a.starts_at)) / 60 as minutes
from appointments a
join clinics cl on cl.id = a.clinic_id
join professionals p on p.id = a.professional_id
join services s on s.id = a.service_id
left join contacts ct on ct.id = a.contact_id
where coalesce(ct.is_test, false) = false and coalesce(ct.excluded_from_metrics, false) = false;

-- Tempo de primeira resposta por conversa nova.
create view v_first_response with (security_invoker = true) as
select c.id as conversation_id, c.clinic_id, c.first_inbound_at, c.first_response_at, c.first_response_by,
       extract(epoch from (c.first_response_at - c.first_inbound_at)) as seconds,
       (c.first_inbound_at at time zone cl.timezone) as local_inbound
from conversations c
join clinics cl on cl.id = c.clinic_id
join contacts ct on ct.id = c.contact_id
where c.first_inbound_at is not null and not ct.is_test and not ct.excluded_from_metrics;

grant select on v_contact_cohort, v_appointment_facts, v_first_response to authenticated;
