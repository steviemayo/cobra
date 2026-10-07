# Gateway local access (2026-10-07, gateway 0.7.0)

Who can open a gateway's own page (`http://<gateway>:8080/`), and how they sign in. Customer feedback from corporate design partners: the page must fit enterprise security, not rely on a code in a file.

## What changed

- **People sign in with their Kestrel account.** The page's "Sign in with Kestrel" sends the browser to the portal; after the person confirms, the portal sends it back with a short-lived signed grant. No password or code is typed on the gateway
- **Roles.** Owners and developers of the gateway's organisation get `admin` (enrol, reset); support and customer viewers get `viewer` (look only). A service provider's people get the role their grant gives them, and only for sites the grant covers
- **Strangers see almost nothing.** Without a sign-in the page shows only "Connected" or "Not connected", the install ID of an unclaimed gateway (staff match it in the portal), and the sign-in buttons. Name, version, devices and the rest need a sign-in
- **The admin code on the machine stays**, as a break-glass way in. An owner can switch it off for the organisation (Settings > Gateway pages). A gateway that has not joined an organisation always accepts it, because there is nothing else to use
- **Everything is recorded.** The portal audit trail logs each grant (`gateway.local_signin`) and each owner setting change; the gateway sends `local.signin` and `local.action` events (who, how, from where) to the gateway's event log
- **Sign everyone out.** Owners can end every sign-in made so far (a policy `epoch`); each gateway applies it at its next check-in

## The flow

1. Person opens the gateway page and chooses Sign in. The gateway makes a random `state`, remembers it for 5 minutes, sets it in an HttpOnly cookie and redirects to `<cloud>/gateway-signin?gateway=<id>&state=<state>&return=<origin the person used>`
2. The portal requires a normal Kestrel sign-in (and two-step if they have it). It looks the gateway up and checks the person belongs to its organisation. It only accepts a `return` origin the **gateway itself reported** in its heartbeat (`localUrls`), so a crafted link cannot send a grant to another site
3. The person confirms on a page showing the gateway, organisation, their account and their access. Approving posts to `/gateway-signin/approve`, which checks everything again
4. The portal signs a grant (Ed25519, purpose `local_access_grant`, 120 seconds, one use) with the same key that signs releases and redirects the browser to `<return>/auth/callback?grant=...`
5. The gateway checks: signature against the keys **built into the gateway**, the purpose, its own gateway ID, expiry, that the grant's `state` matches the flow cookie from step 1 (so a copied link is useless to anyone else), that the grant has not been used before, and that the policy `epoch` has not moved on. It then opens a session (HttpOnly, SameSite=Lax cookie; 30 minutes idle, 8 hours at most) and redirects to `/`, removing the grant from the address bar

The gateway never needs to reach the cloud to check a grant, so signing in works while the gateway is offline from the cloud, as long as the person's browser can reach the portal.

## Security notes

- **Plain HTTP on the LAN.** Without TLS the session cookie crosses the network in clear text. The page shows "this connection is not encrypted" once signed in. Set `KESTREL_TLS_CERT_FILE` and `KESTREL_TLS_KEY_FILE` (PEM files, for example from the organisation's own CA) to serve HTTPS; cookies are then marked `Secure`. A bad certificate is logged and the gateway falls back to HTTP rather than going down
- **Not built yet:** a generated self-signed certificate per gateway, and a portal-pushed certificate. Until then HTTPS needs files supplied on the machine
- **Replay.** A sniffer on a plain-HTTP LAN who copies the callback address still cannot use it: the flow cookie it needs was never sent in that link, and a grant works once
- **Clock.** The grant lives 120 seconds and the gateway allows 2 minutes of clock difference. A badly wrong gateway clock refuses grants; the log says to check the clock
- **Brute force.** The admin code keeps its lock-out (5 wrong tries, a minute). Kestrel sign-in has no secret to guess on the gateway
- **Old clouds and old gateways.** The gateway sends `local-signin` as a feature and only gets a policy back from a cloud that knows it. An older gateway keeps the admin-code behaviour. **Deploy the web app first**: a new gateway sends events a cloud from before this change rejects as an unknown type

## Data changes

Migration `20261007000200_gateway_local_access` (not applied when written): `Gateway.localUrls`, `Org.gatewayBreakGlass`, `Org.gatewayLocalEpoch`. The shared dev database serves production and previews, so apply it before merging.

## Decisions

- GL-1: sign-in uses a portal-signed grant checked offline by the gateway, not per-user passwords or hashes held on the gateway (those would copy password material to every site)
- GL-2: the portal returns a person only to an address the gateway reported, and the gateway binds the grant to a cookie-held `state`, so neither a crafted link nor a copied one gives access
- GL-3: owners and developers are admins on the gateway; everyone else is view-only
- GL-4: the machine's admin code is kept as break-glass and is owner-switchable; an unenrolled gateway always accepts it
- GL-5: HTTPS through operator-supplied certificate files first; generated and portal-pushed certificates later
