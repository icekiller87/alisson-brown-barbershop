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
    fetch(`${base}/rest/v1/barbershop_services?active=eq.true&select=id,name,description,duration_minutes,price,image_url&order=name`, { headers: headers(key) }),
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
async function audit(base:string,key:string,user:{id?:string,email?:string}|null,action:string,details:Record<string,unknown>={}) {
  await fetch(`${base}/rest/v1/barbershop_audit_logs`,{method:'POST',headers:headers(key),body:JSON.stringify({user_id:user?.id||null,user_email:user?.email||null,action,details})});
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
      const since=new Date(Date.now()-86400000).toISOString(), identity=booking.client_email||booking.client_phone, recentRes=await fetch(`${base}/rest/v1/barbershop_bookings?or=(client_email.eq.${encodeURIComponent(identity)},client_phone.eq.${encodeURIComponent(identity)})&created_at=gte.${encodeURIComponent(since)}&select=id`,{headers:headers(key)}); if(recentRes.ok&&(await recentRes.json()).length>=5)return json({error:'Limite diário atingido. Você pode fazer até 5 solicitações em 24 horas.'},429);
      const checkUrl = new URL(req.url); checkUrl.searchParams.set('action','public'); checkUrl.searchParams.set('date',booking.appointment_date); checkUrl.searchParams.set('barber_id',booking.barber_id);
      const data = await publicData(checkUrl, base, key);
      const service = data.services.find((x: { id:string }) => x.id === booking.service_id);
      const barber = data.barbers.find((x: { id:string }) => x.id === booking.barber_id);
      if (!service || !barber || !data.availableTimes?.includes(booking.appointment_time)) return json({ error: 'Esse horário não está mais disponível.' }, 409);
      (booking as Record<string,unknown>).manage_token=crypto.randomUUID(); (booking as Record<string,unknown>).status='pending';
      const insert = await fetch(`${base}/rest/v1/barbershop_bookings?select=*`, { method:'POST', headers:headers(key,{Prefer:'return=representation'}), body:JSON.stringify(booking) });
      const result = await insert.json();
      if (!insert.ok) return json({ error: result?.code === '23505' ? 'Este horário acabou de ser reservado. Escolha outro.' : 'Não foi possível concluir o agendamento.' }, result?.code === '23505' ? 409 : 500);
      const saved = result[0], resendKey = Deno.env.get('RESEND_API_KEY'), owner = Deno.env.get('BOOKING_OWNER_EMAIL'), from = Deno.env.get('BOOKING_EMAIL_FROM') || 'Alisson Brown <onboarding@resend.dev>', manageUrl=`https://alisson-brown-barbershop-test.netlify.app/?manage=${encodeURIComponent(saved.manage_token)}`;
      const dateText = new Date(`${saved.appointment_date}T12:00:00`).toLocaleDateString('pt-BR');
      const clientHtml = `<div style="font-family:Arial;max-width:560px;margin:auto"><h1>Agendamento recebido</h1><p>Olá, ${escapeHtml(saved.client_name)}.</p><p>Recebemos seu pedido para <strong>${escapeHtml(service.name)}</strong> com <strong>${escapeHtml(barber.name)}</strong> em <strong>${dateText}</strong> às <strong>${saved.appointment_time}</strong>.</p><p><a href="${manageUrl}" style="display:inline-block;padding:12px 18px;background:#b98a45;color:#fff;text-decoration:none;border-radius:6px">Confirmar, cancelar ou alterar agendamento</a></p><p>Protocolo: <strong>${saved.protocol}</strong></p></div>`;
      const ownerHtml = `<div style="font-family:Arial;max-width:560px;margin:auto"><h1>Novo agendamento</h1><p><strong>${escapeHtml(saved.client_name)}</strong> solicitou ${escapeHtml(service.name)} com ${escapeHtml(barber.name)}.</p><p><strong>Data:</strong> ${dateText} às ${saved.appointment_time}<br><strong>WhatsApp:</strong> ${escapeHtml(saved.client_phone)}<br><strong>E-mail:</strong> ${escapeHtml(saved.client_email || 'não informado')}<br><strong>Protocolo:</strong> ${saved.protocol}</p><p><a href="${manageUrl}">Abrir opções do agendamento</a></p>${saved.notes ? `<p><strong>Observações:</strong> ${escapeHtml(saved.notes)}</p>` : ''}</div>`;
      await Promise.all([
        saved.client_email ? email(resendKey,{from,to:[saved.client_email],reply_to:owner || undefined,subject:`Agendamento confirmado — ${saved.protocol}`,html:clientHtml,attachments:[{filename:`agendamento-${saved.protocol}.ics`,content:btoa(ics(saved,service.name,barber.name))}]}) : Promise.resolve(),
        owner ? email(resendKey,{from,to:[owner],subject:`Novo agendamento — ${saved.client_name} (${dateText} ${saved.appointment_time})`,html:ownerHtml}) : Promise.resolve(),
        barber.email ? email(resendKey,{from,to:[barber.email],subject:`Novo agendamento — ${dateText} às ${saved.appointment_time}`,html:ownerHtml}) : Promise.resolve(),
      ]);
      return json({ booking:saved },201);
    }

    if (requestUrl.searchParams.get('action') === 'manage') {
      const token=clean(requestUrl.searchParams.get('token'),80), found=await fetch(`${base}/rest/v1/barbershop_bookings?manage_token=eq.${encodeURIComponent(token)}&select=*`,{headers:headers(key)}), booking=(await found.json())[0]; if(!booking)return json({error:'Link inválido ou expirado.'},404);
      if(req.method==='GET'){const [s,b]=await Promise.all([fetch(`${base}/rest/v1/barbershop_services?id=eq.${encodeURIComponent(booking.service_id)}&select=*`,{headers:headers(key)}),fetch(`${base}/rest/v1/barbershop_barbers?id=eq.${encodeURIComponent(booking.barber_id)}&select=*`,{headers:headers(key)})]);return json({booking,service:(await s.json())[0],barber:(await b.json())[0]})}
      const input=await req.json(), op=clean(input.operation,20); if(op==='confirm'){await fetch(`${base}/rest/v1/barbershop_bookings?manage_token=eq.${encodeURIComponent(token)}`,{method:'PATCH',headers:headers(key),body:JSON.stringify({status:'confirmed'})});return json({ok:true,status:'confirmed'})} if(op==='cancel'){await fetch(`${base}/rest/v1/barbershop_bookings?manage_token=eq.${encodeURIComponent(token)}`,{method:'PATCH',headers:headers(key),body:JSON.stringify({status:'cancelled'})});return json({ok:true,status:'cancelled'})} if(op==='reschedule'){const date=clean(input.appointment_date,10),time=clean(input.appointment_time,5),serviceId=clean(input.service_id,50)||booking.service_id,barberId=clean(input.barber_id,50)||booking.barber_id;const checkUrl=new URL(req.url);checkUrl.searchParams.set('action','public');checkUrl.searchParams.set('date',date);checkUrl.searchParams.set('barber_id',barberId);const availability=await publicData(checkUrl,base,key);if(!availability.availableTimes?.includes(time))return json({error:'Esse horário não está disponível.'},409);await fetch(`${base}/rest/v1/barbershop_bookings?manage_token=eq.${encodeURIComponent(token)}`,{method:'PATCH',headers:headers(key),body:JSON.stringify({appointment_date:date,appointment_time:time,service_id:serviceId,barber_id:barberId,status:'pending'})});return json({ok:true,status:'pending'})} return json({error:'Operação inválida.'},400);
    }
    const admin = await isAdmin(req,base,key);
    if (!admin) return json({ error:'Acesso administrativo não autorizado.' },401);
    if (req.method === 'GET') {
      const [services,barbers,bookings,availability,logs,accounts] = await Promise.all([
        fetch(`${base}/rest/v1/barbershop_services?select=*&order=name`,{headers:headers(key)}), fetch(`${base}/rest/v1/barbershop_barbers?select=*&order=name`,{headers:headers(key)}),
        fetch(`${base}/rest/v1/barbershop_bookings?select=*&order=appointment_date,appointment_time`,{headers:headers(key)}), fetch(`${base}/rest/v1/barbershop_availability?select=*&order=appointment_date`,{headers:headers(key)}), fetch(`${base}/rest/v1/barbershop_audit_logs?select=*&order=created_at.desc&limit=200`,{headers:headers(key)}), fetch(`${base}/auth/v1/admin/users?per_page=100`,{headers:headers(key)}),
      ]);
      const accountData=accounts.ok?await accounts.json():{}; return json({services:await services.json(),barbers:await barbers.json(),bookings:await bookings.json(),availability:await availability.json(),logs:logs.ok?await logs.json():[],accounts:accountData.users||[],user:{email:admin.email}});
    }
    if (req.method !== 'PATCH') return json({error:'Método não permitido.'},405);
    const body=await req.json();
    if (body.action === 'service') {
      const s=body.service||{}, id=clean(s.id,50), payload={name:clean(s.name,100),description:clean(s.description,400),duration_minutes:Number(s.duration_minutes),price:Number(s.price),active:Boolean(s.active),image_url:clean(s.image_url,1000)||null};
      if(!id||!payload.name||!Number.isFinite(payload.duration_minutes)||!Number.isFinite(payload.price)) return json({error:'Dados do serviço inválidos.'},400);
      await fetch(`${base}/rest/v1/barbershop_services?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:headers(key),body:JSON.stringify(payload)}); await audit(base,key,admin,'service.updated',{id,name:payload.name}); return json({ok:true});
    }
    if (body.action === 'barber') {
      const b=body.barber||{}, id=clean(b.id,50), payload={name:clean(b.name,100),role:clean(b.role,100),email:clean(b.email,180)||null,photo_url:clean(b.photo_url,1000)||null,active:Boolean(b.active)};
      if(!id||!payload.name) return json({error:'Dados do barbeiro inválidos.'},400);
      await fetch(`${base}/rest/v1/barbershop_barbers?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:headers(key),body:JSON.stringify(payload)}); await audit(base,key,admin,'barber.updated',{id,name:payload.name}); return json({ok:true});
    }
    if (body.action === 'availability') {
      const a=body.availability||{}, barberId=clean(a.barber_id,50), date=clean(a.appointment_date,10), availableTimes=Array.isArray(a.available_times)?a.available_times.map((x:unknown)=>clean(x,5)).filter((x:string)=>/^([01]\d|2[0-3]):[0-5]\d$/.test(x)):[];
      if(!barberId||!/^\d{4}-\d{2}-\d{2}$/.test(date)) return json({error:'Data ou profissional inválido.'},400);
      const save=await fetch(`${base}/rest/v1/barbershop_availability?on_conflict=barber_id,appointment_date`,{method:'POST',headers:headers(key,{Prefer:'resolution=merge-duplicates'}),body:JSON.stringify({barber_id:barberId,appointment_date:date,available_times:availableTimes})});
      if(save.ok){await audit(base,key,admin,'availability.updated',{barber_id:barberId,appointment_date:date,available_times:availableTimes});return json({ok:true});} return json({error:'Não foi possível salvar os horários.'},500);
    }
    if (body.action === 'booking-status') {
      const id=clean(body.id,80), status=clean(body.status,20); if(!id||!['pending','confirmed','completed','cancelled','no_show'].includes(status)) return json({error:'Status inválido.'},400);
      const currentRes=await fetch(`${base}/rest/v1/barbershop_bookings?id=eq.${encodeURIComponent(id)}&select=*`,{headers:headers(key)}), current=(await currentRes.json())[0];
      await fetch(`${base}/rest/v1/barbershop_bookings?id=eq.${encodeURIComponent(id)}`,{method:'PATCH',headers:headers(key),body:JSON.stringify({status})});
      await audit(base,key,admin,'booking.status_changed',{id,status});
      if(status==='cancelled'&&current?.client_email){const dateText=new Date(`${current.appointment_date}T12:00:00`).toLocaleDateString('pt-BR');await email(Deno.env.get('RESEND_API_KEY'),{from:Deno.env.get('BOOKING_EMAIL_FROM')||'Alisson Brown <onboarding@resend.dev>',to:[current.client_email],subject:`Agendamento cancelado — ${current.protocol}`,html:`<p>Olá, ${escapeHtml(current.client_name)}.</p><p>Seu agendamento de ${dateText} às ${current.appointment_time} foi cancelado pela barbearia.</p><p>Entre em contato para escolher um novo horário.</p>`});}
      return json({ok:true});
    }
    if (body.action === 'photo') {
      const barberId=clean(body.barber_id,50), content=clean(body.content,3000000), mime=clean(body.mime,30);
      if(!barberId||!content||!['image/jpeg','image/png','image/webp'].includes(mime)) return json({error:'Imagem inválida.'},400);
      const bytes=Uint8Array.from(atob(content),x=>x.charCodeAt(0)); if(bytes.byteLength>2000000)return json({error:'A imagem deve ter até 2 MB.'},400);
      const ext=mime==='image/png'?'png':mime==='image/webp'?'webp':'jpg',path=`${barberId}-${Date.now()}.${ext}`;
      const upload=await fetch(`${base}/storage/v1/object/barbershop-photos/${path}`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':mime,'x-upsert':'true'},body:bytes});
      if(!upload.ok)return json({error:'Não foi possível enviar a imagem.'},500);
      const photo_url=`${base}/storage/v1/object/public/barbershop-photos/${path}`;
      await fetch(`${base}/rest/v1/barbershop_barbers?id=eq.${encodeURIComponent(barberId)}`,{method:'PATCH',headers:headers(key),body:JSON.stringify({photo_url})}); await audit(base,key,admin,'barber.photo_updated',{barber_id:barberId}); return json({ok:true,photo_url});
    }
    if (body.action === 'service-photo') {
      const serviceId=clean(body.service_id,50), content=clean(body.content,3000000), mime=clean(body.mime,30);
      if(!serviceId||!content||!['image/jpeg','image/png','image/webp'].includes(mime)) return json({error:'Imagem inválida.'},400);
      const bytes=Uint8Array.from(atob(content),x=>x.charCodeAt(0)); if(bytes.byteLength>2000000)return json({error:'A imagem deve ter até 2 MB.'},400);
      const ext=mime==='image/png'?'png':mime==='image/webp'?'webp':'jpg',path=`service-${serviceId}-${Date.now()}.${ext}`;
      const upload=await fetch(`${base}/storage/v1/object/barbershop-photos/${path}`,{method:'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':mime,'x-upsert':'true'},body:bytes});
      if(!upload.ok)return json({error:'Não foi possível enviar a imagem.'},500);
      const image_url=`${base}/storage/v1/object/public/barbershop-photos/${path}`;
      await fetch(`${base}/rest/v1/barbershop_services?id=eq.${encodeURIComponent(serviceId)}`,{method:'PATCH',headers:headers(key),body:JSON.stringify({image_url})}); await audit(base,key,admin,'service.photo_updated',{service_id:serviceId}); return json({ok:true,image_url});
    }
    if (body.action === 'create-service') { const payload={id:`service-${Date.now()}`,name:clean(body.name,100),description:clean(body.description,400),duration_minutes:Number(body.duration_minutes)||30,price:Number(body.price)||0,active:true}; if(!payload.name)return json({error:'Informe o nome do serviço.'},400); const res=await fetch(`${base}/rest/v1/barbershop_services`,{method:'POST',headers:headers(key),body:JSON.stringify(payload)}); if(!res.ok)return json({error:'Não foi possível criar o serviço.'},400); await audit(base,key,admin,'service.created',{name:payload.name}); return json({ok:true}); }
    if (body.action === 'create-admin') {
      const email=clean(body.email,180).toLowerCase(), password=clean(body.password,120); if(!email||password.length<6)return json({error:'Informe e-mail e senha com pelo menos 6 caracteres.'},400);
      const created=await fetch(`${base}/auth/v1/admin/users`,{method:'POST',headers:headers(key),body:JSON.stringify({email,password,email_confirm:true})}), user=await created.json(); if(!created.ok)return json({error:user?.msg||user?.message||'Não foi possível criar a conta.'},400);
      await fetch(`${base}/rest/v1/barbershop_admins`,{method:'POST',headers:headers(key),body:JSON.stringify({user_id:user.id})}); await audit(base,key,admin,'admin.created',{email}); return json({ok:true});
    }
    if (body.action === 'disable-admin') { const id=clean(body.user_id,80); if(!id)return json({error:'Conta inválida.'},400); const res=await fetch(`${base}/auth/v1/admin/users/${encodeURIComponent(id)}`,{method:'PUT',headers:headers(key),body:JSON.stringify({ban_duration:'876000h'})}); if(!res.ok)return json({error:'Não foi possível desabilitar a conta.'},400); await audit(base,key,admin,'admin.disabled',{user_id:id}); return json({ok:true}); }
    if (body.action === 'reset-admin') { const id=clean(body.user_id,80), password=clean(body.password,120); if(!id||password.length<6)return json({error:'Senha inválida.'},400); const res=await fetch(`${base}/auth/v1/admin/users/${encodeURIComponent(id)}`,{method:'PUT',headers:headers(key),body:JSON.stringify({password})}); if(!res.ok)return json({error:'Não foi possível alterar a senha.'},400); await audit(base,key,admin,'admin.password_changed',{user_id:id}); return json({ok:true}); }
    return json({error:'Ação desconhecida.'},400);
  } catch (error) { console.error('booking-api error',error instanceof Error?error.message:'unknown'); return json({error:'Solicitação inválida.'},400); }
});
