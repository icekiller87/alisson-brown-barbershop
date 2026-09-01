const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
const clean = (value: unknown, max: number) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, x => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[x]!));
const defaultTimes = ['09:00','10:00','11:00','12:00','13:30','14:30','15:30','16:30','17:30','18:30'];
const headers = (key: string, extra: Record<string,string> = {}) => ({ apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...extra });

async function isAdmin(req: Request, url: string, key: string) {
  const authorization = req.headers.get('authorization') || '';
  if (!authorization.startsWith('Bearer ')) return null;
  const userRes = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: authorization } });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  const adminRes = await fetch(`${url}/rest/v1/barbershop_admins?user_id=eq.${encodeURIComponent(user.id)}&select=user_id`, { headers: headers(key) });
  return adminRes.ok && (await adminRes.json()).length ? user : null;
}

async function publicData(url: URL, base: string, key: string) {
  const [servicesRes, barbersRes] = await Promise.all([
    fetch(`${base}/rest/v1/barbershop_services?active=eq.true&select=id,name,description,duration_minutes,price&order=name`, { headers: headers(key) }),
    fetch(`${base}/rest/v1/barbershop_barbers?active=eq.true&select=id,name,role,photo_url,email&order=name`, { headers: headers(key) }),
  ]);
  const services = await servicesRes.json(), barbers = await barbersRes.json();
  const date = clean(url.searchParams.get('date'), 10), barberId = clean(url.searchParams.get('barber_id'), 50);
  let availableTimes: string[] | null = null;
  if (date && barberId) {
    const [availabilityRes, bookingsRes] = await Promise.all([
      fetch(`${base}/rest/v1/barbershop_availability?barber_id=eq.${encodeURIComponent(barberId)}&appointment_date=eq.${date}&select=available_times`, { headers: headers(key) }),
      fetch(`${base}/rest/v1/barbershop_bookings?barber_id=eq.${encodeURIComponent(barberId)}&appointment_date=eq.${date}&status=neq.cancelled&select=appointment_time`, { headers: headers(key) }),
    ]);
    const availability = availabilityRes.ok ? await availabilityRes.json() : [];
    const booked = bookingsRes.ok ? await bookingsRes.json() : [];
    const enabled = availability[0]?.available_times?.length ? availability[0].available_times : defaultTimes;
    const occupied = new Set(booked.map((x: { appointment_time: string }) => x.appointment_time.slice(0, 5)));
    availableTimes = enabled.filter((time: string) => !occupied.has(time));
  }
  return { services, barbers, availableTimes };
}

