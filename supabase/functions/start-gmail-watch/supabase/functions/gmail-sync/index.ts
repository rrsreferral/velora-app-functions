import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

function decodeBase64Url(base64Url: string) {
  if (!base64Url) return "";
  let base64 = base64Url.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  
  const pad = base64.length % 4;
  if (pad) {
    base64 += new Array(5 - pad).join('=');
  }
  
  try {
    const binaryString = atob(base64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch (e) {
    console.error("Base64 decoding failed:", e);
    return "(Unable to decode email content)";
  }
}

function findPart(parts: any[], mimeType: string): any {
  if (!parts) return null;
  for (const part of parts) {
    if (part.mimeType === mimeType) {
      return part;
    }
    if (part.parts) {
      const found = findPart(part.parts, mimeType);
      if (found) return found;
    }
  }
  return null;
}

function getMessageBody(payload: any, snippet?: string): string {
  if (!payload) return snippet || "";

  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return decodeBase64Url(payload.body.data);
  }
  
  const plainPart = findPart(payload.parts, 'text/plain');
  if (plainPart && plainPart.body?.data) {
    return decodeBase64Url(plainPart.body.data);
  }

  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = decodeBase64Url(payload.body.data);
    return html.replace(/<style([\s\S]*?)<\/style>/gi, '').replace(/<script([\s\S]*?)<\/script>/gi, '').replace(/<[^>]*>?/gm, ' ');
  }

  const htmlPart = findPart(payload.parts, 'text/html');
  if (htmlPart && htmlPart.body?.data) {
    const html = decodeBase64Url(htmlPart.body.data);
    return html.replace(/<style([\s\S]*?)<\/style>/gi, '').replace(/<script([\s\S]*?)<\/script>/gi, '').replace(/<[^>]*>?/gm, ' ');
  }

  return snippet || "(No readable text found in email)";
}

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const { accessToken } = await req.json();

    if (!accessToken) {
        return new Response(JSON.stringify({ error: "Missing Google Access Token." }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400,
        });
    }

    const listResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread label:INBOX&maxResults=1', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    
    if (!listResponse.ok) {
        const errText = await listResponse.text();
        let detailedError = `Google API Error (${listResponse.status}): ${listResponse.statusText}`;
        try {
            const errJson = JSON.parse(errText);
            if (errJson.error && errJson.error.message) {
                detailedError = `Google API Error: ${errJson.error.message}`;
            }
        } catch (e) {
            if (errText.length < 200) detailedError = `Google API Error: ${errText}`;
        }

        return new Response(JSON.stringify({ error: detailedError, raw: errText }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }, 
            status: listResponse.status, 
        });
    }
    
    const listData = await listResponse.json();
    
    if (!listData.messages || listData.messages.length === 0) {
        return new Response(JSON.stringify({ found: false, message: "No unread emails found." }), {
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
        });
    }

    const messageId = listData.messages[0].id;
    const msgResponse = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    if (!msgResponse.ok) {
        throw new Error(`Gmail Get API failed: ${await msgResponse.text()}`);
    }

    const msgData = await msgResponse.json();
    
    const headers = msgData.payload.headers;
    const subjectHeader = headers.find((h: any) => h.name === 'Subject');
    const fromHeader = headers.find((h: any) => h.name === 'From');
    
    const subject = subjectHeader ? subjectHeader.value : '(No Subject)';
    const from = fromHeader ? fromHeader.value : '(Unknown Sender)';
    
    const body = getMessageBody(msgData.payload, msgData.snippet);

    return new Response(JSON.stringify({ 
        found: true, 
        email: {
            id: messageId,
            subject,
            from,
            body
        }
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });

  } catch (error: any) {
    console.error('Error in Gmail Sync function:', error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500,
    });
  }
});
