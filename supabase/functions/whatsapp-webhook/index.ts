// Supabase Edge Function: whatsapp-webhook
//
// Recebe eventos do WhatsApp Business Platform (Meta):
//  - GET  → handshake de verificação (Meta chama isso quando você salva a URL no painel)
//  - POST → eventos reais: status de entrega (sent/delivered/read/failed) e respostas recebidas
//
// IMPORTANTE: essa função precisa ser publicada SEM exigir login do Supabase,
// porque quem chama é o servidor da Meta, não o seu app:
//   supabase functions deploy whatsapp-webhook --no-verify-jwt
//
// Secrets necessários (além dos já usados na função de envio):
//   supabase secrets set WHATSAPP_VERIFY_TOKEN=escolha_uma_palavra_secreta_qualquer
//   supabase secrets set SUPABASE_URL=...            (já vem preenchido automaticamente)
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...  (pegue em Project Settings > API)

// deno-lint-ignore-file no-explicit-any
import { createClient } from "npm:@supabase/supabase-js@2";

const VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);

  // ===== 1. Handshake de verificação (GET) =====
  // A Meta chama isso UMA VEZ quando você clica em "Verify and Save" no painel.
  // Não precisa do banco de dados aqui, então nem tentamos criar o client.
  if (req.method === "GET"){
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");

    if (mode === "subscribe" && token === VERIFY_TOKEN && challenge){
      return new Response(challenge, { status: 200 });
    }
    return new Response("Token de verificação inválido", { status: 403 });
  }

  // ===== 2. Eventos reais (POST) =====
  if (req.method === "POST"){
    try{
      if (!SUPABASE_URL || !SERVICE_ROLE_KEY){
        console.error("SUPABASE_URL ou SUPABASE_SERVICE_ROLE_KEY não disponíveis no ambiente da função.");
        return new Response("EVENT_RECEIVED", { status: 200 }); // responde 200 mesmo assim pra Meta não reenviar
      }
      const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
      const body = await req.json();
      const rows: any[] = [];

      const entries = body?.entry || [];
      for (const entry of entries){
        const changes = entry?.changes || [];
        for (const change of changes){
          const value = change?.value || {};

          // Status de entrega (sent / delivered / read / failed)
          const statuses = value.statuses || [];
          for (const s of statuses){
            rows.push({
              event_type: "status",
              wa_message_id: s.id || null,
              telefone: s.recipient_id || null,
              status: s.status || null,
              texto_recebido: null,
              payload: s,
            });
          }

          // Mensagens recebidas (respostas dos clientes)
          const messages = value.messages || [];
          for (const m of messages){
            rows.push({
              event_type: "message",
              wa_message_id: m.id || null,
              telefone: m.from || null,
              status: null,
              texto_recebido: m.text?.body || null,
              payload: m,
            });
          }
        }
      }

      if (rows.length > 0){
        const { error } = await supabase.from("whatsapp_events").insert(rows);
        if (error) console.error("Erro ao salvar eventos:", error);
      }

      // A Meta exige resposta 200 rápida, senão ela reenvia o mesmo evento depois.
      return new Response("EVENT_RECEIVED", { status: 200 });
    }catch(err: any){
      console.error("Erro ao processar webhook:", err);
      // Ainda assim responde 200 pra Meta não ficar reenviando um payload que não conseguimos ler.
      return new Response("EVENT_RECEIVED", { status: 200 });
    }
  }

  return new Response("Método não suportado", { status: 405 });
});