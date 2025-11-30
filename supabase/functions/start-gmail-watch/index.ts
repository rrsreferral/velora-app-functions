// supabase/functions/start-gmail-watch/index.ts
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import * as jose from "https://deno.land/x/jose@v4.14.4/index.ts";

declare const Deno: any;

function formatPrivateKey(key: string): string {
  return key.replace(/\\n/g, '\n');
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const serviceAccountJson = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_JSON');
    if (!serviceAccountJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not set.');

    const serviceAccount = JSON.parse(serviceAccountJson);
    const privateKeyPem = serviceAccount.private_key;
    const clientEmail = serviceAccount.client_email;
    const projectId = serviceAccount.project_id;
    const pubsubTopic = Deno.env.get('GCP_PUBSUB_TOPIC_NAME');

    if (!privateKeyPem || !clientEmail || !projectId || !pubsubTopic) {
        throw new Error("Missing required environment variables from service account or pubsub topic.");
    }
    
    const alg = 'RS256';
    const privateKey = await jose.importPKCS8(formatPrivateKey(privateKeyPem), alg);

    const jwt = await new jose.SignJWT({ scope: 'https://www.googleapis.com/auth/gmail.modify' })
        .setProtectedHeader({ alg, typ: 'JWT' })
        .setIssuedAt()
        .setIssuer(clientEmail)
        .setAudience('https://oauth2.googleapis.com/token')
        .setExpirationTime('1h')
        .sign(privateKey);
    
    const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

    if (!tokenResponse.ok) {
      throw new Error(`Failed to get access token: ${await tokenResponse.text()}`);
    }
    const { access_token } = await tokenResponse.json();

    const watchResponse = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/watch', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${access_token}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            labelIds: ['INBOX'],
            topicName: `projects/${projectId}/topics/${pubsubTopic}`
        })
    });

    if (!watchResponse.ok) {
      throw new Error(`Gmail API watch request failed: ${await watchResponse.text()}`);
    }

    const watchData = await watchResponse.json();
    return new Response(JSON.stringify({ success: true, data: watchData }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200,
    });

  } catch (error) {
    console.error('Error in Gmail Watch function:', error.message);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500,
    });
  }
});