function ics(booking: Record<string,string>, service: string, barber: string) {
  const when = `${booking.appointment_date.replaceAll('-', '')}T${booking.appointment_time.replace(':', '')}00`;
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Alisson Brown//PT-BR\r\nBEGIN:VEVENT\r\nUID:${booking.id}@alissonbrown\r\nDTSTART:${when}\r\nSUMMARY:${service} - Alisson Brown\r\nDESCRIPTION:Profissional: ${barber}\\nProtocolo: ${booking.protocol}\r\nEND:VEVENT\r\nEND:VCALENDAR`;
}
async function email(key: string | undefined, body: Record<string,unknown>) {
  if (!key) return;
  const response = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) console.error('email failed', response.status);
}

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  const base = Deno.env.get('SUPABASE_URL')!, key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, requestUrl = new URL(req.url);
  try {
    if (req.method === 'GET' && requestUrl.searchParams.get('action') === 'public') return json(await publicData(requestUrl, base, key));

    if (req.method === 'POST' && requestUrl.searchParams.get('action') !== 'admin') {
      const input = await req.json();
      const booking = {
        service_id: clean(input.service_id,50), barber_id: clean(input.barber_id,50), appointment_date: clean(input.appointment_date,10), appointment_time: clean(input.appointment_time,5),
        client_name: clean(input.client_name,120), client_phone: clean(input.client_phone,30), client_email: clean(input.client_email,180) || null, notes: clean(input.notes,600) || null,
        protocol: `AB${Date.now().toString().slice(-7)}`, status: 'confirmed',
      };
      if (!booking.service_id || !booking.barber_id || !booking.appointment_date || !booking.appointment_time || !booking.client_name || !booking.client_phone) return json({ error: 'Preencha todos os campos obrigatórios.' }, 400);
      const checkUrl = new URL(req.url); checkUrl.searchParams.set('action','public'); checkUrl.searchParams.set('date',booking.appointment_date); checkUrl.searchParams.set('barber_id',booking.barber_id);
      const data = await publicData(checkUrl, base, key);
      const service = data.services.find((x: { id:string }) => x.id === booking.service_id);
      const barber = data.barbers.find((x: { id:string }) => x.id === booking.barber_id);
      if (!service || !barber || !data.availableTimes?.includes(booking.appointment_time)) return json({ error: 'Esse horário não está mais disponível.' }, 409);
      const insert = await fetch(`${base}/rest/v1/barbershop_bookings?select=*`, { method:'POST', headers:headers(key,{Prefer:'return=representation'}), body:JSON.stringify(booking) });
      const result = await insert.json();
      if (!insert.ok) return json({ error: result?.code === '23505' ? 'Este horário acabou de ser reservado. Escolha outro.' : 'Não foi possível concluir o agendamento.' }, result?.code === '23505' ? 409 : 500);
      const saved = result[0], resendKey = Deno.env.get('RESEND_API_KEY'), owner = Deno.env.get('BOOKING_OWNER_EMAIL'), from = Deno.env.get('BOOKING_EMAIL_FROM') || 'Alisson Brown <onboarding@resend.dev>';
      const dateText = new Date(`${saved.appointment_date}T12:00:00`).toLocaleDateString('pt-BR');
      const clientHtml = `<div style="font-family:Arial;max-width:560px;margin:auto"><h1>Agendamento confirmado</h1><p>Olá, ${escapeHtml(saved.client_name)}.</p><p>Seu horário para <strong>${escapeHtml(service.name)}</strong> com <strong>${escapeHtml(barber.name)}</strong> está confirmado para <strong>${dateText}</strong> às <strong>${saved.appointment_time}</strong>.</p><p>O convite para adicionar ao calendário está anexado a este e-mail.</p><p>Protocolo: <strong>${saved.protocol}</strong></p></div>`;
      const ownerHtml = `<div style="font-family:Arial;max-width:560px;margin:auto"><h1>Novo agendamento</h1><p><strong>${escapeHtml(saved.client_name)}</strong> agendou ${escapeHtml(service.name)} com ${escapeHtml(barber.name)}.</p><p><strong>Data:</strong> ${dateText} às ${saved.appointment_time}<br><strong>WhatsApp:</strong> ${escapeHtml(saved.client_phone)}<br><strong>E-mail:</strong> ${escapeHtml(saved.client_email || 'não informado')}<br><strong>Protocolo:</strong> ${saved.protocol}</p>${saved.notes ? `<p><strong>Observações:</strong> ${escapeHtml(saved.notes)}</p>` : ''}</div>`;
      await Promise.all([
        saved.client_email ? email(resendKey,{from,to:[saved.client_email],reply_to:owner || undefined,subject:`Agendamento confirmado — ${saved.protocol}`,html:clientHtml,attachments:[{filename:`agendamento-${saved.protocol}.ics`,content:btoa(ics(saved,service.name,barber.name))}]}) : Promise.resolve(),
        owner ? email(resendKey,{from,to:[owner],subject:`Novo agendamento — ${saved.client_name} (${dateText} ${saved.appointment_time})`,html:ownerHtml}) : Promise.resolve(),
        barber.email ? email(resendKey,{from,to:[barber.email],subject:`Novo agendamento — ${dateText} às ${saved.appointment_time}`,html:ownerHtml}) : Promise.resolve(),
      ]);
      return json({ booking:saved },201);
    }

    const admin = await isAdmin(req,base,key);
    if (!admin) return json({ error:'Acesso administrativo não autorizado.' },401);
    if (req.method === 'GET') {
      const [services,barbers,bookings,availability] = await Promise.all([
        fetch(`${base}/rest/v1/barbershop_services?select=*&order=name`,{headers:headers(key)}), fetch(`${base}/rest/v1/barbershop_barbers?select=*&order=name`,{headers:headers(key)}),
        fetch(`${base}/rest/v1/barbershop_bookings?select=*&order=appointment_date,appointment_time`,{headers:headers(key)}), fetch(`${base}/rest/v1/barbershop_availability?select=*&order=appointment_date`,{headers:headers(key)}),
      ]);
      return json({services:await services.json(),barbers:await barbers.json(),bookings:await bookings.json(),availability:await availability.json(),user:{email:admin.email}});
    }
    if (req.method !== 'PATCH') return json({error:'Método não permitido.'},405);
    const body=await req.json();
    if (body.action === 'service') {
      const s=body.service||{}, id=clean(s.id,50), payload={name:clean(s.name,100),description:clean(s.description,400),duration_minutes:Number(s.duration_minutes),price:Number(s.price),active:Boolean(s.active)};
      if(!id||!payload.name||!Number.isFinite(payload.duration_minutes)||!Number.isFinite(payload.price)) return json({error:'Dados do serviço inválidos.'},400);
      await fetch(`${base}/rest/v1/barbershop_services?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:headers(key),body:JSON.stringify(payload)}); return json({ok:true});
    }
    if (body.action === 'barber') {
      const b=body.barber||{}, id=clean(b.id,50), payload={name:clean(b.name,100),role:clean(b.role,100),email:clean(b.email,180)||null,photo_url:clean(b.photo_url,1000)||null,active:Boolean(b.active)};
      if(!id||!payload.name) return json({error:'Dados do barbeiro inválidos.'},400);
      await fetch(`${base}/rest/v1/barbershop_barbers?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:headers(key),body:JSON.stringify(payload)}); return json({ok:true});
    }
    if (body.action === 'availability') {
      const a=body.availability||{}, barberId=clean(a.barber_id,50), date=clean(a.appointment_date,10), availableTimes=Array.isArray(a.available_times)?a.available_times.map((x:unknown)=>clean(x,5)).filter((x:string)=>/^([01]\d|2[0-3]):[0-5]\d$/.test(x)):[];
      if(!barberId||!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({error:'Data ou profissional inválido.'},400);
      const save=await fetch(`${base}/rest/v1/barbershop_availability?on_conflict=barber_id,appointment_date`,{method:'POST',headers:headers(key,{Prefer:'resolution=merge-duplicates'}),body:JSON.stringify({barber_id:barberId,appointment_date:date,available_times:availableTimes})});
      return save.ok?json({ok:true}):json({error:'Não foi possível salvar os horários.'},500);
    }
    if (body.action === 'booking-status') {
      const id=clean(body.id,80), status=clean(body.status,20); if(!id||!['pending','confirmed','completed','cancelled','no_show'].includes(status)) return json({error:'Status inválido.'},400);
      await fetch(`${base}/rest/v1/barbershop_bookings?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:headers(key),body:JSON.stringify({status})}); return json({ok:true});
    }
    if (body.action === 'photo') {
      const barberId=clean(body.barber_id,50), content=clean(body.content,3000000), mime=clean(body.mime,30);
      if(!barberId||!content||!['image/jpeg','image/png','image/webp'].includes(mime)) return json({error:'Imagem inválida.'},400);
      const bytes=Uint8Array.from(atob(content),x=>x.charCodeAt(0)); if(bytes.byteLength>2000000)return json({error:'A imagem deve ter até 2 MB.'},400);
      const ext=mime==='image/png'?'png':mime==='image/webp'?'webp':'jpg',path=`${barberId}-${Date.now()}.${ext}`;
      const upload=await fetch(`${base}/storage/v1/object/barbershop-photos/${path}`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':mime,'x-upsert':'true'},body:bytes});
      if(!upload.ok)return json({error:'Não foi possível enviar a imagem.'},500);
      const photo_url=`${base}/storage/v1/object/public/barbershop-photos/${path}`;
      await fetch(`${base}/rest/v1/barbershop_barbers?id=eq.${encodeURIComponent(barberId)}`,{method:'PATCH',headers:headers(key),body:JSON.stringify({photo_url})}); return json({ok:true,photo_url});
    }
    return json({error:'Ação desconhecida.'},400);
  } catch (error) { console.error('booking-api error',error instanceof Error?error.message:'unknown'); return json({error:'Solicitação inválida.'},400); }
});
