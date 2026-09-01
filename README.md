# Alisson Brown Barbershop

Site de agendamentos executável sem instalação de dependências.

## Executar localmente

```powershell
python -m http.server 4173
```

Acesse `http://localhost:4173`.

## Rotas

- `#/` — home, serviços e equipe
- `#/agendar` — fluxo completo de agendamento
- `#/agendar/sucesso` — confirmação da última reserva
- `#/admin` — painel administrativo local

Os agendamentos ficam no `localStorage` nesta primeira versão. O próximo passo para produção é ligar o site a um projeto Supabase separado e configurar autenticação/RLS.
