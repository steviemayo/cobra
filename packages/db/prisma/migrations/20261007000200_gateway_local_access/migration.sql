-- Signing in to a gateway's own page with a Kestrel account.
-- Gateway.localUrls: where people open the gateway's page (reported by the gateway); a sign-in is only
-- ever returned to one of these. Org.gatewayBreakGlass: whether the admin code on the machine still works.
-- Org.gatewayLocalEpoch: raised to end every sign-in made on the gateways' own pages.
ALTER TABLE "Gateway" ADD COLUMN "localUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "Org" ADD COLUMN "gatewayBreakGlass" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "gatewayLocalEpoch" INTEGER NOT NULL DEFAULT 0;
