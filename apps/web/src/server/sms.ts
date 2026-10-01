// Sending text messages through Twilio's REST API (no SDK). Needs TWILIO_ACCOUNT_SID,
// TWILIO_AUTH_TOKEN and TWILIO_FROM (a number or sender ID) on the server; without them nothing is
// sent and the alert is recorded as "not set up", like email without Resend.
export interface SmsDeps {
  fetch: typeof fetch;
  env: Record<string, string | undefined>;
}

export function smsConfigured(env: Record<string, string | undefined> = process.env): boolean {
  return !!env.TWILIO_ACCOUNT_SID && !!env.TWILIO_AUTH_TOKEN && !!env.TWILIO_FROM;
}

/**
 * Sends one text to each number. Returns false (without trying) when the server has no SMS
 * settings. Every number is tried; if any fail, the error names how many.
 */
export async function sendSms(d: SmsDeps, to: string[], body: string): Promise<boolean> {
  const sid = d.env.TWILIO_ACCOUNT_SID;
  const token = d.env.TWILIO_AUTH_TOKEN;
  const from = d.env.TWILIO_FROM;
  if (!sid || !token || !from || to.length === 0) return false;
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const auth = Buffer.from(`${sid}:${token}`).toString('base64');
  let failed = 0;
  let lastStatus = 0;
  for (const number of to) {
    const res = await d.fetch(url, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        authorization: `Basic ${auth}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: number, From: from, Body: body }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      failed++;
      lastStatus = res.status;
    }
  }
  if (failed > 0)
    throw new Error(
      `The text message service answered HTTP ${lastStatus} for ${failed} of ${to.length} numbers`,
    );
  return true;
}
