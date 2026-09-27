# Single sign-on (SSO)

People can sign in to Kestrel with their company's identity provider (Microsoft Entra ID, Okta, Google Workspace and others that speak SAML 2.0 or OpenID Connect) instead of a password.

## How it works

The login page has **Sign in with single sign-on**. The person types their work email; Kestrel takes the domain (`example.com`) and asks Supabase Auth to start sign-in for that domain. Supabase sends them to the company's sign-in page, and when they come back it lands on `/auth/callback`, which exchanges the code for a session, the same way email confirmation links do. They are then an ordinary Kestrel user: what they can see and do is set by their organisation membership and role, as for anyone else.

The sign-in itself is Supabase Auth's. Kestrel adds the button, the domain lookup and plain-language errors (`apps/web/src/lib/sso.ts`, `apps/web/src/components/auth/login-form.tsx`).

## What has to be set up (by the person running Kestrel, once per company)

1. **Supabase plan.** SAML single sign-on is a paid Supabase feature (Pro plan or above). Check the current terms in the Supabase dashboard under Authentication > Sign In / Providers > SSO.
2. **Register the company's identity provider** with the Supabase CLI, using the metadata URL or file the company's administrator gives you:

   ```
   supabase sso add --type saml --project-ref <ref> \
     --metadata-url 'https://login.example.com/app/xyz/sso/saml/metadata' \
     --domains example.com
   ```

   `--domains` is what the login page matches the email's domain against. A company with several email domains lists them all.
3. **Give the company's administrator what their side needs**: the values from `supabase sso show <provider-id>` (the ACS URL and entity ID), and ask them to send the `email` attribute (and `name` if they can). Attribute mapping can be adjusted with `supabase sso update --attribute-mapping-file ...`.
4. **Redirect URLs.** In Supabase, Authentication > URL Configuration, the site URL and redirect list must include the Kestrel address (`https://<your address>/auth/callback`). This is the same setting email confirmation links already need.
5. **Try it** with one real account before telling the company it is ready.

## Joining an organisation

Signing in with SSO proves who someone is; it does not put them in an organisation. Invite them from **Team** as usual (the invite link works after an SSO sign-in), or add them to an organisation by the usual routes.

## What this does not do yet

- **It does not stop password sign-in.** A company that wants everyone on SSO cannot yet switch passwords off for its members. That needs an organisation setting and a check at sign-in, and Supabase must be told to disable password sign-in for those users, which it does per project, not per company.
- **No automatic account creation or removal** (SCIM). Removing someone from the identity provider stops new sign-ins, but their Kestrel membership stays until an owner removes it from Team.
- **No role mapping** from identity provider groups.
- The button always shows, whether or not any company has been set up. A company without single sign-on gets a plain message saying so.

## Testing

`apps/web/src/lib/sso.test.ts` covers the domain lookup, the messages and the return address. The sign-in itself needs a real identity provider and a paid Supabase project, so it has not been run end to end.
