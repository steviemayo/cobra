# White label for service providers

Status: built (name, logo and colour). Not built: custom domains, provider-branded sign-in and emails.

## What it is

A service provider sets how it presents itself. A customer's owner can then choose to show that brand in the customer's portal and, as a fallback, on the customer's room panels.

**The customer always pays Kestrel directly.** Nothing about billing changes: no wholesale, no provider invoices. This is only the look.

## Provider side

- **Where:** the provider's home page (`/o/<provider>/msp`), "Your brand". Owner edits, others see it.
- **Fields:** the name customers see (up to 60 characters), a logo address (`https://` only) and an accent colour (`#rgb` or `#rrggbb`).
- **Stored in:** `ProviderBrand` (one row per provider).
- A provider's own portal always wears its own brand.

## Customer side

- **Where:** Settings, Service providers. A checkbox on each active connection: "Show their name, logo and colour".
- **Only the owner** can turn it on. It is off by default, so nothing changes for a customer until they choose.
- **One provider at a time.** Turning one on turns the others off.
- **Needs an active connection** and a provider that has set its brand. Ending the connection ends the branding at once.
- **Stored in:** `MspGrant.useBrand`.
- Both changes go in the customer's audit log ("chose to show X's name, logo and colour").

## What changes

- **Portal:** the sidebar shows the provider's logo and name above the organisation switcher, with a small "Powered by Kestrel" line. The portal accent uses the customer's own accent if it set one, otherwise the provider's.
- **Room panels:** the customer's own logo and colour win. Where it set none, the provider's are used. This applies to what the portal's control page and the phone page show at once, and to panels on the next deploy of each room (a release bakes the look in, as it does for the organisation's own branding).
- People from the provider who work in the customer see the same brand, so the customer's portal looks the same to everyone.

## Not built

- **Custom domains** (for example `portal.provider.com`): needs hosting and certificate work.
- **Provider-branded sign-in page and emails** (alerts, tickets, reports still come from Kestrel).
- **Hiding "Powered by Kestrel".** It is one line in `apps/web/src/components/shell/app-sidebar.tsx` (`BrandMark`) if that is wanted.
- **Provider-set branding forced on customers.** Deliberately not built: the customer owner chooses.
- Provider billing (wholesale). Decided against: the customer always pays.

## Deploy

Migration `20260927140000_provider_brand` adds the `ProviderBrand` table and the `MspGrant.useBrand` column. Apply it before the web app that uses it.
